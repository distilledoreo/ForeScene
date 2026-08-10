import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import { stillArtifactKey } from '../src/engine/stillArtifactTypes';
import {
  failNextProjectAssetBlobWriteForTests,
} from '../src/engine/projectAssetStore';

function mockRender() {
  return vi.fn(async ({ specification }) => ({
    blob: new Blob([`png-${specification.kind}`], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function minimal() {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  shot.exportSettings = {
    ...shot.exportSettings,
    includeViewport: true,
    includeProjectedViewport: false,
    includeCameraMoveReferenceFrames: false,
    includeProjectedCameraMoveReferenceFrames: false,
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
  };
  return project;
}

describe('live still commit safety', () => {
  beforeEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('does not overwrite concurrent live edits when committing a still', async () => {
    let live = minimal();
    const shotId = live.shots[0]!.id;
    const otherShotName = 'Concurrent-Edit-Survivor';
    let midFlight = false;

    const render = vi.fn(async ({ specification }) => {
      midFlight = true;
      await new Promise((r) => setTimeout(r, 20));
      return {
        blob: new Blob(['png'], { type: 'image/png' }),
        width: specification.width,
        height: specification.height,
        mimeType: 'image/png' as const,
      };
    });

    const pending = materializeShotStills({
      project: live,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render,
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        live = updater(live);
        return live;
      },
    });

    // Wait until render is in flight, then mutate an unrelated live field.
    for (let i = 0; i < 50 && !midFlight; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    live = { ...live, name: otherShotName };

    const result = await pending;
    expect(result.status).toBe('ready');
    expect(live.name).toBe(otherShotName);
    const shot = live.shots.find((s) => s.id === shotId)!;
    const key = stillArtifactKey({
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'with_people',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    });
    expect(shot.materializedMedia?.stills[key]?.assetId).toBeTruthy();
  });

  it('rejects stale commit when live camera changes during render', async () => {
    let live = minimal();
    const shotId = live.shots[0]!.id;
    const render = vi.fn(async ({ specification }) => {
      // Mutate live FOV after snapshot was taken for render.
      live = {
        ...live,
        shots: live.shots.map((s) =>
          s.id === shotId
            ? { ...s, camera: { ...s.camera, fovDegrees: s.camera.fovDegrees + 15 } }
            : s
        ),
      };
      return {
        blob: new Blob(['png'], { type: 'image/png' }),
        width: specification.width,
        height: specification.height,
        mimeType: 'image/png' as const,
      };
    });

    const result = await materializeShotStills({
      project: live,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render,
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        live = updater(live);
        return live;
      },
    });

    // Primary materialization fails as stale (or ready-with-warnings/failed)
    expect(result.artifacts.some((a) => a.status === 'failed')).toBe(true);
    const shot = live.shots.find((s) => s.id === shotId)!;
    const key = stillArtifactKey({
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'with_people',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    });
    const expected = computeStillArtifactFingerprint(live, shot, {
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'with_people',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    }).key;
    // Must not have attached the stale render's fingerprint
    const attached = shot.materializedMedia?.stills[key];
    if (attached) {
      expect(attached.fingerprint).toBe(expected);
    }
  });

  it('does not attach artifact when durable blob write fails', async () => {
    let live = minimal();
    const shotId = live.shots[0]!.id;
    failNextProjectAssetBlobWriteForTests('quota exceeded');
    const render = mockRender();

    const result = await materializeShotStills({
      project: live,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render,
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        live = updater(live);
        return live;
      },
    });

    expect(result.status).toBe('failed');
    const shot = live.shots.find((s) => s.id === shotId)!;
    expect(Object.keys(shot.materializedMedia?.stills ?? {})).toHaveLength(0);
  });
});
