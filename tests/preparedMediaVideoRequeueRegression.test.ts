import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import { ensureProjectExportConfiguration } from '../src/engine/exportConfiguration';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { resolveProjectVideoPerformance } from '../src/engine/videoPerformance';

vi.mock('../src/engine/backgroundVideoService', () => ({
  discardBackgroundVideosForShot: vi.fn(),
  ensureBackgroundVideoService: vi.fn(),
  queueBackgroundVideosForShot: vi.fn(async () => undefined),
}));

import {
  discardBackgroundVideosForShot,
  ensureBackgroundVideoService,
  queueBackgroundVideosForShot,
} from '../src/engine/backgroundVideoService';
import { createStillReconciliationScheduler } from '../src/engine/stillArtifactReconciliation';

function renderMock() {
  return vi.fn(async ({ specification }) => ({
    blob: new Blob(['still'], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function minimalProject() {
  const project = ensureProjectExportConfiguration(createDefaultProject());
  const shot = project.shots[0]!;
  shot.exportSettings = {
    ...shot.exportSettings,
    includeViewport: true,
    includeProjectedViewport: false,
    includeCameraMoveReferenceFrames: false,
    includeProjectedCameraMoveReferenceFrames: false,
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
    peopleExportMode: 'with_people',
  };
  return project;
}

describe('background video edit reconciliation', () => {
  beforeEach(() => {
    vi.mocked(discardBackgroundVideosForShot).mockClear();
    vi.mocked(ensureBackgroundVideoService).mockClear();
    vi.mocked(queueBackgroundVideosForShot).mockClear();
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('debounces a video-only configuration change and queues replacement video after invalidation', async () => {
    let project = minimalProject();
    const shotId = project.shots[0]!.id;
    const seeded = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'all-configured',
      render: renderMock(),
    });
    project = seeded.project;

    const scheduler = createStillReconciliationScheduler({
      debounceMs: 10,
      getProject: () => project,
      setProject: (next) => { project = next; },
    });

    const previous = project;
    const currentPerf = resolveProjectVideoPerformance(project.exportConfiguration);
    project = {
      ...project,
      exportConfiguration: {
        ...project.exportConfiguration!,
        videoPerformance: {
          profileId: currentPerf.profileId,
          resolutionPreset: currentPerf.resolutionPreset,
          encoderMode: currentPerf.encoderMode,
          frameRate: currentPerf.frameRate === 24 ? 25 : 24,
        },
      },
    };

    scheduler.scheduleAfterCommit(previous, project);
    expect(discardBackgroundVideosForShot).toHaveBeenCalledWith(shotId);

    for (let index = 0; index < 50 && vi.mocked(queueBackgroundVideosForShot).mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(ensureBackgroundVideoService).toHaveBeenCalledTimes(1);
    expect(queueBackgroundVideosForShot).toHaveBeenCalledWith(shotId);
    scheduler.dispose();
  });
});