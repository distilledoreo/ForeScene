import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  disposeBackgroundVideoService,
  ensureBackgroundVideoService,
  queueBackgroundVideosForShot,
  subscribeBackgroundVideoRuntime,
} from '../src/engine/backgroundVideoService';
import {
  clearStillArtifactRuntime,
  setStillArtifactJobStatus,
  subscribeStillArtifactRuntime,
} from '../src/engine/stillArtifactRuntime';

describe('prepared-media runtime subscriptions', () => {
  afterEach(() => {
    clearStillArtifactRuntime();
    disposeBackgroundVideoService();
  });

  it('publishes actual still-runtime transitions without duplicate events', () => {
    let updates = 0;
    const unsubscribe = subscribeStillArtifactRuntime(() => { updates += 1; });

    setStillArtifactJobStatus('shot-a', 'clay-viewport:clay:with_people', 'queued');
    expect(updates).toBe(1);

    // Re-applying identical runtime state should not wake every shot card again.
    setStillArtifactJobStatus('shot-a', 'clay-viewport:clay:with_people', 'queued');
    expect(updates).toBe(1);

    setStillArtifactJobStatus('shot-a', 'clay-viewport:clay:with_people', 'rendering');
    expect(updates).toBe(2);

    clearStillArtifactRuntime('shot-a');
    expect(updates).toBe(3);
    unsubscribe();
  });

  it('publishes per-shot video status transitions without polling', async () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    let updates = 0;
    const unsubscribe = subscribeBackgroundVideoRuntime(() => { updates += 1; });

    ensureBackgroundVideoService(() => project);
    await queueBackgroundVideosForShot(shotId);
    // Default project has no renderable camera move, so queue resolves to not-requested.
    expect(updates).toBe(1);

    await queueBackgroundVideosForShot(shotId);
    expect(updates).toBe(1);

    unsubscribe();
  });
});