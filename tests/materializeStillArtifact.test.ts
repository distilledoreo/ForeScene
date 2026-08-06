import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { LocationProject, Shot } from '../src/domain/types';
import { commitPreparedStillArtifact } from '../src/engine/commitPreparedStillArtifact';
import {
  prepareStillArtifact,
  resetPrepareStillArtifactInflightForTests,
  setPrepareStillArtifactRenderForTests,
} from '../src/engine/prepareStillArtifact';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from '../src/engine/stillArtifactTypes';
import { getReferencedProjectAssetIds, pruneUnreferencedProjectAssets } from '../src/engine/projectAssets';
import {
  createProjectAssetStorageKey,
  getProjectAssetBlob,
  storeProjectAssetBlob,
} from '../src/engine/projectAssetStore';
import { createId } from '../src/utils/ids';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';

function claySpec(shot: Shot, peopleVariant: 'with_people' | 'clean_plate' = 'with_people'): StillArtifactSpecification {
  return {
    kind: 'clay-viewport',
    appearance: 'clay',
    peopleVariant,
    width: shot.exportSettings.width,
    height: shot.exportSettings.height,
  };
}

function mockRender(label = 'still') {
  let calls = 0;
  const render = vi.fn(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      blob: new Blob([`png-${label}-${calls}`], { type: 'image/png' }),
      width: 64,
      height: 36,
      mimeType: 'image/png' as const,
    };
  });
  return { render, getCalls: () => calls };
}

describe('prepareStillArtifact + commitPreparedStillArtifact', () => {
  beforeEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    setPrepareStillArtifactRenderForTests(undefined);
    renderWorkCoordinator.resetForTests();
  });

  it('reuses a current materialized artifact without re-rendering', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render } = mockRender('first');

    const prepared = await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(prepared.cacheStatus).toBe('rendered');
    expect(render).toHaveBeenCalledTimes(1);

    const fp = computeStillArtifactFingerprint(project, shot, spec);
    const commit = commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification: spec,
      expectedFingerprint: fp.key,
      prepared,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    const second = await prepareStillArtifact({
      projectSnapshot: commit.project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(second.cacheStatus).toBe('current');
    expect(second.existingAssetId).toBe(commit.assetId);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('regenerates when the project asset is missing', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render } = mockRender('regen');

    const prepared = await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const fp = computeStillArtifactFingerprint(project, shot, spec);
    const commit = commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification: spec,
      expectedFingerprint: fp.key,
      prepared,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    // Drop the asset from the registry while leaving the materialized record.
    const broken: LocationProject = {
      ...commit.project,
      assets: {
        ...commit.project.assets,
        assets: Object.fromEntries(
          Object.entries(commit.project.assets.assets).filter(([id]) => id !== commit.assetId),
        ),
      },
    };

    const again = await prepareStillArtifact({
      projectSnapshot: broken,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(again.cacheStatus).toBe('rendered');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('rejects commit after concurrent edit (stale fingerprint)', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render } = mockRender('stale');

    const prepared = await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const fp = computeStillArtifactFingerprint(project, shot, spec);

    // Concurrent edit: camera FOV change invalidates fingerprint.
    const edited: LocationProject = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shot.id
          ? {
            ...item,
            camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 12 },
          }
          : item
      ),
    };

    const commit = commitPreparedStillArtifact({
      project: edited,
      shotId: shot.id,
      specification: spec,
      expectedFingerprint: fp.key,
      prepared,
    });
    expect(commit.ok).toBe(false);
    if (commit.ok) return;
    expect(commit.reason).toBe('stale');
    // Previous artifact (none) remains — no half-written record.
    expect(commit.project.shots[0]!.materializedMedia?.stills).toBeUndefined();
  });

  it('preserves previous artifact when regeneration fails', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render } = mockRender('keep');

    const prepared = await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const fp = computeStillArtifactFingerprint(project, shot, spec);
    const commit = commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification: spec,
      expectedFingerprint: fp.key,
      prepared,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    const previousArtifact = commit.project.shots[0]!.materializedMedia!.stills[stillArtifactKey(spec)];
    expect(previousArtifact).toBeDefined();

    // Force a failure path by preparing with a throwing renderer after camera change.
    const edited: LocationProject = {
      ...commit.project,
      shots: commit.project.shots.map((item) =>
        item.id === shot.id
          ? {
            ...item,
            camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 3 },
          }
          : item
      ),
    };
    const failingRender = vi.fn(async () => {
      throw new Error('WebGL context lost');
    });
    await expect(
      prepareStillArtifact({
        projectSnapshot: edited,
        shotId: shot.id,
        specification: claySpec(edited.shots[0]!),
        render: failingRender,
      }),
    ).rejects.toThrow(/WebGL/);

    // Project still holds previous artifact.
    const stillThere = edited.shots[0]!.materializedMedia!.stills[stillArtifactKey(spec)];
    expect(stillThere?.assetId).toBe(previousArtifact!.assetId);
    expect(stillThere?.fingerprint).toBe(previousArtifact!.fingerprint);
  });

  it('joins identical in-flight preparation requests (renders once)', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render, getCalls } = mockRender('join');

    const a = prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const b = prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(getCalls()).toBe(1);
    expect(ra.cacheStatus === 'rendered' || ra.cacheStatus === 'joined').toBe(true);
    expect(rb.cacheStatus === 'rendered' || rb.cacheStatus === 'joined').toBe(true);
    // Exactly one should be the originator ('rendered'), the other joined.
    const statuses = [ra.cacheStatus, rb.cacheStatus].sort();
    expect(statuses).toContain('joined');
  });

  it('one subscriber cancelling does not cancel another', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render } = mockRender('cancel-one');

    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const promiseA = prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      signal: controllerA.signal,
      render,
    });
    const promiseB = prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      signal: controllerB.signal,
      render,
    });

    controllerA.abort();
    await expect(promiseA).rejects.toThrow(/cancelled/i);
    const resultB = await promiseB;
    expect(resultB.blob || resultB.existingAssetId).toBeTruthy();
    expect(render).toHaveBeenCalled();
  });

  it('all subscribers cancelling stops the underlying job', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    let renderStarted = false;
    let sawAbortOnSignal = false;
    const gate = { release: undefined as (() => void) | undefined };
    const started = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const render = vi.fn(async (params: { signal?: AbortSignal }) => {
      renderStarted = true;
      gate.release?.();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          sawAbortOnSignal = true;
          reject(Object.assign(new Error('Still materialization was cancelled.'), { name: 'AbortError' }));
        };
        if (params.signal?.aborted) {
          onAbort();
          return;
        }
        params.signal?.addEventListener('abort', onAbort, { once: true });
        // Stay open until aborted (or long timeout).
        setTimeout(() => resolve(), 5_000);
      });
      return {
        blob: new Blob(['x'], { type: 'image/png' }),
        width: 8,
        height: 8,
        mimeType: 'image/png' as const,
      };
    });

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      signal: c1.signal,
      render,
    });
    const p2 = prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      signal: c2.signal,
      render,
    });
    await started;
    c1.abort();
    c2.abort();
    await expect(p1).rejects.toThrow(/cancelled/i);
    await expect(p2).rejects.toThrow(/cancelled/i);
    expect(renderStarted).toBe(true);
    // Allow abort to propagate to the shared controller / render signal.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sawAbortOnSignal).toBe(true);
  });

  it('GC retains current materialized still assets', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render } = mockRender('gc');
    const prepared = await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const fp = computeStillArtifactFingerprint(project, shot, spec);
    const commit = commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification: spec,
      expectedFingerprint: fp.key,
      prepared,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    // Orphan asset
    const orphanId = createId('asset');
    const withOrphan: LocationProject = {
      ...commit.project,
      assets: {
        ...commit.project.assets,
        assets: {
          ...commit.project.assets.assets,
          [orphanId]: {
            id: orphanId,
            type: 'image',
            name: 'orphan.png',
            uri: 'data:image/png;base64,xx',
            createdAt: new Date().toISOString(),
          },
        },
      },
    };

    const pruned = pruneUnreferencedProjectAssets(withOrphan);
    expect(pruned.assets.assets[orphanId]).toBeUndefined();
    expect(pruned.assets.assets[commit.assetId]).toBeDefined();
    expect(getReferencedProjectAssetIds(pruned).has(commit.assetId)).toBe(true);
  });

  it('reload path retrieves persisted generated still via storage key', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = claySpec(shot);
    const { render } = mockRender('reload');
    const prepared = await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const fp = computeStillArtifactFingerprint(project, shot, spec);
    const commit = commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification: spec,
      expectedFingerprint: fp.key,
      prepared,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    const asset = commit.project.assets.assets[commit.assetId]!;
    const key = asset.storageKey ?? createProjectAssetStorageKey(commit.project.id, asset.id);
    const blob = await getProjectAssetBlob(key);
    expect(blob).toBeDefined();
    expect(blob!.type).toMatch(/image/);

    const reloaded = await prepareStillArtifact({
      projectSnapshot: commit.project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(reloaded.cacheStatus).toBe('current');
    expect(render).toHaveBeenCalledTimes(1);
  });
});
