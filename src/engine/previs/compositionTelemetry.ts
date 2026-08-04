/**
 * Per-shot composition telemetry for validation, repair, and Grok feedback.
 */

import type {
  Bounds3,
  CameraData,
  HumanJointId,
  LocationProject,
  SceneObject,
  Shot,
  Vec3,
} from '../../domain/types';
import { resolveProjectForShot } from '../shotSceneState';
import { HUMAN_JOINT_IDS } from '../humanPose';
import type { PrevisShotDefinition } from './manifest';
import {
  buildCameraMatrices,
  projectAabb,
  projectHumanLandmarks,
  projectWorldPoint,
  projectUpperBodyRegion,
  sampleSubjectOcclusion,
  type ProjectedBounds,
  type ProjectedPoint,
} from './screenProjection';
import type { HumanLandmark } from './framingProfiles';
import { HUMAN_LANDMARK_HEIGHT } from './framingProfiles';
import {
  resolvePoseableHumanoidTelemetry,
  type RigTelemetryLandmarkSource,
  type RigTelemetryPositionKey,
} from './poseableRigTelemetry';

export interface ShotCompositionSubject {
  /** Full-body projected AABB (visible occupancy is frame-clamped). */
  bounds: ProjectedBounds;
  /** Primary anatomical body bounds; accessories are excluded when metadata provides them. */
  bodyBounds?: ProjectedBounds;
  /** Complete imported assembly bounds, retained for crop-safety checks. */
  assemblyBounds?: ProjectedBounds;
  bodyBoundsSource?: AnatomicalBodyBoundsSource;
  bodyCoverage?: number;
  assemblyCoverage?: number;
  /** Projected contact point from the primary body floor, not the environment floor line. */
  footPoint?: { x: number; y: number; inFrame: boolean };
  feetY?: number;
  completeAssemblyInFrame?: boolean;
  /**
   * Head-and-shoulders region — preferred for OTS / close-up occupancy so
   * offscreen legs cannot inflate coverage.
   */
  upperBodyBounds?: ProjectedBounds;
  landmarks?: Record<string, {
    x: number;
    y: number;
    inFrame: boolean;
  }>;
  landmarkSource?: RigTelemetryLandmarkSource;
  landmarkConfidence?: number;
  /** Derived joint anchors are references only and never add visible geometry. */
  attachmentJoints?: HumanJointId[];
  visible: boolean;
  occlusionRatio?: number;
  faceOccluded?: boolean;
}

export interface ShotCompositionBlocker {
  objectId: string;
  projectedArea: number;
  nearCamera: boolean;
}

export interface ShotCompositionTelemetry {
  shotId: string;
  shotNumber?: string;
  frameWidth: number;
  frameHeight: number;
  subjects: Record<string, ShotCompositionSubject>;
  blockers: ShotCompositionBlocker[];
  issues?: string[];
  notes?: string[];
}

export interface HumanoidTelemetryMetadata {
  /** Local-space primary body bounds, excluding attached accessories. */
  primaryBodyBounds?: Bounds3;
  /** Reliable local-space joint positions when an imported rig exposes them. */
  reliableJointPositions?: Partial<Record<RigTelemetryPositionKey, Vec3>>;
  jointsReliable?: boolean;
}

export type AnatomicalBodyBoundsSource =
  | 'explicit_body_mesh'
  | 'evaluated_rig'
  | 'rig_marker'
  | 'bounds_fallback'
  | 'assembly_fallback';

export interface AnatomicalBodyBoundsResolution {
  bounds: Bounds3;
  source: AnatomicalBodyBoundsSource;
}

/** Fallback fractions used only when imported humanoid joint positions are unavailable. */
export const IMPORTED_HUMANOID_LANDMARK_HEIGHT: Record<HumanLandmark, number> = {
  feet: 0,
  knees: 0.28,
  waist: 0.53,
  chest: 0.68,
  shoulders: 0.80,
  chin: 0.85,
  eyes: 0.89,
  headTop: 0.96,
};

const SOLID_TYPES = new Set([
  'wall', 'box', 'column', 'arch', 'doorway', 'stairs', 'terrain_mass', 'background_card',
]);

export function buildShotCompositionTelemetry(params: {
  project: LocationProject;
  shot: Shot;
  definition?: PrevisShotDefinition;
  /** Manifest subject id → display name used when matching objects. */
  subjectNames?: Record<string, string>;
  frameWidth?: number;
  frameHeight?: number;
}): ShotCompositionTelemetry {
  const { project, shot } = params;
  const width = params.frameWidth ?? shot.exportSettings.width ?? 1280;
  const height = params.frameHeight ?? shot.exportSettings.height ?? 720;
  const resolved = resolveProjectForShot(project, shot);
  const matrices = buildCameraMatrices(shot.camera, width, height);

  const subjectIds = params.definition
    ? new Set([
      ...params.definition.camera.subjects,
      ...(params.definition.camera.foregroundSubject
        ? [params.definition.camera.foregroundSubject]
        : []),
      ...(params.definition.requirements?.visibleSubjects ?? []),
      ...params.definition.subjects,
    ])
    : undefined;

  const people = resolved.scene.objects.filter((object) => (
    object.type === 'human_dummy' && object.visible !== false
  ));
  const props = resolved.scene.objects.filter((object) => (
    object.type !== 'human_dummy'
    && object.type !== 'sun_marker'
    && object.visible !== false
  ));

  const subjects: Record<string, ShotCompositionSubject> = {};
  const notes: string[] = [];

  const matchKeys = subjectIds
    ? [...subjectIds]
    : people.map((person) => person.name);

  const indexedObjectIds = new Set<string>();
  const solidBlockersAll = resolved.scene.objects
    .filter((candidate) => (
      SOLID_TYPES.has(candidate.type)
      && candidate.visible !== false
    ))
    .map((candidate) => {
      const box = objectWorldAabb(candidate);
      return { objectId: candidate.id, min: box.min, max: box.max };
    });

  for (const key of matchKeys) {
    const object = findObjectBySubjectKey(resolved.scene.objects, key, params.subjectNames);
    if (!object || object.visible === false) {
      subjects[key] = {
        bounds: emptySubjectBounds(),
        visible: false,
      };
      continue;
    }
    indexedObjectIds.add(object.id);
    subjects[key] = describeSubject(object, matrices, width, height, shot.camera.position, solidBlockersAll, resolved.assets);
  }

  // Index every remaining visible human by name (and id if needed), deduped by object id.
  // Required so unwanted_subject_dominant can see actors outside the declared subject set.
  for (const person of people) {
    if (indexedObjectIds.has(person.id)) continue;
    indexedObjectIds.add(person.id);
    const key = subjects[person.name] ? person.id : person.name;
    subjects[key] = describeSubject(person, matrices, width, height, shot.camera.position, solidBlockersAll, resolved.assets);
  }

  const blockers: ShotCompositionBlocker[] = [];
  for (const object of props) {
    if (!SOLID_TYPES.has(object.type)) continue;
    const bounds = projectAabb(objectWorldAabb(object), matrices);
    if (bounds.behindCamera || bounds.areaCoverage < 0.01) continue;
    const center = object.transform.position;
    const dist = Math.hypot(
      center[0] - shot.camera.position[0],
      center[1] - shot.camera.position[1],
      center[2] - shot.camera.position[2],
    );
    blockers.push({
      objectId: object.id,
      projectedArea: bounds.areaCoverage,
      nearCamera: dist < 2.5,
    });
  }
  blockers.sort((a, b) => b.projectedArea - a.projectedArea);

  return {
    shotId: shot.id,
    shotNumber: shot.shotNumber,
    frameWidth: width,
    frameHeight: height,
    subjects,
    blockers: blockers.slice(0, 12),
    notes: notes.length > 0 ? notes : undefined,
  };
}

/** Project one scene object for composition / diagnostics (any renderable type). */
export function describeSceneObjectComposition(params: {
  project: LocationProject;
  shot: Shot;
  object: SceneObject;
  frameWidth?: number;
  frameHeight?: number;
}): ShotCompositionSubject {
  const width = params.frameWidth ?? params.shot.exportSettings.width ?? 1280;
  const height = params.frameHeight ?? params.shot.exportSettings.height ?? 720;
  const resolved = resolveProjectForShot(params.project, params.shot);
  const matrices = buildCameraMatrices(params.shot.camera, width, height);
  const solidBlockersAll = resolved.scene.objects
    .filter((candidate) => (
      SOLID_TYPES.has(candidate.type)
      && candidate.visible !== false
    ))
    .map((candidate) => {
      const box = objectWorldAabb(candidate);
      return { objectId: candidate.id, min: box.min, max: box.max };
    });
  return describeSubject(
    params.object,
    matrices,
    width,
    height,
    params.shot.camera.position,
    solidBlockersAll,
    resolved.assets,
  );
}

export function objectWorldAabb(object: SceneObject): { min: Vec3; max: Vec3 } {
  const hx = (object.dimensions[0] * object.transform.scale[0]) / 2;
  const hy = (object.dimensions[1] * object.transform.scale[1]) / 2;
  const hz = (object.dimensions[2] * object.transform.scale[2]) / 2;
  const c = object.transform.position;
  return {
    min: [c[0] - hx, c[1] - hy, c[2] - hz],
    max: [c[0] + hx, c[1] + hy, c[2] + hz],
  };
}

function describeSubject(
  object: SceneObject,
  matrices: ReturnType<typeof buildCameraMatrices>,
  width: number,
  height: number,
  cameraPosition: Vec3,
  solidBlockers: Array<{ objectId: string; min: Vec3; max: Vec3 }>,
  assets: LocationProject['assets'],
): ShotCompositionSubject {
  const assemblyAabb = objectWorldAabb(object);
  const isHuman = object.type === 'human_dummy';
  const importedHumanoid = isImportedHumanoid(object);
  const rigTelemetry = importedHumanoid
    ? resolvePoseableHumanoidTelemetry({ object, assets })
    : undefined;
  const bodyResolution = resolveAnatomicalBodyBounds({ object, assets, rigTelemetry });
  const bodyAabb = bodyResolution.bounds;
  const bounds = projectAabb(assemblyAabb, matrices);
  const bodyBounds = projectAabb(bodyAabb, matrices);
  const heightM = object.dimensions[1] * object.transform.scale[1];
  const bodyHeightM = bodyAabb.max[1] - bodyAabb.min[1];
  const bodyFloorY = bodyAabb.min[1];
  const landmarkFractions = importedHumanoid
    ? IMPORTED_HUMANOID_LANDMARK_HEIGHT
    : HUMAN_LANDMARK_HEIGHT;
  const footWorldPoint: Vec3 = [
    (bodyAabb.min[0] + bodyAabb.max[0]) / 2,
    bodyFloorY,
    (bodyAabb.min[2] + bodyAabb.max[2]) / 2,
  ];
  const projectedFoot = projectWorldPoint(footWorldPoint, matrices);
  let landmarks: Record<string, { x: number; y: number; inFrame: boolean }> | undefined;
  let upperBodyBounds: ProjectedBounds | undefined;
  if (isHuman) {
    const floorPos: Vec3 = [footWorldPoint[0], bodyFloorY, footWorldPoint[2]];
    const projected = importedHumanoid
      ? rigTelemetry
        ? projectReliableHumanoidLandmarks(rigTelemetry.positions, matrices)
        : projectBoundsDerivedHumanoidLandmarks(bodyAabb, matrices)
      : projectHumanLandmarks({ position: floorPos, height: bodyHeightM || heightM, matrices });
    landmarks = {};
    for (const [name, point] of Object.entries(projected) as Array<[HumanLandmark, ProjectedPoint]>) {
      landmarks[name] = {
        x: point.x / width,
        y: point.y / height,
        inFrame: point.inFrame,
      };
    }
    upperBodyBounds = projectUpperBodyRegion({
      position: floorPos,
      height: bodyHeightM || heightM,
      width: bodyAabb.max[0] - bodyAabb.min[0],
      depth: bodyAabb.max[2] - bodyAabb.min[2],
      matrices,
      bottomFraction: landmarkFractions.shoulders,
      topFraction: landmarkFractions.headTop,
    });
  }

  const samples = isHuman
    ? humanOcclusionSamples(bodyAabb, bodyFloorY, bodyHeightM || heightM, landmarkFractions)
    : [{ id: 'center', point: [...object.transform.position] as Vec3 }];

  const occlusion = sampleSubjectOcclusion({
    cameraPosition,
    subjectSamples: samples,
    blockers: solidBlockers,
    excludeObjectIds: new Set([object.id]),
  });

  return {
    bounds,
    bodyBounds,
    assemblyBounds: bounds,
    bodyBoundsSource: bodyResolution.source,
    bodyCoverage: bodyBounds.areaCoverage,
    assemblyCoverage: bounds.areaCoverage,
    footPoint: {
      x: projectedFoot.x / width,
      y: projectedFoot.y / height,
      inFrame: projectedFoot.inFrame,
    },
    feetY: projectedFoot.y / height,
    completeAssemblyInFrame: !bounds.behindCamera && !bounds.clipped && bounds.visible.areaCoverage > 0,
    upperBodyBounds,
    landmarks,
    ...(importedHumanoid ? {
      landmarkSource: rigTelemetry?.source ?? 'bounds_fallback',
      landmarkConfidence: rigTelemetry?.confidence ?? 0.35,
      ...(rigTelemetry?.attachmentJoints ? { attachmentJoints: rigTelemetry.attachmentJoints } : {}),
    } : {}),
    visible: !bounds.behindCamera && bounds.areaCoverage > 0.0005,
    occlusionRatio: occlusion.occludedSampleRatio,
    faceOccluded: occlusion.faceOccluded,
  };
}

function isImportedHumanoid(object: SceneObject): boolean {
  const metadata = object.metadata?.humanoidTelemetry;
  return object.type === 'human_dummy' && Boolean(
    object.poseableCharacter
    || object.metadata?.humanoid === true
    || (metadata && typeof metadata === 'object'),
  );
}

function humanoidMetadata(object: SceneObject): HumanoidTelemetryMetadata | undefined {
  const metadata = object.metadata?.humanoidTelemetry;
  return metadata && typeof metadata === 'object'
    ? metadata as HumanoidTelemetryMetadata
    : undefined;
}

export function resolveAnatomicalBodyBounds(params: {
  object: SceneObject;
  assets: LocationProject['assets'];
  rigTelemetry?: ReturnType<typeof resolvePoseableHumanoidTelemetry>;
}): AnatomicalBodyBoundsResolution {
  const explicit = explicitPrimaryBodyBounds(params.object);
  if (explicit) return { bounds: explicit, source: 'explicit_body_mesh' };

  if (
    params.rigTelemetry
    && (params.rigTelemetry.source === 'evaluated_joint' || params.rigTelemetry.source === 'rig_marker')
  ) {
    const rigBounds = bodyBoundsFromRig(params.rigTelemetry.positions);
    if (rigBounds) {
      return {
        bounds: rigBounds,
        source: params.rigTelemetry.source === 'evaluated_joint' ? 'evaluated_rig' : 'rig_marker',
      };
    }
  }

  return {
    bounds: objectWorldAabb(params.object),
    source: isImportedHumanoid(params.object) ? 'assembly_fallback' : 'bounds_fallback',
  };
}

function explicitPrimaryBodyBounds(object: SceneObject): Bounds3 | undefined {
  const objectMetadata = object.metadata;
  const humanoid = humanoidMetadata(object);
  const primaryMesh = objectMetadata?.primaryBodyMesh;
  const candidates: unknown[] = [
    humanoid?.primaryBodyBounds,
    (humanoid as (HumanoidTelemetryMetadata & { primaryBodyMeshBounds?: unknown }) | undefined)?.primaryBodyMeshBounds,
    objectMetadata?.primaryBodyBounds,
    objectMetadata?.primaryBodyMeshBounds,
    primaryMesh && typeof primaryMesh === 'object' ? (primaryMesh as { bounds?: unknown }).bounds : undefined,
  ];
  const local = candidates.find(isBounds3);
  if (!local) return undefined;
  return localBoundsToWorld(object, local);
}

function isBounds3(value: unknown): value is Bounds3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { min?: unknown; max?: unknown };
  return isFiniteVec3(candidate.min) && isFiniteVec3(candidate.max);
}

function isFiniteVec3(value: unknown): value is Vec3 {
  return Array.isArray(value)
    && value.length >= 3
    && value.slice(0, 3).every((entry) => Number.isFinite(Number(entry)));
}

function localBoundsToWorld(object: SceneObject, local: Bounds3): Bounds3 {
  const position = object.transform.position;
  const scale = object.transform.scale;
  const scaledMin: Vec3 = [local.min[0] * scale[0], local.min[1] * scale[1], local.min[2] * scale[2]];
  const scaledMax: Vec3 = [local.max[0] * scale[0], local.max[1] * scale[1], local.max[2] * scale[2]];
  return {
    min: [
      position[0] + Math.min(scaledMin[0], scaledMax[0]),
      position[1] + Math.min(scaledMin[1], scaledMax[1]),
      position[2] + Math.min(scaledMin[2], scaledMax[2]),
    ],
    max: [
      position[0] + Math.max(scaledMin[0], scaledMax[0]),
      position[1] + Math.max(scaledMin[1], scaledMax[1]),
      position[2] + Math.max(scaledMin[2], scaledMax[2]),
    ],
  };
}

function bodyBoundsFromRig(
  positions: Partial<Record<RigTelemetryPositionKey, Vec3>>,
): Bounds3 | undefined {
  const bodyJointIds = HUMAN_JOINT_IDS.filter((jointId) => (
    !jointId.endsWith('End')
    && !jointId.endsWith('Twist')
  ));
  const points = [
    ...bodyJointIds.map((jointId) => positions[jointId]),
    positions.feet,
    positions.headTop,
  ].filter((point): point is Vec3 => {
    if (!point) return false;
    return point.every(Number.isFinite);
  });
  if (points.length < 2) return undefined;

  const min: Vec3 = [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.min(...points.map((point) => point[2])),
  ];
  const max: Vec3 = [
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[2])),
  ];
  const height = Math.max(max[1] - min[1], 0.5);
  const lateralPadding = Math.max(height * 0.025, 0.025);
  const depthPadding = Math.max(height * 0.02, 0.02);
  return {
    min: [min[0] - lateralPadding, min[1], min[2] - depthPadding],
    max: [max[0] + lateralPadding, max[1], max[2] + depthPadding],
  };
}

function projectBoundsDerivedHumanoidLandmarks(
  bodyBounds: Bounds3,
  matrices: ReturnType<typeof buildCameraMatrices>,
): Record<HumanLandmark, ProjectedPoint> {
  const centerX = (bodyBounds.min[0] + bodyBounds.max[0]) / 2;
  const centerZ = (bodyBounds.min[2] + bodyBounds.max[2]) / 2;
  const height = bodyBounds.max[1] - bodyBounds.min[1];
  const result = {} as Record<HumanLandmark, ProjectedPoint>;
  for (const landmark of Object.keys(IMPORTED_HUMANOID_LANDMARK_HEIGHT) as HumanLandmark[]) {
    const y = bodyBounds.min[1] + height * IMPORTED_HUMANOID_LANDMARK_HEIGHT[landmark];
    result[landmark] = projectWorldPoint([centerX, y, centerZ], matrices);
  }
  return result;
}

function projectReliableHumanoidLandmarks(
  positions: Partial<Record<RigTelemetryPositionKey, Vec3>>,
  matrices: ReturnType<typeof buildCameraMatrices>,
): Record<HumanLandmark, ProjectedPoint> {
  const result = {} as Record<HumanLandmark, ProjectedPoint>;
  for (const landmark of Object.keys(IMPORTED_HUMANOID_LANDMARK_HEIGHT) as HumanLandmark[]) {
    const local = positions[landmark];
    if (local) result[landmark] = projectWorldPoint(local, matrices);
  }
  return result;
}

function findObjectBySubjectKey(
  objects: SceneObject[],
  subjectId: string,
  subjectNames?: Record<string, string>,
): SceneObject | undefined {
  const mappedName = subjectNames?.[subjectId];
  const candidates = [mappedName, subjectId].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const exact = objects.find((object) => (
      object.name === candidate
      || object.name.toLowerCase() === candidate.toLowerCase()
      || object.id === candidate
    ));
    if (exact) return exact;
  }
  return objects.find((object) => (
    candidates.some((candidate) => object.name.toLowerCase().includes(candidate.toLowerCase()))
  ));
}

function humanOcclusionSamples(
  bodyBounds: Bounds3,
  floorY: number,
  height: number,
  landmarkFractions: Record<HumanLandmark, number>,
): Array<{ id: string; point: Vec3 }> {
  const x = (bodyBounds.min[0] + bodyBounds.max[0]) / 2;
  const z = (bodyBounds.min[2] + bodyBounds.max[2]) / 2;
  const halfW = (bodyBounds.max[0] - bodyBounds.min[0]) * 0.35;
  const y = (name: keyof typeof HUMAN_LANDMARK_HEIGHT) => (
    floorY + height * landmarkFractions[name]
  );
  return [
    { id: 'head', point: [x, y('headTop'), z] },
    { id: 'eyes', point: [x, y('eyes'), z] },
    { id: 'chest', point: [x, y('chest'), z] },
    { id: 'waist', point: [x, y('waist'), z] },
    { id: 'center', point: [x, floorY + height / 2, z] },
    { id: 'left', point: [x - halfW, y('chest'), z] },
    { id: 'right', point: [x + halfW, y('chest'), z] },
  ];
}

function emptySubjectBounds(): ProjectedBounds {
  const z = {
    widthCoverage: 0,
    heightCoverage: 0,
    areaCoverage: 0,
    centerX: 0.5,
    centerY: 0.5,
    pixels: { left: 0, top: 0, right: 0, bottom: 0 },
  };
  return {
    ndc: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    pixels: z.pixels,
    widthCoverage: 0,
    heightCoverage: 0,
    areaCoverage: 0,
    centerX: 0.5,
    centerY: 0.5,
    clipped: true,
    behindCamera: true,
    unclipped: z,
    visible: z,
  };
}

/** Convenience: landmark screen Y (0 top) if present. */
export function landmarkScreenY(
  subject: ShotCompositionSubject | undefined,
  landmark: string,
): number | undefined {
  const point = subject?.landmarks?.[landmark];
  return point?.y;
}

export function isLandmarkInFrame(
  subject: ShotCompositionSubject | undefined,
  landmark: string,
): boolean {
  return subject?.landmarks?.[landmark]?.inFrame === true;
}
