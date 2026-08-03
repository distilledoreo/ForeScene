import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoReference, createSceneObject, createShot } from '../src/domain/defaults';
import type { LocationProject, SceneObject, Shot } from '../src/domain/types';
import { createId } from '../src/utils/ids';
import {
  getAgentArtifactBlob,
  registerAgentArtifact,
  resetAgentArtifactRegistryForTests,
} from '../src/engine/agent/artifactRegistry';
import { deriveOperationOk, deriveOperationStatus } from '../src/engine/agent/renderResult';
import { resetAgentPackageExportControl } from '../src/engine/agent/packageExportControl';
import { resetAgentShotVideoRenderControl } from '../src/engine/agent/videoRenderControl';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { getCanonicalPano, withShotPanoLink } from '../src/engine/sync';
import { setAgentShotPanorama } from '../src/engine/agent/shotPanorama';
import { inspectAgentShotDiagnostics } from '../src/engine/agent/shotDiagnostics';
import {
  frameAgentSubjects,
  orientAgentObjectToward,
  snapAgentObjectToFloor,
  trackAgentSubjects,
} from '../src/engine/agent/spatialPrimitives';
import { updateShotObjectOverrides } from '../src/engine/shotSceneState';
import { createShotKeyframe } from '../src/engine/shotTimeline';
import { touchProject } from '../src/state/slices/touchProject';

function installMockDestructiveMutation() {
  useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
    await mutation();
    const project = useProjectStore.getState().project;
    return {
      project: structuredClone(project),
      revision: {
        id: `rev_${Date.now().toString(36)}`,
        projectId: project.id,
        kind: 'autosave' as const,
        reason: 'test',
        createdAt: new Date().toISOString(),
        manifest: '{}',
        resources: { projectAssetKeys: [], modelAssetKeys: [] },
      },
    };
  });
}

function projectWithPano(): LocationProject {
  const project = createDefaultProject();
  const assetId = createId('asset');
  const pano = createPanoReference({
    name: 'Test Pano',
    assetId,
    type: 'ai_global_reference',
    origin: [0, 1.6, 0],
    rotation: [0, 0, 0],
    width: 1024,
    height: 512,
    isCanonical: true,
  });
  return {
    ...project,
    assets: {
      assets: {
        ...project.assets.assets,
        [assetId]: {
          id: assetId,
          name: 'Test Pano Asset',
          type: 'image',
          mimeType: 'image/png',
          uri: 'data:image/png;base64,test',
          width: 1024,
          height: 512,
          resolutionStatus: 'available',
          createdAt: new Date().toISOString(),
        },
      },
    },
    panoRefs: [pano],
    shots: project.shots.map((shot) => ({
      ...shot,
      linkedPanoId: pano.id,
    })),
  };
}

function corridorProject(): { project: LocationProject; actor: SceneObject; shot: Shot } {
  const floor = createSceneObject('floor', 1);
  floor.dimensions = [8, 0.1, 20];
  floor.transform.position = [0, 0, 0];

  const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
  actor.name = 'Actor';

  const shot = createShot({ index: 1, camera: {
    position: [0, 1.6, 6],
    target: [0, 1.4, 0],
    fovDegrees: 50,
    aspectRatio: 16 / 9,
    near: 0.1,
    far: 100,
  } });

  const project = touchProject({
    ...createDefaultProject(),
    scene: { ...createDefaultProject().scene, objects: [floor, actor] },
    shots: [shot],
  });

  return { project, actor, shot };
}

describe('agent API improvements', () => {
  beforeEach(() => {
    resetAgentArtifactRegistryForTests();
    resetAgentPackageExportControl();
    resetAgentShotVideoRenderControl();
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const project = projectWithPano();
    useProjectStore.setState({
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
      activePanoId: project.panoRefs[0]?.id,
      isRenderingGraybox: false,
      isExportingPackage: false,
    });
    useProjectSafetyStore.setState({ criticalWrite: false, status: 'saved' });
    installMockDestructiveMutation();
  });

  afterEach(() => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(undefined);
    resetAgentArtifactRegistryForTests();
  });

  it('derives render status with artifact despite quality diagnostics', () => {
    const status = deriveOperationStatus({
      hasArtifact: true,
      diagnostics: [{ code: 'frame_zero_variance', message: 'flat', severity: 'error' }],
    });
    expect(status).toBe('completed_with_warnings');
    expect(deriveOperationOk(status)).toBe(true);
  });

  it('retrieves artifact bytes matching the registered blob', async () => {
    const payload = 'forescene-artifact-bytes';
    const handle = registerAgentArtifact({
      blob: new Blob([payload], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileName: 'payload.txt',
    });
    const blob = getAgentArtifactBlob(handle.artifactId);
    expect(blob).toBeTruthy();
    const text = await blob!.text();
    expect(text).toBe(payload);
  });

  it('clears linked panorama and active pano when unlinking the selected shot', async () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const canonical = getCanonicalPano(project)!;

    useProjectStore.setState({ activePanoId: canonical.id, selectedShotId: shot.id });
    const cleared = await setAgentShotPanorama({ shotId: shot.id, panoId: null });
    expect(cleared.ok).toBe(true);
    expect(useProjectStore.getState().activePanoId).toBeUndefined();
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBeUndefined();
  });

  it('snaps only shot staging, leaving the base scene transform intact', async () => {
    const { project, actor, shot } = corridorProject();
    actor.transform.position = [0, 5, 0];
    useProjectStore.setState({ project, selectedShotId: shot.id });

    const result = await snapAgentObjectToFloor({
      shotId: shot.id,
      object: { id: actor.id },
    });
    expect(result.ok).toBe(true);

    const base = useProjectStore.getState().project.scene.objects.find((item) => item.id === actor.id);
    expect(base?.transform.position[1]).toBe(5);

    const overrideY = useProjectStore.getState().project.shots[0]?.objectOverrides?.[actor.id]?.transform?.position?.[1];
    expect(overrideY).toBeCloseTo(0.925, 2);
  });

  it('orients using shot-effective positions rather than base scene parking transforms', async () => {
    const { project, actor, shot } = corridorProject();
    const target = createSceneObject('human_dummy', 2, [4, 0.875, 0]);
    target.name = 'Target';
    actor.transform.position = [0, 0.875, -10];
    const stagedShot = {
      ...shot,
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: {
          position: [0, 0.875, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      }),
    };
    useProjectStore.setState({
      project: { ...project, scene: { ...project.scene, objects: [...project.scene.objects, target] } , shots: [stagedShot] },
      selectedShotId: shot.id,
    });

    const result = await orientAgentObjectToward({
      shotId: shot.id,
      object: { id: actor.id },
      target: { id: target.id },
    });
    expect(result.ok).toBe(true);
    const yaw = useProjectStore.getState().project.shots[0]?.objectOverrides?.[actor.id]?.transform?.rotation?.[1] ?? 0;
    expect(Math.abs(yaw)).toBeGreaterThan(10);
  });

  it('frames subjects from shot staging overrides', async () => {
    const { project, actor, shot } = corridorProject();
    actor.transform.position = [0, 0.875, -20];
    const stagedShot = {
      ...shot,
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: {
          position: [2, 0.875, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      }),
    };
    useProjectStore.setState({ project: { ...project, shots: [stagedShot] }, selectedShotId: shot.id });

    const result = await frameAgentSubjects({
      shotId: shot.id,
      subjectIds: [actor.id],
      composition: 'medium',
    });
    expect(result.ok).toBe(true);
    expect(result.camera?.target[0]).toBeGreaterThan(1);
  });

  it('tracks subjects with different start and end cameras when subjects move', async () => {
    const { project, actor, shot } = corridorProject();
    let next = createShotKeyframe(project, shot.id, {
      timeSeconds: 0,
      camera: shot.camera,
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [0, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
      label: 'Start',
    });
    next = createShotKeyframe(next, shot.id, {
      timeSeconds: 3,
      camera: shot.camera,
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [4, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
      label: 'End',
    });
    useProjectStore.setState({ project: next, selectedShotId: shot.id });

    const result = await trackAgentSubjects({
      shotId: shot.id,
      subjectIds: [actor.id],
      startTime: 0,
      endTime: 3,
      composition: 'medium',
    });
    expect(result.ok).toBe(true);
    expect((result.cameraDisplacementMeters ?? 0)).toBeGreaterThan(0.1);
    expect(result.subjectDisplacements?.[0]?.displacementMeters ?? 0).toBeGreaterThan(3);
  });

  it('warns when trackSubjects sees no subject motion and identical cameras', async () => {
    const { project, actor, shot } = corridorProject();
    useProjectStore.setState({ project, selectedShotId: shot.id });

    const result = await trackAgentSubjects({
      shotId: shot.id,
      subjectIds: [actor.id],
      startTime: 0,
      endTime: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed_with_warnings');
    expect(result.diagnostics.some((item) => item.code === 'track_no_motion')).toBe(true);
  });

  it('reports camera outside environment bounds and below-floor penetration', () => {
    const { project, actor, shot } = corridorProject();
    const outsideShot: Shot = {
      ...shot,
      camera: {
        ...shot.camera,
        position: [20, 1.6, 0],
        target: [0, 1.4, 0],
      },
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    };
    const diagnostics = inspectAgentShotDiagnostics({ project, shot: outsideShot });
    expect(diagnostics.cameraInsideEnvironmentBounds).toBe(false);
    const actorDiag = diagnostics.subjects.find((item) => item.objectId === actor.id);
    expect(actorDiag?.groundClearanceMeters ?? 0).toBeLessThan(0);
  });

  it('separates visible fraction from screen coverage using occlusion', () => {
    const { project, actor, shot } = corridorProject();
    actor.dimensions = [0.2, 0.4, 0.2];
    actor.transform.scale = [1, 1, 1];
    actor.transform.position = [0, 0.2, 4];
    const diagnostics = inspectAgentShotDiagnostics({ project, shot });
    const actorDiag = diagnostics.subjects.find((item) => item.objectId === actor.id);
    expect(actorDiag).toBeTruthy();
    if (!actorDiag) return;
    expect(actorDiag.screenCoverage).toBeLessThan(0.2);
    expect(actorDiag.visibleFraction).toBeGreaterThan(actorDiag.screenCoverage);
  });

  it('recomputes pano crop when linking via withShotPanoLink helper', () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const canonical = getCanonicalPano(project)!;
    const linked = withShotPanoLink(project, shot, canonical);
    expect(linked.linkedPanoId).toBe(canonical.id);
    expect(linked.panoCrop?.panoId).toBe(canonical.id);
  });
});
