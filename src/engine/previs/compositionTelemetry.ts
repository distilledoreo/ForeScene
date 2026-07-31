/**
 * Per-shot composition telemetry for validation, repair, and Grok feedback.
 */

import type { CameraData, LocationProject, SceneObject, Shot, Vec3 } from '../../domain/types';
import { resolveProjectForShot } from '../shotSceneState';
import type { PrevisShotDefinition } from './manifest';
import {
  buildCameraMatrices,
  projectAabb,
  projectHumanLandmarks,
  sampleSubjectOcclusion,
  type ProjectedBounds,
  type ProjectedPoint,
} from './screenProjection';
import type { HumanLandmark } from './framingProfiles';
import { HUMAN_LANDMARK_HEIGHT } from './framingProfiles';

export interface ShotCompositionSubject {
  bounds: ProjectedBounds;
  landmarks?: Record<string, {
    x: number;
    y: number;
    inFrame: boolean;
  }>;
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

  for (const key of matchKeys) {
    const object = findObjectBySubjectKey(resolved.scene.objects, key, params.subjectNames);
    if (!object || object.visible === false) {
      subjects[key] = {
        bounds: emptySubjectBounds(),
        visible: false,
      };
      continue;
    }
    const aabb = objectWorldAabb(object);
    const bounds = projectAabb(aabb, matrices);
    const heightM = object.dimensions[1] * object.transform.scale[1];
    const floorY = object.transform.position[1] - heightM / 2;
    const isHuman = object.type === 'human_dummy';
    let landmarks: Record<string, { x: number; y: number; inFrame: boolean }> | undefined;
    if (isHuman) {
      const projected = projectHumanLandmarks({
        position: [object.transform.position[0], floorY, object.transform.position[2]],
        height: heightM,
        matrices,
      });
      landmarks = {};
      for (const [name, point] of Object.entries(projected) as Array<[HumanLandmark, ProjectedPoint]>) {
        landmarks[name] = {
          x: point.x / width,
          y: point.y / height,
          inFrame: point.inFrame,
        };
      }
    }

    const solidBlockers = resolved.scene.objects
      .filter((candidate) => (
        SOLID_TYPES.has(candidate.type)
        && candidate.visible !== false
        && candidate.id !== object.id
      ))
      .map((candidate) => {
        const box = objectWorldAabb(candidate);
        return { objectId: candidate.id, min: box.min, max: box.max };
      });

    const samples = isHuman
      ? humanOcclusionSamples(object, floorY, heightM)
      : [{ id: 'center', point: [...object.transform.position] as Vec3 }];

    const occlusion = sampleSubjectOcclusion({
      cameraPosition: shot.camera.position,
      subjectSamples: samples,
      blockers: solidBlockers,
      excludeObjectIds: new Set([object.id]),
    });

    subjects[key] = {
      bounds,
      landmarks,
      visible: !bounds.behindCamera && bounds.areaCoverage > 0.0005,
      occlusionRatio: occlusion.occludedSampleRatio,
      faceOccluded: occlusion.faceOccluded,
    };
  }

  // Also index by object name for any visible humans not already keyed.
  for (const person of people) {
    if (subjects[person.name]) continue;
    const already = Object.values(subjects).some((entry) => (
      entry.landmarks && Math.abs(entry.bounds.centerX - 0.5) < 2
    ));
    if (already) continue;
    // Skip if matched via subject id already.
    const matched = Object.keys(subjects).some((key) => {
      const obj = findObjectBySubjectKey(resolved.scene.objects, key, params.subjectNames);
      return obj?.id === person.id;
    });
    if (matched) continue;

    const aabb = objectWorldAabb(person);
    const bounds = projectAabb(aabb, matrices);
    subjects[person.name] = {
      bounds,
      visible: !bounds.behindCamera && bounds.areaCoverage > 0.0005,
    };
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
  object: SceneObject,
  floorY: number,
  height: number,
): Array<{ id: string; point: Vec3 }> {
  const x = object.transform.position[0];
  const z = object.transform.position[2];
  const halfW = (object.dimensions[0] * object.transform.scale[0]) * 0.35;
  const y = (name: keyof typeof HUMAN_LANDMARK_HEIGHT) => (
    floorY + height * HUMAN_LANDMARK_HEIGHT[name]
  );
  return [
    { id: 'head', point: [x, y('headTop'), z] },
    { id: 'eyes', point: [x, y('eyes'), z] },
    { id: 'chest', point: [x, y('chest'), z] },
    { id: 'waist', point: [x, y('waist'), z] },
    { id: 'center', point: [x, object.transform.position[1], z] },
    { id: 'left', point: [x - halfW, y('chest'), z] },
    { id: 'right', point: [x + halfW, y('chest'), z] },
  ];
}

function emptySubjectBounds(): ProjectedBounds {
  return {
    ndc: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    pixels: { left: 0, top: 0, right: 0, bottom: 0 },
    widthCoverage: 0,
    heightCoverage: 0,
    areaCoverage: 0,
    centerX: 0.5,
    centerY: 0.5,
    clipped: true,
    behindCamera: true,
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
