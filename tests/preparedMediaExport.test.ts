/**
 * Prepared-media export gates: zero-render warm export, recovery, both writers path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import type { LocationProject, Shot } from '../src/domain/types';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import {
  ensureStillArtifactForExport,
} from '../src/engine/ensureStillArtifactForExport';
import {
  annotateStillArtifactReadiness,
  createExportPlan,
} from '../src/engine/exportPlan';
import {
  getPreparedMediaMetrics,
  resetPreparedMediaMetrics,
} from '../src/engine/preparedMediaMetrics';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { stillArtifactKey, type StillArtifactSpecification } from '../src/engine/stillArtifactTypes';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import { commitPreparedStillArtifact } from '../src/engine/commitPreparedStillArtifact';
import { prepareStillArtifact } from '../src/engine/prepareStillArtifact';

function mockRender(counter: { n: number }) {
  return vi.fn(async ({ specification }: { specification: StillArtifactSpecification }) => {
    counter.n += 1;
    return {
      blob: new Blob([`png-${counter.n}-${specification.kind}`], { type: 'image/png' }),
      width: specification.width,
      height: specification.height,
      mimeType: 'image/png' as const,
    };
  });
}

function minimalShot(project: LocationProject): Shot {
  const shot = project.shots[0]!;
  shot.exportSettings = {
    ...shot.exportSettings,
    includeViewport: true,
    includeProjectedViewport: false,
    includeCameraMoveReferenceFrames: false,
    includeProjectedCameraMoveReferenceFrames: false,
    includeCameraMoveVideo: false,
    includeProjectedCameraMoveVideo: false,
    includeAiResultFrame: false,
    includePanoCrop: false,
    includeFullPano: false,
    includeGrayboxPano: false,
    includeCubemap: false,
    includeMetadata: true,
    includePrompt: false,
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
    peopleExportMode: 'with_people',
  };
  return shot;
}

describe('prepared media export path', () => {
  beforeEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetPreparedMediaMetrics();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('warm/current ensureStillArtifact performs zero still renderer calls', async () => {
    const project = createDefaultProject();
    const shot = minimalShot(project);
    const counter = { n: 0 };
    const render = mockRender(counter);

    const materialized = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'all-configured',
      render,
    });
    const rendersAfterMaterialize = counter.n;
    expect(rendersAfterMaterialize).toBeGreaterThan(0);

    resetPreparedMediaMetrics();
    const ensured = await ensureStillArtifactForExport({
      frozenProject: materialized.project,
      shotId: shot.id,
      specification: {
        kind: 'clay-viewport',
        appearance: 'clay',
        peopleVariant: 'with_people',
        width: shot.exportSettings.width,
        height: shot.exportSettings.height,
      },
      render,
    });
    expect(ensured.source).toBe('materialized-asset');
    expect(counter.n).toBe(rendersAfterMaterialize);
    expect(getPreparedMediaMetrics().exportStillAssetHits).toBe(1);
    expect(getPreparedMediaMetrics().exportStillRecoveryRenders).toBe(0);
  });

  it('second warm ensure is also zero-render (repeated export)', async () => {
    const project = createDefaultProject();
    const shot = minimalShot(project);
    const counter = { n: 0 };
    const render = mockRender(counter);
    const materialized = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'primary',
      render,
    });
    const afterFirst = counter.n;
    const spec: StillArtifactSpecification = {
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'with_people',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };
    await ensureStillArtifactForExport({
      frozenProject: materialized.project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    await ensureStillArtifactForExport({
      frozenProject: materialized.project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(counter.n).toBe(afterFirst);
  });

  it('missing artifact performs one recovery render and never packages stale fingerprint', async () => {
    const project = createDefaultProject();
    const shot = minimalShot(project);
    const counter = { n: 0 };
    const render = mockRender(counter);
    const spec: StillArtifactSpecification = {
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'with_people',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };

    // No materialized media — recovery required
    const ensured = await ensureStillArtifactForExport({
      frozenProject: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(ensured.source).toBe('render-recovery');
    expect(counter.n).toBe(1);
    expect(ensured.blob.size).toBeGreaterThan(0);

    // Stale record: fingerprint mismatch must not package the stale asset silently.
    const prepared = await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: spec,
      render,
    });
    const fp = computeStillArtifactFingerprint(project, shot, spec);
    const commit = await commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification: spec,
      expectedFingerprint: fp.key,
      prepared,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    // Make stored fingerprint stale relative to live camera
    const staleProject: LocationProject = {
      ...commit.project,
      shots: commit.project.shots.map((item) => {
        if (item.id !== shot.id) return item;
        const key = stillArtifactKey(spec);
        const stills = { ...item.materializedMedia!.stills };
        stills[key] = { ...stills[key]!, fingerprint: 'stale-fingerprint-xxx' };
        return { ...item, materializedMedia: { stills } };
      }),
    };

    const before = counter.n;
    const recovered = await ensureStillArtifactForExport({
      frozenProject: staleProject,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(recovered.source).toBe('render-recovery');
    expect(counter.n).toBe(before + 1);
  });

  it('export plan marks ready prepared stills with materialized-asset source', async () => {
    const project = createDefaultProject();
    const shot = minimalShot(project);
    const render = mockRender({ n: 0 });
    const materialized = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'primary',
      render,
    });
    const plan = createExportPlan(materialized.project, [materialized.project.shots[0]!]);
    const clay = plan.shots[0]!.artifacts.find((a) => a.kind === 'clay-viewport');
    expect(clay).toBeDefined();
    expect(clay!.readiness).toBe('ready');
    expect(clay!.source).toBe('materialized-asset');
    expect(clay!.sourceAssetId).toBeTruthy();
  });

  it('legacy project without materializedMedia plans missing and recovers', async () => {
    const project = createDefaultProject();
    const shot = minimalShot(project);
    // Explicitly no materializedMedia
    delete shot.materializedMedia;
    const plan = createExportPlan(project, [shot]);
    const clay = plan.shots[0]!.artifacts.find((a) => a.kind === 'clay-viewport');
    expect(clay?.readiness === 'missing' || clay?.source === 'render-recovery').toBe(true);

    const counter = { n: 0 };
    const render = mockRender(counter);
    const ensured = await ensureStillArtifactForExport({
      frozenProject: project,
      shotId: shot.id,
      specification: {
        kind: 'clay-viewport',
        appearance: 'clay',
        peopleVariant: 'with_people',
        width: shot.exportSettings.width,
        height: shot.exportSettings.height,
      },
      render,
    });
    expect(ensured.source).toBe('render-recovery');
    expect(counter.n).toBe(1);
  });

  it('recovery does not overwrite newer live state', async () => {
    const project = createDefaultProject();
    const shot = minimalShot(project);
    const counter = { n: 0 };
    const render = mockRender(counter);
    const spec: StillArtifactSpecification = {
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'with_people',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };

    // Live project already moved on (different FOV) vs frozen export snapshot
    const frozen = structuredClone(project);
    const live: LocationProject = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shot.id
          ? { ...item, camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 20 } }
          : item
      ),
    };

    const result = await ensureStillArtifactForExport({
      frozenProject: frozen,
      liveProject: live,
      shotId: shot.id,
      specification: spec,
      render,
    });
    expect(result.source).toBe('render-recovery');
    // Temporary asset path when live fingerprint differs
    expect(result.temporaryAssetId || result.blob).toBeTruthy();
    // Live project should not have been committed with frozen fingerprint
    if (result.liveProject) {
      const liveStill = result.liveProject.shots[0]!.materializedMedia?.stills[stillArtifactKey(spec)];
      if (liveStill) {
        const liveFp = computeStillArtifactFingerprint(result.liveProject, result.liveProject.shots[0]!, spec).key;
        expect(liveStill.fingerprint).toBe(liveFp);
      }
    }
  });

  it('annotateStillArtifactReadiness exposes readiness fields', () => {
    const project = createDefaultProject();
    const shot = minimalShot(project);
    const annotated = annotateStillArtifactReadiness(
      project,
      shot,
      {
        id: 'x',
        shotId: shot.id,
        kind: 'clay-viewport',
        disposition: 'produce',
        files: [],
        workUnits: 1,
        appearance: 'clay',
      },
      {
        kind: 'clay-viewport',
        appearance: 'clay',
        peopleVariant: 'with_people',
        width: shot.exportSettings.width,
        height: shot.exportSettings.height,
      },
    );
    expect(annotated.readiness).toBe('missing');
    expect(annotated.source).toBe('render-recovery');
  });
});
