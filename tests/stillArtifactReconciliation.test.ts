import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  createPanoAsset,
  createPanoReference,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import {
  createStillReconciliationScheduler,
  isMetadataOnlyShotPatch,
  shotNeedsStillReconciliation,
} from '../src/engine/stillArtifactReconciliation';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import {
  buildStillArtifactSpecificationsForShot,
} from '../src/engine/stillArtifactPlanning';
import { stillArtifactKey } from '../src/engine/stillArtifactTypes';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';

function mockRender() {
  return vi.fn(async ({ specification }) => ({
    blob: new Blob([`png-${specification.kind}-${specification.appearance}`], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function simplifyShotExport(project: LocationProject) {
  for (const shot of project.shots) {
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
  }
  return project;
}

describe('still artifact reconciliation', () => {
  beforeEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    vi.useRealTimers();
  });

  it('metadata-only patches do not need reconciliation', () => {
    expect(isMetadataOnlyShotPatch({ name: 'Hero', description: 'x' })).toBe(true);
    expect(isMetadataOnlyShotPatch({ camera: createDefaultProject().shots[0]!.camera })).toBe(false);
  });

  it('camera edit invalidates clay fingerprint and needs reconciliation', async () => {
    let project = simplifyShotExport(createDefaultProject());
    const shot = project.shots[0]!;
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'all-configured',
      render,
    });
    project = first.project;
    expect(shotNeedsStillReconciliation(project, project.shots[0]!)).toBe(false);

    project = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shot.id
          ? { ...item, camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 5 } }
          : item
      ),
    };
    expect(shotNeedsStillReconciliation(project, project.shots[0]!)).toBe(true);
  });

  it('rapid edits collapse to one reconciliation pass of latest state', async () => {
    // Real timers: durable IDB commits + debounce must interleave with real async.
    vi.useRealTimers();
    let project = simplifyShotExport(createDefaultProject());
    const shotId = project.shots[0]!.id;
    const render = mockRender();

    const seeded = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render,
      getLiveProject: () => project,
      commitLiveProject: (updater) => {
        project = updater(project);
        return project;
      },
    });
    project = seeded.project;
    const callsAfterSeed = render.mock.calls.length;

    const scheduler = createStillReconciliationScheduler({
      debounceMs: 50,
      getProject: () => project,
      setProject: (next) => {
        project = next;
      },
      render,
    });

    for (let i = 0; i < 3; i += 1) {
      project = {
        ...project,
        shots: project.shots.map((item) =>
          item.id === shotId
            ? {
              ...item,
              camera: {
                ...item.camera,
                fovDegrees: item.camera.fovDegrees + 1,
              },
            }
            : item
        ),
      };
      scheduler.scheduleAfterCommit(undefined, project, [shotId]);
    }

    // Wait for debounce + durable commit (poll until fingerprint matches or timeout).
    const deadline = Date.now() + 2000;
    let matched = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const liveShot = project.shots.find((s) => s.id === shotId)!;
      const specs = buildStillArtifactSpecificationsForShot({
        project,
        shot: liveShot,
        purpose: 'reconcile',
      });
      const primary = specs.find((s) => s.kind === 'clay-viewport')!;
      const key = stillArtifactKey(primary);
      const expected = computeStillArtifactFingerprint(project, liveShot, primary).key;
      if (liveShot.materializedMedia?.stills[key]?.fingerprint === expected) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);

    const extraCalls = render.mock.calls.length - callsAfterSeed;
    expect(extraCalls).toBeGreaterThanOrEqual(1);
    expect(extraCalls).toBeLessThanOrEqual(4);

    scheduler.dispose();
    vi.useFakeTimers();
  });

  it('depth edit regenerates depth but clay fingerprint unchanged', async () => {
    let project = simplifyShotExport(createDefaultProject());
    const shot = project.shots[0]!;
    shot.exportSettings = {
      ...shot.exportSettings,
      depth: {
        ...defaultShotDepthSettings,
        enabled: true,
        includeViewportStill: true,
        rangeMode: 'manual',
        nearMeters: 0.5,
        farMeters: 20,
      },
    };
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'all-configured',
      render,
    });
    project = first.project;
    const claySpec = {
      kind: 'clay-viewport' as const,
      appearance: 'clay' as const,
      peopleVariant: 'with_people' as const,
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };
    const depthSpec = {
      kind: 'depth-viewport' as const,
      appearance: 'depth' as const,
      peopleVariant: 'with_people' as const,
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };
    const clayFpBefore = computeStillArtifactFingerprint(project, project.shots[0]!, claySpec).key;
    const depthFpBefore = computeStillArtifactFingerprint(project, project.shots[0]!, depthSpec).key;

    project = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shot.id
          ? {
            ...item,
            exportSettings: {
              ...item.exportSettings,
              depth: {
                ...defaultShotDepthSettings,
                ...item.exportSettings.depth,
                farMeters: 50,
              },
            },
          }
          : item
      ),
    };
    const clayFpAfter = computeStillArtifactFingerprint(project, project.shots[0]!, claySpec).key;
    const depthFpAfter = computeStillArtifactFingerprint(project, project.shots[0]!, depthSpec).key;
    expect(clayFpAfter).toBe(clayFpBefore);
    expect(depthFpAfter).not.toBe(depthFpBefore);
  });

  it('pano change invalidates projected but not clay fingerprints', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const asset = createPanoAsset({
      name: 'styled.png',
      uri: 'data:image/png;base64,xx',
      width: 4,
      height: 2,
    });
    const origin = [...project.scene.panoOrigin] as [number, number, number];
    const pano = createPanoReference({
      name: 'Styled',
      assetId: asset.id,
      type: 'external_reference',
      origin,
      width: 4,
      height: 2,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [pano];
    shot.linkedPanoId = pano.id;

    const claySpec = {
      kind: 'clay-viewport' as const,
      appearance: 'clay' as const,
      peopleVariant: 'with_people' as const,
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };
    const projSpec = {
      kind: 'projected-viewport' as const,
      appearance: 'projected' as const,
      peopleVariant: 'with_people' as const,
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };
    const clayBefore = computeStillArtifactFingerprint(project, shot, claySpec).key;
    const projBefore = computeStillArtifactFingerprint(project, shot, projSpec).key;

    // Change pano origin (projected dep) without touching clay scene.
    project.panoRefs = [{
      ...pano,
      origin: [origin[0] + 1, origin[1] + 2, origin[2] + 3] as [number, number, number],
    }];
    const clayAfter = computeStillArtifactFingerprint(project, shot, claySpec).key;
    const projAfter = computeStillArtifactFingerprint(project, shot, projSpec).key;
    expect(clayAfter).toBe(clayBefore);
    expect(projAfter).not.toBe(projBefore);
  });

  it('removed output setting prunes obsolete generated artifact', async () => {
    let project = simplifyShotExport(createDefaultProject());
    const shot = project.shots[0]!;
    shot.exportSettings.peopleExportMode = 'both';
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'all-configured',
      render,
    });
    project = first.project;
    const cleanKey = stillArtifactKey({
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'clean_plate',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    });
    expect(project.shots[0]!.materializedMedia?.stills[cleanKey]).toBeDefined();

    // Remove clean plate from export mode
    project = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shot.id
          ? {
            ...item,
            exportSettings: {
              ...item.exportSettings,
              peopleExportMode: 'with_people',
            },
          }
          : item
      ),
    };
    const second = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'edit',
      scope: 'all-configured',
      render,
    });
    expect(second.project.shots[0]!.materializedMedia?.stills[cleanKey]).toBeUndefined();
  });
});
