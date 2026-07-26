import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateProjectRevision,
  getProjectRevisionHead,
  resetProjectRevisionStoreForTests,
  writeProjectRevision,
  type ProjectRevisionRecord,
} from '../src/engine/projectRevisionStore';

function revision(id: string, projectId: string, createdAt: string): ProjectRevisionRecord {
  return {
    id,
    projectId,
    kind: 'autosave',
    reason: id,
    createdAt,
    manifest: '{}',
    resources: {
      projectAssetKeys: [],
      modelAssetKeys: [],
      projectAssets: [],
      models: [],
    },
  };
}

describe('project revision store', () => {
  beforeEach(resetProjectRevisionStoreForTests);
  afterEach(resetProjectRevisionStoreForTests);

  it('does not replace the previous-known-good pointer when the active revision is activated again', async () => {
    const projectId = 'project-idempotent-activation';
    const first = revision('revision-one', projectId, '2026-01-01T00:00:00.000Z');
    const second = revision('revision-two', projectId, '2026-01-02T00:00:00.000Z');
    await writeProjectRevision(first);
    const originalHead = await writeProjectRevision(second);

    const reactivated = await activateProjectRevision(projectId, second.id, '2026-01-03T00:00:00.000Z');

    expect(reactivated).toEqual(originalHead);
    expect(reactivated.previousRevisionId).toBe(first.id);
    expect(reactivated.previousRevisionId).not.toBe(second.id);
    expect(await getProjectRevisionHead(projectId)).toEqual(originalHead);
  });
});
