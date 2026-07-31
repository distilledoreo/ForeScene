import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertManifestHashCompatible,
  applyManifestUpdateToRunState,
  compileProduction,
  createBlankGrayboxProject,
  createInitialRunState,
  firstIncompletePhase,
  hashPrevisManifest,
  parsePrevisProductionManifest,
  solveBlockingBatch,
  solveShotCamera,
  subjectBoundsFromPlacement,
  upsertShotState,
  validateManifestShotNumbers,
} from '../src/engine/previs';
import { previewAgentPlan } from '../src/engine/agent/planCompiler';
import { createDefaultProject } from '../src/domain/defaults';

function loadExample(name: string) {
  const raw = readFileSync(path.resolve('examples/previs', name), 'utf8');
  return JSON.parse(raw) as unknown;
}

describe('previs production manifest', () => {
  it('parses the minimal dialogue fixture', () => {
    const result = parsePrevisProductionManifest(loadExample('minimal-dialogue.json'));
    expect(result.errors).toEqual([]);
    expect(result.manifest?.shots).toHaveLength(4);
    expect(result.manifest?.shots.map((shot) => shot.shotNumber)).toEqual([
      '010', '020', '030', '040',
    ]);
  });

  it('parses the music-video fixture with two locations', () => {
    const result = parsePrevisProductionManifest(loadExample('music-video-graybox.json'));
    expect(result.errors).toEqual([]);
    expect(result.manifest?.locations).toHaveLength(2);
    expect(result.manifest?.shots).toHaveLength(8);
  });

  it('rejects duplicate shot numbers and unknown refs', () => {
    const result = parsePrevisProductionManifest({
      version: 1,
      project: { name: 'Bad', aspectRatio: '16:9' },
      locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
      cast: [{ id: 'a', name: 'A', type: 'human_dummy' }],
      shots: [
        {
          id: 's1',
          shotNumber: '010',
          name: 'One',
          description: 'dup',
          locationId: 'missing',
          subjects: ['a'],
          camera: { template: 'medium', subjects: ['a'] },
        },
        {
          id: 's2',
          shotNumber: '010',
          name: 'Two',
          description: 'dup',
          locationId: 'room',
          subjects: ['ghost'],
          camera: { template: 'not_a_template', subjects: ['a'] },
        },
      ],
    });
    expect(result.errors.some((item) => item.code === 'duplicate_shot_number')).toBe(true);
    expect(result.errors.some((item) => item.code === 'unknown_reference')).toBe(true);
    expect(result.errors.some((item) => item.code === 'unsupported_value')).toBe(true);
  });

  it('rejects custom_blueprint in MVP', () => {
    const result = parsePrevisProductionManifest({
      version: 1,
      project: { name: 'Custom', aspectRatio: '16:9' },
      locations: [{ id: 'x', name: 'X', template: 'custom_blueprint' }],
      cast: [{ id: 'a', name: 'A', type: 'human_dummy' }],
      shots: [{
        id: 's1',
        shotNumber: '010',
        name: 'One',
        description: 'x',
        locationId: 'x',
        subjects: ['a'],
        camera: { template: 'wide', subjects: ['a'] },
      }],
    });
    expect(result.errors.some((item) => item.code === 'custom_blueprint_unsupported')).toBe(true);
  });
});

describe('previs compilers', () => {
  it('compiles two locations into separate zones with anchors', () => {
    const parsed = parsePrevisProductionManifest(loadExample('music-video-graybox.json'));
    expect(parsed.manifest).toBeTruthy();
    const compiled = compileProduction(parsed.manifest!);
    expect(compiled.ok).toBe(true);
    expect(Object.keys(compiled.context.locationOrigins)).toHaveLength(2);
    expect(compiled.context.locationOrigins.ruins).toEqual([0, 0, 0]);
    expect(compiled.context.locationOrigins.armory).toEqual([100, 0, 0]);
    expect(compiled.context.locationAnchors.ruins?.center).toBeTruthy();
    expect(compiled.context.locationAnchors.armory?.main_door || compiled.context.locationAnchors.armory?.entrance).toBeTruthy();
    expect(compiled.locations.plan.commands.some((command) => command.op === 'object.create')).toBe(true);
    expect(compiled.locations.plan.commands.some((command) => command.op === 'landmark.create')).toBe(true);
  });

  it('creates cast once and batches shots without model coordinates', () => {
    const parsed = parsePrevisProductionManifest(loadExample('minimal-dialogue.json'));
    const compiled = compileProduction(parsed.manifest!);
    expect(compiled.cast.plan.commands.filter((command) => command.op === 'object.create')).toHaveLength(2);
    expect(compiled.shotBatches.length).toBeGreaterThan(0);
    const allShotCommands = compiled.shotBatches.flatMap((batch) => batch.plan.commands);
    const created = allShotCommands.filter((command) => command.op === 'shot.create');
    expect(created).toHaveLength(4);
    expect(created.map((command) => {
      if (command.op !== 'shot.create') return '';
      return command.shot.shotNumber;
    })).toEqual(['010', '020', '030', '040']);
    for (const command of created) {
      if (command.op !== 'shot.create') continue;
      expect(command.shot.camera?.position?.every((value) => Number.isFinite(value))).toBe(true);
      expect(command.shot.camera?.target?.every((value) => Number.isFinite(value))).toBe(true);
      expect(Number.isFinite(command.shot.camera?.fovDegrees)).toBe(true);
    }
  });

  it('previews a location plan against a blank project without mutating it', () => {
    const parsed = parsePrevisProductionManifest(loadExample('minimal-dialogue.json'));
    const compiled = compileProduction(parsed.manifest!);
    const blank = createBlankGrayboxProject({ name: 'Test', aspectRatio: '16:9' });
    const before = structuredClone(blank);
    const preview = previewAgentPlan(compiled.locations.plan, {
      project: blank,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: blank.shots[0]?.id,
      gridSnap: true,
    });
    expect(preview.ok).toBe(true);
    expect(blank).toEqual(before);
    expect((preview.summary?.affectedObjectIds.length ?? 0) > 0).toBe(true);
  });

  it('skips already-compiled shots on resume', () => {
    const parsed = parsePrevisProductionManifest(loadExample('minimal-dialogue.json'));
    const compiled = compileProduction(parsed.manifest!, {
      skipShotNumbers: new Set(['010', '020']),
    });
    const numbers = compiled.shotBatches.flatMap((batch) => batch.shotNumbers);
    expect(numbers).toEqual(['030', '040']);
  });

  it('upserts existing shots instead of creating duplicates', () => {
    const parsed = parsePrevisProductionManifest(loadExample('minimal-dialogue.json'));
    const compiled = compileProduction(parsed.manifest!, {
      skipShotNumbers: new Set(['010', '020', '040']),
      existingShotIds: { '030': 'shot_existing030abc' },
    });
    const commands = compiled.shotBatches.flatMap((batch) => batch.plan.commands);
    expect(commands.some((command) => command.op === 'shot.create')).toBe(false);
    expect(commands.some((command) => (
      command.op === 'shot.updateCamera'
      && 'id' in command.shot
      && command.shot.id === 'shot_existing030abc'
    ))).toBe(true);
    expect(commands.some((command) => (
      command.op === 'shot.clearStaging'
      && 'id' in command.shot
      && command.shot.id === 'shot_existing030abc'
    ))).toBe(true);
    expect(commands.filter((command) => command.op === 'shot.stageObject').length).toBeGreaterThan(0);
  });

  it('stages props using defaultPropDimensions height', () => {
    const parsed = parsePrevisProductionManifest(loadExample('music-video-graybox.json'));
    const compiled = compileProduction(parsed.manifest!);
    const insertBatch = compiled.shotBatches.find((batch) => batch.shotNumbers.includes('070'));
    expect(insertBatch).toBeTruthy();
    const stage = insertBatch!.plan.commands.find((command) => {
      if (command.op !== 'shot.stageObject') return false;
      return command.visible === true && command.transform?.position?.[1] === 0.5;
    });
    expect(stage).toBeTruthy();
  });
});

describe('blocking and camera solvers', () => {
  it('places relative and faces another subject', () => {
    const results = solveBlockingBatch([
      {
        subject: 'joseph',
        placement: { type: 'location_slot', slot: 'center' },
        pose: 'standing-alert',
      },
      {
        subject: 'soldier',
        placement: { type: 'relative', anchor: 'joseph', relation: 'across_from' },
        face: 'joseph',
        pose: 'shield-ready',
      },
    ], {
      anchors: { center: [0, 0, 0], entrance: [0, 0, 4] },
      subjects: {},
    });
    expect(results.joseph?.position[1]).toBe(0);
    expect(results.soldier?.position[2]).toBeGreaterThan(results.joseph!.position[2]);
    expect(results.soldier?.posePreset).toBeTruthy();
    expect(Number.isFinite(results.soldier?.rotation[1])).toBe(true);
  });

  it('resolves mutual facing regardless of blocking order', () => {
    const results = solveBlockingBatch([
      {
        subject: 'joseph',
        placement: { type: 'location_slot', slot: 'left' },
        face: 'soldier',
      },
      {
        subject: 'soldier',
        placement: { type: 'location_slot', slot: 'right' },
        face: 'joseph',
      },
    ], {
      anchors: {
        left: [-2, 0, 0],
        right: [2, 0, 0],
        center: [0, 0, 0],
      },
      subjects: {},
    });
    expect(results.joseph?.warnings.some((warning) => warning.includes('face target'))).toBe(false);
    expect(results.soldier?.warnings.some((warning) => warning.includes('face target'))).toBe(false);
    // They should face roughly toward each other (yaw near ±90°).
    expect(Math.abs(results.joseph!.rotation[1])).toBeGreaterThan(45);
    expect(Math.abs(results.soldier!.rotation[1])).toBeGreaterThan(45);
  });

  it('frames props using prop dimensions instead of human height', () => {
    const parsed = parsePrevisProductionManifest(loadExample('music-video-graybox.json'));
    const compiled = compileProduction(parsed.manifest!);
    const insertBatch = compiled.shotBatches.find((batch) => batch.shotNumbers.includes('070'));
    expect(insertBatch).toBeTruthy();
    const camera = insertBatch!.shotResults['070']?.camera;
    expect(camera).toBeTruthy();
    // Shield is ~1m tall; a human-height framing would place the camera much farther.
    const distance = Math.hypot(
      camera!.position[0] - camera!.target[0],
      camera!.position[1] - camera!.target[1],
      camera!.position[2] - camera!.target[2],
    );
    expect(distance).toBeLessThan(4.5);
  });

  it('solves a finite two-shot camera', () => {
    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [-1, 0, 0] });
    const blair = subjectBoundsFromPlacement({ id: 'blair', position: [1, 0, 0] });
    const solved = solveShotCamera({
      shot: {
        id: 's',
        shotNumber: '010',
        name: 'Two',
        description: 'x',
        locationId: 'room',
        subjects: ['alex', 'blair'],
        camera: {
          template: 'two_shot',
          subjects: ['alex', 'blair'],
          angle: 'front',
          lensClass: 'wide',
        },
      },
      subjects: [alex, blair],
      aspectRatio: 16 / 9,
    });
    expect(solved.camera.position.every(Number.isFinite)).toBe(true);
    expect(solved.camera.target.every(Number.isFinite)).toBe(true);
    expect(solved.camera.fovDegrees).toBeGreaterThan(10);
    expect(solved.measuredCoverage).toBeGreaterThan(0);
  });

  it('solves OTS with foreground subject', () => {
    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [0, 0, 0] });
    const blair = subjectBoundsFromPlacement({ id: 'blair', position: [0, 0, 1.2] });
    const solved = solveShotCamera({
      shot: {
        id: 's',
        shotNumber: '030',
        name: 'OTS',
        description: 'x',
        locationId: 'room',
        subjects: ['alex', 'blair'],
        camera: {
          template: 'over_the_shoulder',
          subjects: ['alex'],
          foregroundSubject: 'blair',
          angle: 'three_quarter',
        },
      },
      subjects: [alex, blair],
      aspectRatio: 16 / 9,
    });
    expect(solved.camera.position.every(Number.isFinite)).toBe(true);
    expect(solved.score).toBeGreaterThan(-100);
  });
});

describe('run-state resume', () => {
  it('tracks phases and refuses hash mismatch', () => {
    const manifest = parsePrevisProductionManifest(loadExample('minimal-dialogue.json')).manifest!;
    const hash = hashPrevisManifest(manifest);
    let state = createInitialRunState({
      manifestHash: hash,
      shotNumbers: manifest.shots.map((shot) => shot.shotNumber),
    });
    expect(firstIncompletePhase(state)).toBe('initialized');
    state = upsertShotState(state, '010', { compile: 'complete', render: 'complete', validation: 'passed' });
    expect(state.shots['010']?.compile).toBe('complete');
    const mismatch = assertManifestHashCompatible(state, 'deadbeef');
    expect(mismatch.ok).toBe(false);
  });

  it('update-manifest invalidates only changed shots', () => {
    const previous = parsePrevisProductionManifest(loadExample('minimal-dialogue.json')).manifest!;
    let state = createInitialRunState({
      manifestHash: hashPrevisManifest(previous),
      shotNumbers: previous.shots.map((shot) => shot.shotNumber),
    });
    for (const shot of previous.shots) {
      state = upsertShotState(state, shot.shotNumber, {
        compile: 'complete',
        render: 'complete',
        validation: 'passed',
        framePath: `shots/${shot.shotNumber}.png`,
      });
    }
    state = {
      ...state,
      phases: {
        ...state.phases,
        initialized: 'complete',
        locations: 'complete',
        cast: 'complete',
        props: 'complete',
        shots: 'complete',
        render: 'complete',
        validation: 'complete',
        contactSheet: 'complete',
        package: 'complete',
      },
    };

    const next = structuredClone(previous);
    const edited = next.shots.find((shot) => shot.shotNumber === '030')!;
    edited.description = 'Revised OTS description';
    edited.camera.angle = 'profile';

    const updated = applyManifestUpdateToRunState({
      state,
      previousManifest: previous,
      nextManifest: next,
      nextManifestHash: hashPrevisManifest(next),
    });

    expect(updated.diff.shotsToInvalidate).toEqual(['030']);
    expect(updated.state.shots['010']?.compile).toBe('complete');
    expect(updated.state.shots['020']?.compile).toBe('complete');
    expect(updated.state.shots['030']?.compile).toBe('pending');
    expect(updated.state.shots['030']?.render).toBe('pending');
    expect(updated.state.shots['040']?.compile).toBe('complete');
    expect(updated.state.phases.contactSheet).toBe('pending');
    expect(updated.state.phases.package).toBe('pending');
    expect(updated.state.phases.locations).toBe('complete');
  });

  it('update-manifest removes deleted shots from run-state', () => {
    const previous = parsePrevisProductionManifest(loadExample('minimal-dialogue.json')).manifest!;
    let state = createInitialRunState({
      manifestHash: hashPrevisManifest(previous),
      shotNumbers: previous.shots.map((shot) => shot.shotNumber),
    });
    for (const shot of previous.shots) {
      state = upsertShotState(state, shot.shotNumber, {
        compile: 'complete',
        render: 'complete',
        validation: 'passed',
        shotId: `shot_id_${shot.shotNumber}`,
        framePath: `shots/${shot.shotNumber}.png`,
      });
    }

    const next = structuredClone(previous);
    next.shots = next.shots.filter((shot) => shot.shotNumber !== '040');

    const updated = applyManifestUpdateToRunState({
      state,
      previousManifest: previous,
      nextManifest: next,
      nextManifestHash: hashPrevisManifest(next),
    });

    expect(updated.diff.shotsRemoved).toEqual(['040']);
    expect(updated.state.shots['040']).toBeUndefined();
    expect(updated.removedShots).toEqual([
      { shotNumber: '040', shotId: 'shot_id_040', framePath: 'shots/040.png' },
    ]);
    expect(updated.state.shots['010']?.compile).toBe('complete');
    expect(updated.state.phases.shots).toBe('pending');
  });

  it('validateManifestShotNumbers catches duplicates', () => {
    const errors = validateManifestShotNumbers({
      version: 1,
      project: { name: 'x', aspectRatio: '16:9' },
      locations: [],
      cast: [],
      shots: [
        {
          id: 'a',
          shotNumber: '1',
          name: 'A',
          description: '',
          locationId: 'r',
          subjects: [],
          camera: { template: 'wide', subjects: [] },
        },
        {
          id: 'b',
          shotNumber: '1',
          name: 'B',
          description: '',
          locationId: 'r',
          subjects: [],
          camera: { template: 'wide', subjects: [] },
        },
      ],
    });
    expect(errors[0]?.code).toBe('duplicate_shot_number');
  });
});

describe('blank graybox project', () => {
  it('creates a clean shell without the default temple set', () => {
    const blank = createBlankGrayboxProject({ name: 'Previs', aspectRatio: '16:9' });
    expect(blank.name).toBe('Previs');
    expect(blank.scene.objects.some((object) => object.name.includes('Temple'))).toBe(false);
    expect(blank.scene.objects.some((object) => object.type === 'floor')).toBe(true);
    const starter = createDefaultProject();
    expect(starter.scene.objects.length).toBeGreaterThan(blank.scene.objects.length);
  });
});
