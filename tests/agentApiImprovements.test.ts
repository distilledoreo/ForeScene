import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoReference, createSceneObject, createShot } from '../src/domain/defaults';
import type { LocationProject, SceneObject, Shot } from '../src/domain/types';
import { createId } from '../src/utils/ids';
import {
  getAgentArtifactBlob,
  getAgentArtifactHandle,
  registerAgentArtifact,
  resetAgentArtifactRegistryForTests,
  setAgentArtifactRegistryLimitsForTests,
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
  effectiveObjectWorldAabb,
  getShotEffectiveState,
  identifyFloorY,
} from '../src/engine/agent/spatialShotState';
import { buildShotCompositionTelemetry } from '../src/engine/previs/compositionTelemetry';
import {
  frameAgentSubjects,
  orientAgentObjectToward,
  snapAgentObjectToFloor,
  trackAgentSubjects,
} from '../src/engine/agent/spatialPrimitives';
import { getCameraMoveDurationSeconds } from '../src/engine/cameraKeyframes';
import { updateShotObjectOverrides } from '../src/engine/shotSceneState';
import { createShotKeyframe, sampleShotTimeline } from '../src/engine/shotTimeline';
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

  it('prunes the least-recently-used unpersisted artifact instead of the oldest handle', () => {
    setAgentArtifactRegistryLimitsForTests({ maxArtifacts: 2 });
    const first = registerAgentArtifact({
      blob: new Blob(['first'], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileName: 'first.txt',
    });
    const second = registerAgentArtifact({
      blob: new Blob(['second'], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileName: 'second.txt',
    });

    // Refresh the first handle before the third registration. The second one
    // is now the least recently used entry and should be reclaimed.
    expect(getAgentArtifactHandle(first.artifactId)?.artifactId).toBe(first.artifactId);
    const third = registerAgentArtifact({
      blob: new Blob(['third'], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileName: 'third.txt',
    });

    expect(getAgentArtifactBlob(first.artifactId)).toBeTruthy();
    expect(getAgentArtifactBlob(third.artifactId)).toBeTruthy();
    expect(getAgentArtifactBlob(second.artifactId)).toBeUndefined();
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

  it('grounds objects using the bottom of their effective world bounds', async () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [10, 0.1, 10];
    floor.transform.position = [0, 1, 0];

    const box = createSceneObject('box', 1);
    box.dimensions = [2, 4, 2];
    box.transform.position = [0, 5, 0];
    box.transform.rotation = [0, 45, 0];
    box.transform.scale = [1, 2, 1];

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
      scene: { ...createDefaultProject().scene, objects: [floor, box] },
      shots: [shot],
    });
    useProjectStore.setState({ project, selectedShotId: shot.id });

    const result = await snapAgentObjectToFloor({ shotId: shot.id, object: { id: box.id } });
    expect(result.ok).toBe(true);

    const state = getShotEffectiveState(useProjectStore.getState().project, shot.id);
    const grounded = state ? state.objects.find((object) => object.id === box.id) : undefined;
    expect(grounded).toBeTruthy();
    if (!grounded) return;
    const bounds = effectiveObjectWorldAabb(grounded);
    const floorY = identifyFloorY(project, [0, 5, 0]);
    expect(Math.abs(bounds.min[1] - floorY)).toBeLessThan(0.001);
    expect(box.transform.position[1]).toBe(5);
  });

  it('inspects explicitly requested subjects of any object type', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    floor.transform.position = [0, 0, 0];

    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    actor.name = 'Actor';

    const prop = createSceneObject('box', 1);
    prop.name = 'Crate';
    prop.dimensions = [1, 1, 1];
    prop.transform.position = [2, 0.5, 0];

    const behind = createSceneObject('box', 2);
    behind.name = 'Behind';
    behind.dimensions = [1, 1, 1];
    behind.transform.position = [0, 0.5, 12];

    const shot = createShot({ index: 1, camera: {
      position: [0, 1.6, 6],
      target: [0, 1.4, 0],
      fovDegrees: 50,
      aspectRatio: 16 / 9,
      near: 0.1,
      far: 100,
    } });
    const stagedShot = {
      ...shot,
      objectOverrides: updateShotObjectOverrides(shot, prop, {
        transform: { position: [2, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    };
    const project = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, actor, prop, behind] },
      shots: [stagedShot],
    });

    const diagnostics = inspectAgentShotDiagnostics({
      project,
      shot: stagedShot,
      subjectIds: [actor.id, prop.id, behind.id],
    });

    expect(diagnostics.subjects.map((subject) => subject.objectId).sort()).toEqual(
      [actor.id, behind.id, prop.id].sort(),
    );

    const actorDiag = diagnostics.subjects.find((subject) => subject.objectId === actor.id);
    const propDiag = diagnostics.subjects.find((subject) => subject.objectId === prop.id);
    const behindDiag = diagnostics.subjects.find((subject) => subject.objectId === behind.id);

    expect(actorDiag?.screenCoverage ?? 0).toBeGreaterThan(0);
    expect(actorDiag?.humanLandmarks?.eyes).toBeTruthy();
    expect(propDiag?.screenCoverage ?? 0).toBeGreaterThan(0);
    expect(behindDiag?.behindCamera).toBe(true);
    expect(behindDiag?.screenCoverage ?? 1).toBe(0);
  });

  it('reports cropped and occluded metrics for explicit diagnostic subjects', () => {
    const { project, actor, shot } = corridorProject();
    const wall = createSceneObject('wall', 1);
    wall.dimensions = [0.2, 2, 2];
    wall.transform.position = [0.5, 1, 3];

    actor.transform.position = [0, 0.875, 4];
    const stagedShot = {
      ...shot,
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [0, 0.875, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    };
    const nextProject = {
      ...project,
      scene: { ...project.scene, objects: [...project.scene.objects, wall] },
      shots: [stagedShot],
    };

    const diagnostics = inspectAgentShotDiagnostics({
      project: nextProject,
      shot: stagedShot,
      subjectIds: [actor.id, wall.id],
    });

    const actorDiag = diagnostics.subjects.find((subject) => subject.objectId === actor.id);
    const wallDiag = diagnostics.subjects.find((subject) => subject.objectId === wall.id);
    expect(actorDiag).toBeTruthy();
    expect(wallDiag).toBeTruthy();
    expect(actorDiag?.visibleFraction ?? 0).toBeLessThanOrEqual(1);
    expect(wallDiag?.screenCoverage ?? 0).toBeGreaterThan(0);
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

  it('preserves interpolated subject positions when tracking between existing keyframes', async () => {
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
      timeSeconds: 4,
      camera: shot.camera,
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [8, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
      label: 'End',
    });
    useProjectStore.setState({ project: next, selectedShotId: shot.id });

    const expectedStart = sampleShotTimeline(next, shot.id, 1).objectOverrides[actor.id]?.transform?.position;
    const expectedEnd = sampleShotTimeline(next, shot.id, 3).objectOverrides[actor.id]?.transform?.position;
    expect(expectedStart?.[0]).toBeCloseTo(2, 5);
    expect(expectedEnd?.[0]).toBeCloseTo(6, 5);

    const result = await trackAgentSubjects({
      shotId: shot.id,
      subjectIds: [actor.id],
      startTime: 1,
      endTime: 3,
      composition: 'medium',
    });
    expect(result.ok).toBe(true);

    const updatedShot = useProjectStore.getState().project.shots[0]!;
    const keyframes = [...updatedShot.cameraKeyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const trackStart = keyframes.find((keyframe) => (
      Math.abs((keyframe.objectOverrides?.[actor.id]?.transform?.position?.[0] ?? -999) - 2) < 0.01
    ));
    const trackEnd = keyframes.find((keyframe) => (
      Math.abs((keyframe.objectOverrides?.[actor.id]?.transform?.position?.[0] ?? -999) - 6) < 0.01
    ));
    expect(trackStart).toBeTruthy();
    expect(trackEnd).toBeTruthy();
    expect(trackStart?.objectOverrides?.[actor.id]?.transform?.position?.[0]).toBeCloseTo(2, 5);
    expect(trackEnd?.objectOverrides?.[actor.id]?.transform?.position?.[0]).toBeCloseTo(6, 5);
    expect(keyframes.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 1, 3, 4]);
  });

  it('does not rescale existing keyframe timing when tracking within the timeline', async () => {
    const { project, actor, shot } = corridorProject();
    let next = createShotKeyframe(project, shot.id, {
      timeSeconds: 0,
      camera: shot.camera,
      easing: 'easeInOut',
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [0, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
      label: 'Start',
    });
    next = createShotKeyframe(next, shot.id, {
      timeSeconds: 4,
      camera: {
        ...shot.camera,
        position: [1, 1.6, 6],
      },
      easing: 'easeIn',
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [8, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
      label: 'End',
    });
    useProjectStore.setState({ project: next, selectedShotId: shot.id });

    const result = await trackAgentSubjects({
      shotId: shot.id,
      subjectIds: [actor.id],
      startTime: 1,
      endTime: 3,
    });
    expect(result.ok).toBe(true);

    const updatedShot = useProjectStore.getState().project.shots[0]!;
    const keyframes = [...updatedShot.cameraKeyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
    expect(keyframes.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 1, 3, 4]);
    expect(keyframes[0]?.easing).toBe('easeInOut');
    expect(keyframes[3]?.easing).toBe('easeIn');
    expect(keyframes[0]?.objectOverrides?.[actor.id]?.transform?.position?.[0]).toBe(0);
    expect(keyframes[3]?.objectOverrides?.[actor.id]?.transform?.position?.[0]).toBe(8);
    expect(getCameraMoveDurationSeconds(keyframes)).toBeCloseTo(4, 5);
  });

  it('extends the timeline without rescaling when tracking beyond the existing end', async () => {
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
      timeSeconds: 2,
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
      startTime: 1,
      endTime: 5,
    });
    expect(result.ok).toBe(true);

    const keyframes = [...useProjectStore.getState().project.shots[0]!.cameraKeyframes]
      .sort((a, b) => a.timeSeconds - b.timeSeconds);
    expect(keyframes.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 1, 2, 5]);
    expect(getCameraMoveDurationSeconds(keyframes)).toBeCloseTo(5, 5);
  });

  it('reports subject displacement from interpolated timeline states', () => {
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
      timeSeconds: 4,
      camera: shot.camera,
      objectOverrides: updateShotObjectOverrides(shot, actor, {
        transform: { position: [8, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
      label: 'End',
    });

    const diagnostics = inspectAgentShotDiagnostics({ project: next, shot: next.shots[0]! });
    const actorDisplacement = diagnostics.subjectDisplacements.find((item) => item.objectId === actor.id);
    expect(actorDisplacement?.displacementMeters ?? 0).toBeCloseTo(8, 5);
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

  it('separates visible fraction from screen coverage using cropping and occlusion', () => {
    const { project, actor, shot } = corridorProject();
    actor.transform.position = [0, 0.875, 4];
    const telemetry = buildShotCompositionTelemetry({ project, shot });
    const entry = telemetry.subjects.Actor;
    expect(entry).toBeTruthy();
    if (!entry) return;

    const diagnostics = inspectAgentShotDiagnostics({ project, shot });
    const actorDiag = diagnostics.subjects.find((item) => item.objectId === actor.id);
    expect(actorDiag).toBeTruthy();
    if (!actorDiag) return;

    const visibleArea = entry.bounds.visible?.areaCoverage ?? entry.bounds.areaCoverage;
    const unclippedArea = entry.bounds.unclipped?.areaCoverage ?? 0;
    const expected = unclippedArea > 0
      ? Math.max(0, Math.min(1, (visibleArea / unclippedArea) * (1 - (entry.occlusionRatio ?? 0))))
      : 0;

    expect(actorDiag.screenCoverage).toBeCloseTo(visibleArea, 5);
    expect(actorDiag.visibleFraction).toBeCloseTo(expected, 5);
    expect(unclippedArea).toBeGreaterThan(visibleArea);
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
