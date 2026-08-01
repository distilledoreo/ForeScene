import { describe, expect, it } from 'vitest';
import { createDefaultProject, createShot, createCameraData } from '../src/domain/defaults';
import {
  isEffectivelyBlankProject,
  isPlaceholderShot,
} from '../src/domain/blankProject';
import { createBlankGrayboxProject } from '../src/engine/previs/blankProject';
import {
  createDialogueDemoSample,
  DIALOGUE_DEMO_SAMPLE_ID,
  getSampleProjectId,
  isDialogueDemoSample,
  loadSampleProject,
  resetSampleProject,
  SAMPLE_PROJECTS,
} from '../src/engine/sampleProjects';
import { createExportPlan } from '../src/engine/exportPlan';
import { pruneUnreferencedProjectAssets } from '../src/engine/projectAssets';
import {
  getExportSelectionWarnings,
  getProjectWarnings,
} from '../src/engine/warnings';
import { DIALOGUE_DEMO_ASSETS } from '../src/samples/dialogueDemoAssets';
import { resolveShotThumbnail } from '../src/domain/shotThumbnails';

describe('isEffectivelyBlankProject (scaffold tags)', () => {
  it('treats a blank graybox shell as blank', () => {
    const project = createBlankGrayboxProject({ name: 'Untitled Production' });
    expect(isEffectivelyBlankProject(project)).toBe(true);
    expect(project.scene.objects.every((object) => object.metadata?.systemScaffold === true)).toBe(true);
    expect(project.shots.every((shot) => shot.metadata?.systemScaffold === true)).toBe(true);
  });

  it('treats the default temple starter as non-blank', () => {
    const project = createDefaultProject();
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('treats the dialogue sample as non-blank', () => {
    const project = createDialogueDemoSample();
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('does not treat an untagged real shot 001 as a placeholder', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    const camera = createCameraData([0, 1.65, 4], [0, 1.2, 0], 40);
    const realShot = createShot({ index: 1, camera });
    realShot.shotNumber = '001';
    realShot.name = 'Camera 001';
    realShot.description = '';
    // No systemScaffold tag — this is user content even with origin-like naming.
    project.shots = [realShot];
    expect(isPlaceholderShot(realShot)).toBe(false);
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('becomes non-blank when a scaffold floor is substantially edited', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    const floor = project.scene.objects.find((object) => object.type === 'floor')!;
    expect(floor.metadata?.systemScaffold).toBe(true);
    floor.dimensions = [40, 0.08, 40];
    floor.name = 'Custom Stage Floor';
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('becomes non-blank when the origin camera is moved', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    const origin = project.shots[0]!;
    origin.camera = {
      ...origin.camera,
      position: [2, 1.65, 8],
    };
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('becomes non-blank when a character is added', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    const character = {
      ...project.scene.objects[0]!,
      id: 'obj_person',
      type: 'human_dummy' as const,
      name: 'Hero',
      stagingRole: 'person' as const,
      dimensions: [0.55, 1.75, 0.55] as [number, number, number],
      metadata: undefined,
    };
    project.scene.objects.push(character);
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('becomes non-blank when a pano reference is present', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    project.panoRefs.push({
      id: 'pano_1',
      name: 'Graybox',
      imageAssetId: 'asset_missing',
      type: 'graybox_render',
      projection: 'equirectangular',
      origin: [0, 1.65, 0],
      rotation: [0, 0, 0],
      width: 4,
      height: 2,
      isCanonical: true,
      createdAt: new Date().toISOString(),
    });
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });
});

describe('sample project load and reset', () => {
  it('registers the dialogue demo sample with outcome-oriented copy', () => {
    const sample = SAMPLE_PROJECTS.find((entry) => entry.id === DIALOGUE_DEMO_SAMPLE_ID);
    expect(sample).toBeTruthy();
    expect(sample!.title.length).toBeGreaterThan(0);
    expect(sample!.outcome.length).toBeGreaterThan(20);
  });

  it('loads a self-contained dialogue production with distinct visual assets', () => {
    const project = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);

    expect(project.name).toBe('Dialogue Demo');
    expect(isDialogueDemoSample(project)).toBe(true);
    expect(getSampleProjectId(project)).toBe(DIALOGUE_DEMO_SAMPLE_ID);
    expect(isEffectivelyBlankProject(project)).toBe(false);

    const shotNumbers = project.shots.map((shot) => shot.shotNumber);
    const shotNames = project.shots.map((shot) => shot.name);
    expect(shotNumbers).toEqual(['010', '020', '030', '040']);
    expect(shotNames).toEqual([
      'Wide two-shot',
      'Alex medium',
      'Blair OTS',
      'Alex close-up',
    ]);

    const people = project.scene.objects.filter((object) => object.stagingRole === 'person');
    expect(people.map((object) => object.name).sort()).toEqual(['Alex', 'Blair']);

    const props = project.scene.objects.filter((object) => object.stagingRole === 'prop');
    expect(props.some((object) => /table/i.test(object.name))).toBe(true);

    const graybox = project.panoRefs.find((pano) => pano.type === 'graybox_render');
    const styled = project.panoRefs.find((pano) => pano.type === 'ai_global_reference');
    expect(graybox).toBeTruthy();
    expect(styled).toBeTruthy();

    const grayboxAsset = project.assets.assets[graybox!.imageAssetId]!;
    const styledAsset = project.assets.assets[styled!.imageAssetId]!;
    expect(grayboxAsset.width).toBeGreaterThanOrEqual(1024);
    expect(grayboxAsset.height).toBeGreaterThanOrEqual(512);
    expect(styledAsset.width).toBeGreaterThanOrEqual(1024);
    expect(styledAsset.height).toBeGreaterThanOrEqual(512);
    expect(grayboxAsset.uri).not.toBe(styledAsset.uri);
    expect(grayboxAsset.uri).not.toBe(DIALOGUE_DEMO_ASSETS.styledPano.dataUri);
    expect(styledAsset.uri).toBe(DIALOGUE_DEMO_ASSETS.styledPano.dataUri);

    const contact = Object.values(project.assets.assets).find(
      (asset) => asset.metadata?.role === 'contact-sheet',
    );
    expect(contact).toBeTruthy();
    expect(contact!.width).toBeGreaterThanOrEqual(1280);
    expect(contact!.height).toBeGreaterThanOrEqual(720);

    // Four distinct shot thumbnails via viewport renders.
    const thumbUris = new Set<string>();
    for (const shot of project.shots) {
      const thumb = resolveShotThumbnail(project, shot);
      expect(thumb.asset).toBeTruthy();
      expect(thumb.asset!.width).toBeGreaterThanOrEqual(640);
      expect(thumb.asset!.height).toBeGreaterThanOrEqual(360);
      thumbUris.add(thumb.asset!.uri);
      expect(Object.keys(shot.objectOverrides ?? {}).length).toBeGreaterThan(0);
      expect(shot.linkedPanoId).toBe(styled!.id);
    }
    expect(thumbUris.size).toBe(4);

    // Not the old 4×2 stand-in for everything.
    const standIn = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0';
    for (const asset of [grayboxAsset, styledAsset, contact!]) {
      expect(asset.uri.startsWith(standIn)).toBe(false);
    }
  });

  it('identifies the sample by marker after rename and shot edits', () => {
    const project = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    project.name = 'My Renamed Experiment';
    project.shots.pop();
    expect(isDialogueDemoSample(project)).toBe(true);
    expect(getSampleProjectId(project)).toBe(DIALOGUE_DEMO_SAMPLE_ID);
  });

  it('deep-clones staging so editing shot 010 does not change shot 020', () => {
    const project = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    const shot010 = project.shots.find((shot) => shot.shotNumber === '010')!;
    const shot020 = project.shots.find((shot) => shot.shotNumber === '020')!;
    expect(shot010.objectOverrides).not.toBe(shot020.objectOverrides);

    const alexId = project.scene.objects.find((object) => object.name === 'Alex')!.id;
    const before020 = structuredClone(shot020.objectOverrides);
    shot010.objectOverrides![alexId] = {
      ...shot010.objectOverrides![alexId],
      transform: {
        position: [9, 9, 9],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: false,
    };
    expect(shot020.objectOverrides).toEqual(before020);
    expect(shot020.objectOverrides![alexId]?.visible).not.toBe(false);
  });

  it('reset restores the bundled baseline independent of prior mutation', () => {
    const original = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    original.name = 'Mutated';
    original.shots.pop();
    original.scene.objects = [];

    const restored = resetSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    expect(restored.name).toBe('Dialogue Demo');
    expect(restored.shots).toHaveLength(4);
    expect(restored.shots.map((shot) => shot.shotNumber)).toEqual(['010', '020', '030', '040']);
    expect(restored.scene.objects.length).toBeGreaterThan(5);
    expect(isDialogueDemoSample(restored)).toBe(true);
    expect(restored.id).not.toBe(original.id);
  });

  it('rejects unknown sample ids', () => {
    expect(() => loadSampleProject('not-a-real-sample')).toThrow(/Unknown sample/i);
  });

  it('retains the contact-sheet asset (and sample marker) through setProject pruning', () => {
    const sample = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    const normalized = pruneUnreferencedProjectAssets(sample);

    expect(
      Object.values(normalized.assets.assets).some(
        (asset) => asset.metadata?.role === 'contact-sheet',
      ),
    ).toBe(true);
    expect(
      Object.values(normalized.assets.assets).some(
        (asset) => asset.metadata?.retainInProject === true,
      ),
    ).toBe(true);
    expect(getSampleProjectId(normalized)).toBe(DIALOGUE_DEMO_SAMPLE_ID);
    expect(isDialogueDemoSample(normalized)).toBe(true);
  });

  it('reaches Export without graybox or missing-file preflight warnings', () => {
    const project = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);

    expect(project.panoRefs.some((pano) => pano.type === 'graybox_render')).toBe(true);
    expect(project.panoRefs.some((pano) => pano.type === 'ai_global_reference')).toBe(true);
    for (const pano of project.panoRefs) {
      const asset = project.assets.assets[pano.imageAssetId];
      expect(asset?.uri.startsWith('data:image/png')).toBe(true);
    }

    const projectWarnings = getProjectWarnings(project);
    expect(projectWarnings.filter((item) => item.severity === 'warning').map((item) => item.id))
      .not.toContain('missing-graybox-pano');
    expect(projectWarnings.filter((item) => item.severity === 'warning').map((item) => item.id))
      .not.toContain('missing-canonical-pano');

    const selectionWarnings = getExportSelectionWarnings(project, project.shots);
    const warningIds = selectionWarnings
      .filter((item) => item.severity === 'warning')
      .map((item) => item.id);
    expect(warningIds).not.toContain('selection-missing-graybox-pano');
    expect(warningIds).not.toContain('selection-missing-projector');
    expect(warningIds).not.toContain('selection-missing-full-pano');

    const plan = createExportPlan(project, project.shots, { packageType: 'selected-shots' });
    const grayboxOmits = plan.shots.flatMap((entry) =>
      entry.artifacts.filter((artifact) => (
        artifact.kind === 'global-graybox' && artifact.disposition === 'omit'
      )),
    );
    expect(grayboxOmits).toEqual([]);
    const grayboxProduces = plan.shots.flatMap((entry) =>
      entry.artifacts.filter((artifact) => (
        artifact.kind === 'global-graybox' && artifact.disposition === 'produce'
      )),
    );
    expect(grayboxProduces.length).toBe(project.shots.length);

    const warningCodes = plan.issues
      .filter((issue) => issue.severity === 'warning')
      .map((issue) => issue.code);
    expect(warningCodes.some((code) => code.includes('graybox'))).toBe(false);
    expect(warningCodes.some((code) => code.includes('missing'))).toBe(false);
  });
});
