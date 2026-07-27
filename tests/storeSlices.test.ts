import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORY_SLICE_KEYS,
  PROJECT_SLICE_KEYS,
  SELECTION_SLICE_KEYS,
  SESSION_SLICE_KEYS,
  WORKFLOW_SLICE_KEYS,
  createProjectSlice,
  createSelectionSlice,
  createHistorySlice,
  createWorkflowSlice,
  createSessionSlice,
  useContinuityStore,
} from '../src/state/useContinuityStore';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('continuity store domain slices', () => {
  it('composes real slice creators in useContinuityStore', () => {
    const storeSrc = readFileSync(join(root, 'src/state/useContinuityStore.ts'), 'utf8');
    expect(storeSrc).toMatch(/createProjectSlice\(/);
    expect(storeSrc).toMatch(/createSelectionSlice\(/);
    expect(storeSrc).toMatch(/createHistorySlice\(/);
    expect(storeSrc).toMatch(/createWorkflowSlice\(/);
    expect(storeSrc).toMatch(/createSessionSlice\(/);
    expect(typeof createProjectSlice).toBe('function');
    expect(typeof createSelectionSlice).toBe('function');
    expect(typeof createHistorySlice).toBe('function');
    expect(typeof createWorkflowSlice).toBe('function');
    expect(typeof createSessionSlice).toBe('function');
  });

  it('exposes project/selection/history/workflow/session slice keys', () => {
    const state = useContinuityStore.getState();
    for (const key of [
      ...PROJECT_SLICE_KEYS,
      ...SELECTION_SLICE_KEYS,
      ...HISTORY_SLICE_KEYS,
      ...WORKFLOW_SLICE_KEYS,
      ...SESSION_SLICE_KEYS,
    ]) {
      expect(state).toHaveProperty(key);
    }
  });

  it('reorders shots and copies staging via project slice actions', () => {
    const store = useContinuityStore.getState();
    const first = store.project.shots[0];
    store.addCamera({ navigateToShots: false });
    const afterAdd = useContinuityStore.getState();
    expect(afterAdd.project.shots.length).toBeGreaterThanOrEqual(2);
    const second = afterAdd.project.shots[1];
    afterAdd.reorderShots(second.id, 0);
    const reordered = useContinuityStore.getState().project.shots;
    expect(reordered[0]?.id).toBe(second.id);

    const objectId = afterAdd.project.scene.objects[0]?.id;
    if (objectId) {
      useContinuityStore.getState().updateShot(reordered[0].id, {
        objectOverrides: {
          [objectId]: {
            visible: false,
          },
        },
      });
      useContinuityStore.getState().copyStagingToNextShot(reordered[0].id);
      const next = useContinuityStore.getState().project.shots[1];
      expect(next?.objectOverrides?.[objectId]?.visible).toBe(false);
    }
    // Keep first shot id selected for other tests that share store.
    useContinuityStore.getState().selectShot(first.id);
  });
});
