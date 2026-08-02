import { describe, expect, it } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultProject,
  createPanoAsset,
  createPanoReference,
  createSceneObject,
  defaultShotExportSettings,
  normalizeCharacterPassExportSettings,
  normalizeProjectedStyleSettings,
  normalizeShotDepthSettings,
  normalizeShotExportSettings,
} from '../src/domain/defaults';
import { resolveProjectForShot } from '../src/engine/shotSceneState';
import {
  canApproveBatch,
  canRunBatch,
  checkRefinementDeliverables,
  checkSemanticReview,
  captureRefinementSnapshot,
  checkReviewMatrix,
  compareRefinementSnapshot,
  createRefinementState,
  listRefinementVisibilityTargets,
  parseRefinementPlan,
  resolveRefinementDeliverablesProfile,
  type RefinementPlan,
} from '../src/engine/agent/refinement';
import { createExportPlan } from '../src/engine/exportPlan';

function plan(): RefinementPlan {
  return {
    version: 1,
    mode: 'existing-project-refinement',
    preserve: {
      project: true,
      shots: true,
      panoramas: true,
      environmentObjects: true,
      cameras: true,
      timelines: true,
    },
    allowMutations: {
      shotStaging: [],
      pose: [],
      camera: [],
      timeline: [],
      visibility: [],
    },
    characterImports: [],
    characterAssignments: [],
    modelImports: [{ id: 'spider-model', batchId: 'batch-01', file: 'spider.glb' }],
    proxyReplacements: [{
      id: 'replace-spider',
      batchId: 'batch-01',
      proxyObjectId: 'proxy-spider',
      replacementImportId: 'spider-model',
      shots: ['01'],
    }],
    batches: [
      { id: 'batch-01', shots: ['01'] },
      { id: 'batch-02', shots: ['02'] },
    ],
    deliverablesProfile: 'ai-control-full',
  };
}

function reviewManifest(shotId: string, complete = true, renderable = false) {
  const files = [
    'clay_with-characters.png',
    'clay_clean-plate.png',
    'projected_with-characters.png',
    'projected_clean-plate.png',
    'characters-only.png',
    'depth.png',
  ];
  return {
    ok: true,
    shots: [{
      id: shotId,
      passes: files.slice(0, complete ? undefined : -1).map((fileName) => ({ ok: true, fileName, sha256: undefined as string | undefined })),
      temporal: { renderable },
    }],
  };
}

function renderableReviewManifest(shotId: string) {
  const manifest = reviewManifest(shotId);
  const temporal = {
    start: { fileName: 'temporal/start.png', output: 'temporal/start.png', sha256: 'sha256:start' },
    mid: { fileName: 'temporal/mid.png', output: 'temporal/mid.png', sha256: 'sha256:mid' },
    end: { fileName: 'temporal/end.png', output: 'temporal/end.png', sha256: 'sha256:end' },
    video: { fileName: 'temporal/motion-preview.mp4', output: 'temporal/motion-preview.mp4', sha256: 'sha256:video', durationSeconds: 3 },
  };
  (manifest.shots[0] as Record<string, unknown>).temporal = { renderable: true, ...temporal };
  return manifest;
}

describe('agent refinement guardrails', () => {
  it('requires a dedicated existing-project plan with explicit preservation fields', () => {
    const valid = parseRefinementPlan(plan());
    expect(valid.ok).toBe(true);

    const invalid = parseRefinementPlan({ ...plan(), mode: 'greenfield', batches: [] });
    expect(invalid).toMatchObject({ ok: false });
  });

  it('preserves original identity, cameras, and timelines while allowing new imported objects', () => {
    const project = createDefaultProject();
    const baseline = captureRefinementSnapshot(project);
    const next = structuredClone(project);
    const imported = createSceneObject('imported_model');
    imported.name = 'Imported spider';
    next.scene.objects.push(imported);

    expect(compareRefinementSnapshot(baseline, next, plan().preserve)).toMatchObject({ ok: true });

    next.shots[0]!.camera.fovDegrees += 5;
    expect(compareRefinementSnapshot(baseline, next, plan().preserve).errors).toContain(
      `Camera changed for shot ${next.shots[0]!.shotNumber}.`,
    );

    expect(compareRefinementSnapshot(baseline, next, plan().preserve, {
      ...plan().allowMutations,
      camera: [next.shots[0]!.id],
    })).toMatchObject({ ok: true });

    next.shots[0]!.camera.fovDegrees -= 5;
    next.scene.objects.shift();
    expect(compareRefinementSnapshot(baseline, next, plan().preserve).errors.join(' ')).toContain('environment object ids disappeared');
  });

  it('requires explicit approval before advancing to the next batch', () => {
    const project = createDefaultProject();
    const state = createRefinementState(plan(), project);

    expect(canRunBatch(plan(), state, 'batch-02')).toContain('Batch batch-01 must be explicitly approved before batch-02 can start.');
    state.batches['batch-01']!.status = 'awaiting_visual_review';
    expect(canApproveBatch(plan(), state, 'batch-01')).toEqual([]);
    state.batches['batch-01']!.status = 'approved';
    expect(canRunBatch(plan(), state, 'batch-02')).toEqual([]);
  });

  it('does not accept an incomplete review matrix as a completed batch review', () => {
    expect(checkReviewMatrix(reviewManifest('shot-01'), ['shot-01'])).toEqual({ ok: true, errors: [] });
    expect(checkReviewMatrix(reviewManifest('shot-01', false), ['shot-01']).errors).toContain(
      'Review matrix is missing depth.png for shot shot-01.',
    );
  });

  it('binds renderable motion approval to all four hashed temporal artifacts', () => {
    const manifest = renderableReviewManifest('shot-01');
    expect(checkReviewMatrix(manifest, ['shot-01'])).toEqual({ ok: true, errors: [] });
    for (const [index, pass] of manifest.shots[0]!.passes.entries()) pass.sha256 = `sha256:${index}`;
    const temporal = manifest.shots[0]!.temporal as unknown as Record<string, Record<string, string | number>>;
    const semantic = {
      approved: true,
      shots: [{
        id: 'shot-01',
        verdict: 'pass',
        reasons: ['Subject, creature, and framing are production-ready.'],
        primarySubject: true,
        correctVariant: true,
        framing: true,
        creature: true,
        proxyAbsent: true,
        props: true,
        motionDecision: 'approved',
        authorizedMutationDecision: 'not_applicable',
        reviewedArtifacts: [
          ...manifest.shots[0]!.passes.map((pass) => ({ fileName: pass.fileName, sha256: pass.sha256 })),
          ...['start', 'mid', 'end', 'video'].map((key) => ({
            fileName: temporal[key]!.fileName,
            sha256: temporal[key]!.sha256,
          })),
        ],
      }],
    };
    expect(checkSemanticReview(semantic, manifest, ['shot-01'])).toEqual({ ok: true, errors: [] });

    semantic.shots[0]!.motionDecision = 'not_applicable';
    expect(checkSemanticReview(semantic, manifest, ['shot-01']).errors).toContain(
      'Semantic review must approve motion for renderable shot shot-01.',
    );
    semantic.shots[0]!.motionDecision = 'approved';
    semantic.shots[0]!.reviewedArtifacts = semantic.shots[0]!.reviewedArtifacts.filter(
      (artifact) => artifact.fileName !== 'temporal/mid.png',
    );
    expect(checkSemanticReview(semantic, manifest, ['shot-01']).errors).toContain(
      'Semantic review hash does not match temporal mid evidence for shot shot-01.',
    );
  });

  it('resolves the declared deliverables profile and rejects omitted production passes', () => {
    const profile = resolveRefinementDeliverablesProfile('ai-control-full');
    expect(profile).toBeDefined();
    if (!profile) return;
    const exportPlan = {
      shots: [{
        shotId: 'shot-01',
        artifacts: [
          {
            id: 'artifact-clay',
            kind: 'clay-viewport',
            disposition: 'produce',
            files: [
              { path: 'shot-01/inputs/viewport_clay_with_people.png' },
              { path: 'shot-01/inputs/viewport_clay_clean_plate.png' },
            ],
          },
          {
            id: 'artifact-projected',
            kind: 'projected-viewport',
            disposition: 'produce',
            files: [
              { path: 'shot-01/inputs/viewport_projected_with_people.png' },
              { path: 'shot-01/inputs/viewport_projected_clean_plate.png' },
            ],
          },
          { id: 'artifact-depth', kind: 'depth-viewport', disposition: 'produce', files: [{ path: 'shot-01/depth.png' }] },
          { id: 'artifact-character', kind: 'character-still', disposition: 'produce', files: [{ path: 'shot-01/characters.png' }] },
        ],
      }],
    };
    expect(checkRefinementDeliverables(profile, exportPlan as never)).toEqual([]);
    exportPlan.shots[0]!.artifacts[0]!.disposition = 'omit';
    expect(checkRefinementDeliverables(profile, exportPlan as never)[0]).toContain('clay-viewport');
  });

  it('accepts the real export planner output when variants share one artifact', () => {
    const project = structuredClone(createDefaultProject());
    const profile = resolveRefinementDeliverablesProfile('ai-control-full');
    expect(profile).toBeDefined();
    if (!profile) return;

    const styledAsset = createPanoAsset({ name: 'Styled reference', uri: 'data:image/png;base64,AAAA', width: 2, height: 1 });
    project.assets.assets[styledAsset.id] = styledAsset;
    const styledPano = createPanoReference({
      name: 'Styled reference',
      assetId: styledAsset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 2,
      height: 1,
      isCanonical: true,
    });
    project.panoRefs.push(styledPano);
    project.settings.projectedStyle = {
      ...normalizeProjectedStyleSettings(project.settings.projectedStyle),
      panoId: styledPano.id,
    };

    const shot = project.shots[0]!;
    const character = project.scene.objects.find((object) => object.type === 'human_dummy');
    if (character) character.stagingRole = 'person';
    shot.exportSettings = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      ...profile.patch,
      characterPass: normalizeCharacterPassExportSettings({ ...defaultShotExportSettings.characterPass, ...profile.patch.characterPass }),
      depth: normalizeShotDepthSettings({ ...defaultShotExportSettings.depth, ...profile.patch.depth }),
    });
    shot.cameraKeyframes = [
      createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shot.camera }),
      createCameraKeyframe({
        label: 'End',
        timeSeconds: 2,
        camera: { ...shot.camera, position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]] },
      }),
    ];

    const exportPlan = createExportPlan(project, [shot]);
    expect(exportPlan.shots[0]!.renderableCameraMove).toBe(true);
    expect(exportPlan.shots[0]!.hasVisibleCharacters).toBe(true);
    expect(checkRefinementDeliverables(profile, exportPlan)).toEqual([]);
    const files = exportPlan.shots[0]!.artifacts
      .filter((artifact) => artifact.kind === 'clay-viewport' || artifact.kind === 'projected-viewport')
      .flatMap((artifact) => artifact.files.map((file) => file.path));
    expect(files).toEqual(expect.arrayContaining([
      expect.stringContaining('viewport_clay_with_people.png'),
      expect.stringContaining('viewport_clay_clean_plate.png'),
      expect.stringContaining('viewport_projected_with_people.png'),
      expect.stringContaining('viewport_projected_clean_plate.png'),
    ]));
    const missingMotion = structuredClone(exportPlan);
    missingMotion.shots[0]!.artifacts = missingMotion.shots[0]!.artifacts
      .filter((artifact) => artifact.kind !== 'clay-camera-move');
    expect(checkRefinementDeliverables(profile, missingMotion).some((error) => error.includes('omits clay-camera-move'))).toBe(true);
  });

  it('requires semantic approval to cover each pass hash and production judgment', () => {
    const manifest = reviewManifest('shot-01');
    for (const [index, pass] of manifest.shots[0]!.passes.entries()) pass.sha256 = `sha256:${index}`;
    const semantic = {
      approved: true,
      shots: [{
        id: 'shot-01',
        verdict: 'pass',
        reasons: ['Subject, creature, and framing are production-ready.'],
        primarySubject: true,
        correctVariant: true,
        framing: true,
        creature: true,
        proxyAbsent: true,
        props: true,
        motionDecision: 'not_applicable',
        authorizedMutationDecision: 'not_applicable',
        reviewedArtifacts: manifest.shots[0]!.passes.map((pass) => ({ fileName: pass.fileName, sha256: pass.sha256 })),
      }],
    };
    expect(checkSemanticReview(semantic, manifest, ['shot-01'])).toEqual({ ok: true, errors: [] });
    semantic.shots[0]!.proxyAbsent = false;
    expect(checkSemanticReview(semantic, manifest, ['shot-01']).errors).toContain('Semantic review must affirm proxyAbsent for shot shot-01.');
  });

  it('uses configured cast staging roles for environment-only and cast-only export passes', () => {
    const project = createDefaultProject();
    const creature = createSceneObject('imported_model');
    creature.name = 'Hand monster';
    creature.stagingRole = 'person';
    project.scene.objects.push(creature);
    const shot = project.shots[0]!;
    const environment = resolveProjectForShot(project, shot, { contentMode: 'clean_plate' });
    const castOnly = resolveProjectForShot(project, shot, { contentMode: 'characters_only' });
    expect(environment.scene.objects.find((object) => object.id === creature.id)?.visible).toBe(false);
    expect(castOnly.scene.objects.find((object) => object.id === creature.id)?.visible).toBe(true);
  });

  it('includes character placeholders in finalization visibility targets', () => {
    expect(listRefinementVisibilityTargets({
      replacements: [{ proxyObjectId: 'proxy-spider' }],
      assignments: [{ placeholderObjectId: 'joseph-placeholder' }],
    } as never)).toEqual([
      { proxyObjectId: 'proxy-spider' },
      { proxyObjectId: 'joseph-placeholder' },
    ]);
  });
});
