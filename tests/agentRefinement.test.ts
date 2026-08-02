import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  canApproveBatch,
  canRunBatch,
  captureRefinementSnapshot,
  checkReviewMatrix,
  compareRefinementSnapshot,
  createRefinementState,
  parseRefinementPlan,
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
    characterImports: [],
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
      passes: files.slice(0, complete ? undefined : -1).map((fileName) => ({ ok: true, fileName })),
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
});
