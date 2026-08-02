import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
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
  parseRefinementPlan,
  resolveRefinementDeliverablesProfile,
  type RefinementPlan,
} from '../src/engine/agent/refinement';

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

function reviewManifest(shotId: string, complete = true) {
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
    }],
  };
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

  it('resolves the declared deliverables profile and rejects omitted production passes', () => {
    const profile = resolveRefinementDeliverablesProfile('ai-control-full');
    expect(profile).toBeDefined();
    if (!profile) return;
    const exportPlan = {
      shots: [{
        shotId: 'shot-01',
        artifacts: profile.requiredArtifacts.map((expected, index) => ({
          id: `artifact-${index}`,
          kind: expected.kind,
          variant: expected.variant,
          disposition: 'produce',
          files: [{ path: `shot-01/${index}.png` }],
        })),
      }],
    };
    expect(checkRefinementDeliverables(profile, exportPlan as never)).toEqual([]);
    exportPlan.shots[0]!.artifacts[0]!.disposition = 'omit';
    expect(checkRefinementDeliverables(profile, exportPlan as never)[0]).toContain('clay-viewport');
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
});
