/**
 * Background MP4 preparation: app-level singleton behavior, shot-scoped
 * discard, hidden-tab pause/resume, and lifecycle disposal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  createCameraKeyframe,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { resetPreparedMediaMetrics } from '../src/engine/preparedMediaMetrics';
import { resetVideoArtifactCacheForTests } from '../src/engine/videoArtifactCache';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';

vi.mock('../src/engine/videoArtifactCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/videoArtifactCache')>();
  return {
    ...actual,
    getVideoArtifactFromCache: vi.fn(async () => undefined),
  };
});

vi.mock('../src/engine/prepareVideoArtifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/prepareVideoArtifact')>();
  return {
    ...actual,
    prepareVideoArtifact: vi.fn(),
  };
});

import type { PreparedVideoArtifact } from '../src/engine/prepareVideoArtifact';
import { prepareVideoArtifact } from '../src/engine/prepareVideoArtifact';
import {
  bindBackgroundVideoService,
  disposeBackgroundVideoService,
  ensureBackgroundVideoService,
  getBackgroundVideoServiceStatus,
  queueBackgroundVideosForShot,
  discardBackgroundVideosForShot,
  resetBackgroundVideoServiceForTests,
} from '../src/engine/backgroundVideoService';

function fakeResult(cacheStatus: PreparedVideoArtifact['cacheStatus'] = 'joined'): PreparedVideoArtifact {
  return {
    fingerprint: { key: `mock:${Math.random()}` } as PreparedVideoArtifact['fingerprint'],
    blob: new Blob(['mp4'], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    width: 64,
    height: 36,
    durationSeconds: 2,
    frameRate: 24,
    frameCount: 48,
    encodeMode: 'render',
    actualEncoderMode: 'quality',
    encoderModeFallback: false,
    cacheStatus,
    timing: { setupMs: 0, renderMs: 0, encodeMs: 0, finalizeMs: 0, totalMs: 0, frameCount: 48, width: 64, height: 36, cacheHit: false },
  };
}

function projectWithMove(shotId = 'shot-a', projectId = 'project-a'): LocationProject {
  const project = createDefaultProject();
  project.id = projectId;
  const shot = project.shots[0]!;
  shot.id = shotId;
  shot.cameraKeyframes = [
    createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shot.camera }),
    createCameraKeyframe({
      label: 'End',
      timeSeconds: 2,
      camera: { ...shot.camera, position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]] },
    }),
  ];
  shot.exportSettings = {
    ...shot.exportSettings,
    includeViewport: true,
    includeProjectedViewport: false,
    includeCameraMoveVideo: true,
    includeProjectedCameraMoveVideo: false,
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
    peopleExportMode: 'both',
  };
  return project;
}

async function waitForStatus(predicate: (status: ReturnType<typeof getBackgroundVideoServiceStatus>) => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate(getBackgroundVideoServiceStatus())) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for background video status.');
}

describe('background video service', () => {
  let project: LocationProject;

  beforeEach(() => {
    project = projectWithMove();
    resetBackgroundVideoServiceForTests();
    resetPreparedMediaMetrics();
    resetVideoArtifactCacheForTests();
    renderWorkCoordinator.resetForTests();
    vi.mocked(prepareVideoArtifact).mockReset();
    vi.mocked(prepareVideoArtifact).mockImplementation(async () => fakeResult('joined'));
  });

  afterEach(() => {
    resetBackgroundVideoServiceForTests();
    renderWorkCoordinator.resetForTests();
    vi.unstubAllGlobals();
  });

  it('keeps one scheduler across captures and dedupes re-queued work', async () => {
    // peopleExportMode 'both' → two clay candidates; the second stays pending
    // while the first is in flight, which is the dedupe window.
    let release: (() => void) | undefined;
    let calls = 0;
    vi.mocked(prepareVideoArtifact).mockImplementation(async ({ signal }) => {
      calls += 1;
      // Gate only the first invocation; later ones complete freely.
      if (calls === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      }
      return fakeResult('joined');
    });

    const first = ensureBackgroundVideoService(() => project);
    const second = ensureBackgroundVideoService(() => project);
    expect(first).toBe(second);

    await queueBackgroundVideosForShot(project.shots[0]!.id);
    await waitForStatus((status) => status.running && status.pending === 1);

    // Second capture of the same shot must not enqueue a duplicate fingerprint.
    await queueBackgroundVideosForShot(project.shots[0]!.id);
    await waitForStatus((status) => status.running && status.pending === 1);

    release?.();
    await waitForStatus((status) => !status.running && status.pending === 0);
    // Exactly two renders for two variants — no duplicate from re-queueing.
    expect(calls).toBe(2);
  });

  it('discardForShot cancels only that shot, not other shots work', async () => {
    const projectA = project;
    const projectB = projectWithMove('shot-b', 'project-b');
    projectA.shots.push(projectB.shots[0]!);
    let release: (() => void) | undefined;
    let calls = 0;
    vi.mocked(prepareVideoArtifact).mockImplementation(async ({ signal }) => {
      calls += 1;
      // Gate only the first invocation (shot-a's in-flight render);
      // shot-b's renders complete freely after discard.
      if (calls === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      }
      return fakeResult('joined');
    });

    const preparedShots: string[] = [];
    bindBackgroundVideoService({
      getProject: () => projectA,
      onPrepared: (shotId) => preparedShots.push(shotId),
    });
    await queueBackgroundVideosForShot('shot-a');
    await waitForStatus((status) => status.running && status.pending === 1);
    await queueBackgroundVideosForShot('shot-b');
    await waitForStatus((status) => status.pending === 3);

    discardBackgroundVideosForShot('shot-a');
    await waitForStatus((status) => status.pending === 2);
    release?.();

    await waitForStatus((status) => !status.running && status.pending === 0);
    expect(preparedShots).toEqual(['shot-b', 'shot-b']);
    // shot-a's aborted render, shot-b's two variants: 3 total, shot-a's
    // second variant was never started.
    expect(calls).toBe(3);
  });

  it('paused scheduler queues nothing and resumes on unpause', async () => {
    const scheduler = ensureBackgroundVideoService(() => project);
    scheduler.setPaused(true);
    await queueBackgroundVideosForShot(project.shots[0]!.id);
    expect(getBackgroundVideoServiceStatus().paused).toBe(true);
    expect(getBackgroundVideoServiceStatus().pending).toBe(0);
    expect(vi.mocked(prepareVideoArtifact)).not.toHaveBeenCalled();

    scheduler.setPaused(false);
    await queueBackgroundVideosForShot(project.shots[0]!.id);
    await waitForStatus((status) => !status.running && status.pending === 0);
    expect(vi.mocked(prepareVideoArtifact)).toHaveBeenCalledTimes(2);
  });

  it('pause during processing halts the queue and resume restarts it', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    vi.mocked(prepareVideoArtifact).mockImplementation(async ({ signal }) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      }
      return fakeResult('joined');
    });

    const scheduler = ensureBackgroundVideoService(() => project);
    await queueBackgroundVideosForShot(project.shots[0]!.id);
    await waitForStatus((status) => status.running && status.pending === 1);
    // First job is in flight; pause stops the loop after it.
    scheduler.setPaused(true);
    release?.();
    await waitForStatus((status) => !status.running && status.pending === 1);

    scheduler.setPaused(false);
    await waitForStatus((status) => !status.running && status.pending === 0);
    expect(calls).toBe(2);
  });

  it('hidden-tab visibility pauses and resumes the scheduler', async () => {
    let hidden = false;
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('document', {
      get hidden() {
        return hidden;
      },
      addEventListener: (type: string, handler: () => void) => {
        listeners.set(type, handler);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    });

    const { bindBackgroundVideoService: bind } = await import('../src/engine/backgroundVideoService');
    bind({ getProject: () => project });
    expect(listeners.has('visibilitychange')).toBe(true);

    hidden = true;
    listeners.get('visibilitychange')!();
    expect(getBackgroundVideoServiceStatus().paused).toBe(true);

    hidden = false;
    listeners.get('visibilitychange')!();
    expect(getBackgroundVideoServiceStatus().paused).toBe(false);

    disposeBackgroundVideoService();
    expect(listeners.has('visibilitychange')).toBe(false);
    expect(getBackgroundVideoServiceStatus().bound).toBe(false);
  });

  it('dispose clears the queue and makes queueing a no-op', async () => {
    let release: (() => void) | undefined;
    vi.mocked(prepareVideoArtifact).mockImplementation(async ({ signal }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return fakeResult('joined');
    });

    ensureBackgroundVideoService(() => project);
    await queueBackgroundVideosForShot(project.shots[0]!.id);
    await waitForStatus((status) => status.running && status.pending === 1);

    disposeBackgroundVideoService();
    expect(getBackgroundVideoServiceStatus().bound).toBe(false);

    release?.();
    await queueBackgroundVideosForShot(project.shots[0]!.id);
    expect(getBackgroundVideoServiceStatus().pending).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vi.mocked(prepareVideoArtifact)).toHaveBeenCalledTimes(1);
  });
});
