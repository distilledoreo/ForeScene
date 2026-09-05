import type {
  CameraData,
  LocationProject,
  ProductionConfiguration,
  Shot,
  Vec3,
} from '../domain/types';
import { projectFingerprint } from './agent/planDiff';
import { getSortedCameraKeyframes } from './cameraKeyframes';

export type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

export type Matrix4 = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

export interface GenerativeWorldCameraPrior {
  convention: 'opencv-c2w-y-down-z-forward';
  c2w: Matrix4;
  intrinsicsPixels: Matrix3;
  width: number;
  height: number;
  nearMeters: number;
  farMeters: number;
}

export interface GenerativeWorldViewRequest {
  viewId: string;
  shotId: string;
  timeSeconds: number;
  camera: GenerativeWorldCameraPrior;
  image: {
    path: string;
    format: 'png';
    contentMode: 'clean_plate';
    appearance: 'projected_or_clay';
    status: 'required_not_materialized';
  };
  depth: {
    path: string;
    encoding: 'linear-camera-z';
    format: 'npy-float32';
    status: 'required_not_materialized';
  };
}

export interface GenerativeWorldTrajectory {
  trajectoryId: string;
  shotId: string;
  samples: Array<{
    viewId: string;
    timeSeconds: number;
    c2w: Matrix4;
  }>;
}

export interface GenerativeWorldRequestV1 {
  schemaVersion: 1;
  requestId: string;
  source: {
    projectId: string;
    projectFingerprint: string;
  };
  authority: {
    semanticWorld: 'forescene';
    actionContinuity: 'forescene';
    cinematography: 'forescene';
    generatedEnvironmentAppearance: 'backend';
  };
  coordinateSystem: {
    world: 'right-handed-y-up-meters';
    cameraPrior: 'opencv-c2w-y-down-z-forward';
  };
  semanticWorld: ProductionConfiguration;
  views: GenerativeWorldViewRequest[];
  trajectories: GenerativeWorldTrajectory[];
  target: {
    backendFamily: 'hy-world-2-compatible';
    desiredRepresentations: Array<'mesh' | '3dgs'>;
  };
  compatibility: {
    worldMirrorCameraPrior: 'ready';
    worldMirrorDepthPrior: 'ready';
    worldGenerationInference: 'external_hardware_required';
    blockers: string[];
  };
}

export interface HyWorld2CameraPriorFile {
  num_cameras: number;
  extrinsics: Array<{ camera_id: string; matrix: Matrix4 }>;
  intrinsics: Array<{ camera_id: string; matrix: Matrix3 }>;
}

export interface GenerativeWorldResultV1 {
  schemaVersion: 1;
  requestId: string;
  status: 'completed';
  backend: {
    id: string;
    mock: boolean;
  };
  semanticAuthority: 'forescene';
  cameraAuthority: 'forescene';
  generatedAssets: Array<{
    assetId: string;
    kind: 'mesh' | '3dgs';
    uri: string;
    coordinateSystem: 'right-handed-y-up-meters';
  }>;
  acceptedViewIds: string[];
}

/**
 * Resolve a world-generation plate from semantic production bindings.
 * Every bound object/group is treated as authored dynamic foreground unless it
 * is also owned by a declared location. This covers non-human creatures and
 * multipart props that the legacy people-only clean-plate filter cannot see.
 */
export function resolveGenerativeWorldCleanPlate(
  project: LocationProject,
  shot: Shot,
): { project: LocationProject; shot: Shot; hiddenObjectIds: string[] } {
  const production = project.workflow.production;
  if (!production) return { project, shot, hiddenObjectIds: [] };
  const groups = project.scene.objectGroups ?? {};
  const locationObjectIds = new Set<string>();
  for (const location of Object.values(production.locations)) {
    location.objectIds.forEach((objectId) => locationObjectIds.add(objectId));
    location.objectGroupIds.forEach((groupId) => {
      groups[groupId]?.objectIds.forEach((objectId) => locationObjectIds.add(objectId));
    });
  }
  const candidates = new Set<string>();
  for (const binding of Object.values(production.bindings)) {
    if (binding.kind === 'object') candidates.add(binding.objectId);
    if (binding.kind === 'group') {
      groups[binding.groupId]?.objectIds.forEach((objectId) => candidates.add(objectId));
    }
  }
  const hiddenObjectIds = [...candidates].filter((objectId) => !locationObjectIds.has(objectId));
  if (hiddenObjectIds.length === 0) return { project, shot, hiddenObjectIds };
  const hidden = new Set(hiddenObjectIds);
  return {
    project: {
      ...project,
      scene: {
        ...project.scene,
        objects: project.scene.objects.map((object) => (
          hidden.has(object.id) ? { ...object, visible: false } : object
        )),
      },
    },
    shot: {
      ...shot,
      objectOverrides: Object.fromEntries([
        ...Object.entries(shot.objectOverrides ?? {}),
        ...hiddenObjectIds.map((objectId) => [
          objectId,
          { ...(shot.objectOverrides?.[objectId] ?? {}), visible: false },
        ]),
      ]),
    },
    hiddenObjectIds,
  };
}

export interface GenerativeWorldRequestValidation {
  ok: boolean;
  errors: string[];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(value: Vec3, scalar: number): Vec3 {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-8 ? scale(value, 1 / length) : [0, 0, -1];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** ForeScene/Three camera → OpenCV camera-to-world prior used by WorldMirror 2.0. */
export function cameraToOpenCvPrior(
  camera: CameraData,
  width: number,
  height: number,
): GenerativeWorldCameraPrior {
  const forward = normalize(subtract(camera.target, camera.position));
  const rawRight = cross(forward, [0, 1, 0]);
  const right = Math.hypot(...rawRight) < 1e-8 ? [1, 0, 0] as Vec3 : normalize(rawRight);
  const up = normalize(cross(right, forward));
  const clean = (value: number) => Object.is(value, -0) ? 0 : value;
  const down = scale(up, -1).map(clean) as Vec3;
  const cleanRight = right.map(clean) as Vec3;
  const cleanForward = forward.map(clean) as Vec3;
  const [px, py, pz] = camera.position;
  const focal = height / (2 * Math.tan((camera.fovDegrees * Math.PI) / 360));
  return {
    convention: 'opencv-c2w-y-down-z-forward',
    c2w: [
      [cleanRight[0], down[0], cleanForward[0], px],
      [cleanRight[1], down[1], cleanForward[1], py],
      [cleanRight[2], down[2], cleanForward[2], pz],
      [0, 0, 0, 1],
    ],
    intrinsicsPixels: [
      [focal, 0, width / 2],
      [0, focal, height / 2],
      [0, 0, 1],
    ],
    width,
    height,
    nearMeters: camera.near,
    farMeters: camera.far,
  };
}

function shotSamples(shot: Shot): Array<{ timeSeconds: number; camera: CameraData }> {
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes);
  return keyframes.length > 0
    ? keyframes.map((keyframe) => ({ timeSeconds: keyframe.timeSeconds, camera: keyframe.camera }))
    : [{ timeSeconds: 0, camera: shot.camera }];
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export function createGenerativeWorldRequest(input: {
  project: LocationProject;
  shotIds?: string[];
  desiredRepresentations?: Array<'mesh' | '3dgs'>;
}): GenerativeWorldRequestV1 {
  const selected = input.shotIds?.length
    ? input.project.shots.filter((shot) => input.shotIds!.includes(shot.id))
    : input.project.shots;
  const fingerprint = projectFingerprint(input.project);
  const requestId = `world-${safeSegment(input.project.id)}-${safeSegment(fingerprint.slice(-14))}`;
  const views: GenerativeWorldViewRequest[] = [];
  const trajectories: GenerativeWorldTrajectory[] = [];

  for (const shot of selected) {
    const samples = shotSamples(shot);
    const trajectorySamples: GenerativeWorldTrajectory['samples'] = [];
    samples.forEach((sample, index) => {
      const viewId = `${shot.id}:${sample.timeSeconds.toFixed(3)}`;
      const base = `${safeSegment(shot.productionShotId ?? shot.shotNumber ?? shot.id)}-${String(index).padStart(3, '0')}`;
      const width = shot.exportSettings.width;
      const height = shot.exportSettings.height;
      const camera = cameraToOpenCvPrior(sample.camera, width, height);
      views.push({
        viewId,
        shotId: shot.id,
        timeSeconds: sample.timeSeconds,
        camera,
        image: {
          path: `views/${base}.png`,
          format: 'png',
          contentMode: 'clean_plate',
          appearance: 'projected_or_clay',
          status: 'required_not_materialized',
        },
        depth: {
          path: `depth/${base}.npy`,
          encoding: 'linear-camera-z',
          format: 'npy-float32',
          status: 'required_not_materialized',
        },
      });
      trajectorySamples.push({ viewId, timeSeconds: sample.timeSeconds, c2w: camera.c2w });
    });
    trajectories.push({
      trajectoryId: `trajectory:${shot.id}`,
      shotId: shot.id,
      samples: trajectorySamples,
    });
  }

  return {
    schemaVersion: 1,
    requestId,
    source: { projectId: input.project.id, projectFingerprint: fingerprint },
    authority: {
      semanticWorld: 'forescene',
      actionContinuity: 'forescene',
      cinematography: 'forescene',
      generatedEnvironmentAppearance: 'backend',
    },
    coordinateSystem: {
      world: 'right-handed-y-up-meters',
      cameraPrior: 'opencv-c2w-y-down-z-forward',
    },
    semanticWorld: structuredClone(input.project.workflow.production ?? {
      schemaVersion: 1,
      bindings: {},
      locations: {},
      shotContracts: {},
    }),
    views,
    trajectories,
    target: {
      backendFamily: 'hy-world-2-compatible',
      desiredRepresentations: input.desiredRepresentations ?? ['mesh', '3dgs'],
    },
    compatibility: {
      worldMirrorCameraPrior: 'ready',
      worldMirrorDepthPrior: 'ready',
      worldGenerationInference: 'external_hardware_required',
      blockers: [
        'The HY-World 2.0 reference world-generation pipeline requires CUDA-era acceleration and recommends multiple modern GPUs; it is not a local RX 580 dependency.',
      ],
    },
  };
}

export function createHyWorld2CameraPriorFile(
  request: GenerativeWorldRequestV1,
): HyWorld2CameraPriorFile {
  return {
    num_cameras: request.views.length,
    extrinsics: request.views.map((view) => ({ camera_id: view.viewId, matrix: view.camera.c2w })),
    intrinsics: request.views.map((view) => ({ camera_id: view.viewId, matrix: view.camera.intrinsicsPixels })),
  };
}

export function validateGenerativeWorldRequest(
  request: GenerativeWorldRequestV1,
): GenerativeWorldRequestValidation {
  const errors: string[] = [];
  if (request.views.length === 0) errors.push('At least one camera view is required.');
  const viewIds = new Set<string>();
  for (const view of request.views) {
    if (viewIds.has(view.viewId)) errors.push(`Duplicate view id "${view.viewId}".`);
    viewIds.add(view.viewId);
    const cameraValues = [
      ...view.camera.c2w.flat(),
      ...view.camera.intrinsicsPixels.flat(),
      view.camera.nearMeters,
      view.camera.farMeters,
    ];
    if (cameraValues.some((value) => !Number.isFinite(value))) {
      errors.push(`View "${view.viewId}" contains non-finite camera values.`);
    }
    if (view.camera.width <= 0 || view.camera.height <= 0) {
      errors.push(`View "${view.viewId}" has invalid dimensions.`);
    }
  }
  for (const trajectory of request.trajectories) {
    let previous = -Infinity;
    for (const sample of trajectory.samples) {
      if (!viewIds.has(sample.viewId)) errors.push(`Trajectory references unknown view "${sample.viewId}".`);
      if (sample.timeSeconds < previous) errors.push(`Trajectory "${trajectory.trajectoryId}" is not time ordered.`);
      previous = sample.timeSeconds;
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Hardware-free backend fixture for contract, orchestration, and import tests. */
export function runMockGenerativeWorldBackend(
  request: GenerativeWorldRequestV1,
): GenerativeWorldResultV1 {
  const validation = validateGenerativeWorldRequest(request);
  if (!validation.ok) throw new Error(validation.errors.join(' '));
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    status: 'completed',
    backend: { id: 'forescene-mock-world-v1', mock: true },
    semanticAuthority: 'forescene',
    cameraAuthority: 'forescene',
    generatedAssets: request.target.desiredRepresentations.map((kind) => ({
      assetId: `mock-${request.requestId}-${kind}`,
      kind,
      uri: `mock-world://${request.requestId}/environment.${kind === 'mesh' ? 'glb' : 'ply'}`,
      coordinateSystem: 'right-handed-y-up-meters',
    })),
    acceptedViewIds: request.views.map((view) => view.viewId),
  };
}
