import type { Vec3 } from '../../domain/types';
import type {
  PrevisCharacterDefinition,
  PrevisProductionManifestV1,
  PrevisShotDefinition,
  PrevisShotMotionKeyframe,
} from './manifest';

/**
 * Prose may safely select native poses only for ForeScene's own mannequin.
 * Imported rigs remain pose-capable for explicit contracts, but topology or a
 * saved rig package alone does not prove that an invented deformation is safe.
 */
export function canInferNativeActionPose(character: PrevisCharacterDefinition | undefined): boolean {
  return character?.type === 'human_dummy';
}

function actionText(shot: PrevisShotDefinition): string {
  return [
    shot.name,
    shot.description,
    ...(shot.requirements?.notes ?? []),
  ].join(' ').toLowerCase();
}

export function isLocomotionAction(shot: PrevisShotDefinition): boolean {
  return /\b(sprint|running|run|chase|flee|pursu(?:e|it|ing))\b/.test(actionText(shot));
}

/**
 * Resolve explicit natural-language action intent to an exact native pose.
 * This is deliberately small and generic: it only handles unambiguous action
 * classes and never overrides a manifest-authored posePreset.
 */
export function inferNativeActionPose(
  shot: PrevisShotDefinition,
  subjectId: string,
  _keyframeIndex?: number,
): string | undefined {
  const text = actionText(shot);
  const hasSubjectMotion = Boolean(shot.motion?.keyframes.some((keyframe) => (
    keyframe.staging?.some((entry) => entry.subject === subjectId && entry.transform?.position)
  )));

  if (hasSubjectMotion && /\b(sprint|running|run|chase|flee|pursu(?:e|it|ing))\b/.test(text)) {
    // A stable contact silhouette remains readable while the authored subject
    // transform supplies locomotion. Alternating endpoint presets can create a
    // destructive in-between on fitted production rigs even when both endpoint
    // poses are individually valid.
    return 'walk-contact-left';
  }
  if (hasSubjectMotion && /\b(walk|walking|march|advance)\b/.test(text)) {
    return 'walk-contact-left';
  }
  if (/\b(defensive stance|guard stance)\b/.test(text)) {
    return 'elbows-bent';
  }
  if (/\b(kneel|kneeling|crouch|crouching)\b/.test(text)) return 'crouching';
  if (/\b(reach|reaching)\b/.test(text)) return 'reaching-right';
  return undefined;
}

/**
 * Imported rigs that cannot safely accept inferred joint deformation can still
 * communicate locomotion with a conservative whole-object orientation. The
 * rotation faces authored travel and applies a local forward lean that stays
 * constant across samples. A side-on tracking camera is what makes that lean
 * readable; yawing toward the lens turns a runner into a guard facing the
 * pursuer.
 */
export function inferRigidLocomotionRotation(
  shot: PrevisShotDefinition,
  subjectId: string,
): Vec3 | undefined {
  if (!isLocomotionAction(shot)) return undefined;
  const travel = subjectTravel(shot, subjectId);
  if (!travel) return undefined;
  const faceYaw = (Math.atan2(travel[0], travel[2]) * 180) / Math.PI;
  return yawThenLocalPitch(faceYaw, RIGID_LOCOMOTION_LEAN_DEGREES);
}

/** Local forward lean after facing travel, in degrees. */
export const RIGID_LOCOMOTION_LEAN_DEGREES = 34;
/** Half-separation applied to stacked chase subjects, in meters. */
export const READABLE_LOCOMOTION_SPREAD_METERS = 0.48;
/** Lateral offset for locomotion, in meters. Stays inside a 4 m corridor. */
export const READABLE_LOCOMOTION_CAMERA_LATERAL_METERS = 1.2;
/** Fraction of authored along-path dolly kept so stills show travel. */
export const READABLE_LOCOMOTION_CAMERA_TRACKING = 0.85;

function normalizeHorizontal(value: Vec3): Vec3 | undefined {
  const length = Math.hypot(value[0], value[2]);
  if (length < 1e-6) return undefined;
  return [value[0] / length, 0, value[2] / length];
}

function subjectTravel(shot: PrevisShotDefinition, subjectId: string): Vec3 | undefined {
  const samples = shot.motion?.keyframes.flatMap((keyframe) => (
    keyframe.staging?.flatMap((entry) => (
      entry.subject === subjectId && entry.transform?.position ? [entry.transform.position] : []
    )) ?? []
  )) ?? [];
  if (samples.length < 2) return undefined;
  return normalizeHorizontal([
    samples[samples.length - 1]![0] - samples[0]![0],
    0,
    samples[samples.length - 1]![2] - samples[0]![2],
  ]);
}

function yawThenLocalPitch(yawDegrees: number, pitchDegrees: number): Vec3 {
  const halfYaw = (yawDegrees * Math.PI) / 360;
  const halfPitch = (pitchDegrees * Math.PI) / 360;
  const qPitch = { x: Math.sin(halfPitch), y: 0, z: 0, w: Math.cos(halfPitch) };
  const qYaw = { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) };
  return quaternionToEulerXyzDegrees(multiplyQuaternions(qYaw, qPitch));
}

function multiplyQuaternions(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quaternionToEulerXyzDegrees(q: { x: number; y: number; z: number; w: number }): Vec3 {
  const xx = q.x * q.x;
  const yy = q.y * q.y;
  const zz = q.z * q.z;
  const m13 = 2 * (q.x * q.z + q.w * q.y);
  const m23 = 2 * (q.y * q.z - q.w * q.x);
  const m33 = 1 - 2 * (xx + yy);
  const m12 = 2 * (q.x * q.y - q.w * q.z);
  const m11 = 1 - 2 * (yy + zz);
  const clamped = Math.max(-1, Math.min(1, m13));
  const eulerY = Math.asin(clamped);
  if (Math.abs(clamped) < 0.9999999) {
    return [
      (Math.atan2(-m23, m33) * 180) / Math.PI,
      (eulerY * 180) / Math.PI,
      (Math.atan2(-m12, m11) * 180) / Math.PI,
    ];
  }
  const m32 = 2 * (q.y * q.z + q.w * q.x);
  const m22 = 1 - 2 * (xx + zz);
  return [
    (Math.atan2(m32, m22) * 180) / Math.PI,
    (eulerY * 180) / Math.PI,
    0,
  ];
}

/**
 * Keep multiple moving subjects readable when an authored tracking camera is
 * nearly collinear with their path. Lateral offset stays bounded. Locomotion
 * cameras also lag the authored along-path dolly so start/mid/end stills are
 * not the same tracked silhouette against a hidden wall.
 */
export function resolveReadableMotionCamera(
  shot: PrevisShotDefinition,
  keyframe: PrevisShotMotionKeyframe,
): PrevisShotMotionKeyframe['camera'] {
  const camera = keyframe.camera;
  if (!camera?.position || !camera.target || shot.camera.subjects.length < 2) return camera;
  const stagedPositions = (keyframe.staging ?? [])
    .filter((entry) => shot.camera.subjects.includes(entry.subject))
    .flatMap((entry) => entry.transform?.position ? [entry.transform.position] : []);
  if (stagedPositions.length < 2) return camera;

  const primary = shot.camera.subjects[0]!;
  const primarySamples = shot.motion?.keyframes.flatMap((sample) => (
    sample.staging?.flatMap((entry) => (
      entry.subject === primary && entry.transform?.position ? [entry.transform.position] : []
    )) ?? []
  )) ?? [];
  const travel = primarySamples.length >= 2
    ? normalizeHorizontal([
      primarySamples[primarySamples.length - 1]![0] - primarySamples[0]![0],
      0,
      primarySamples[primarySamples.length - 1]![2] - primarySamples[0]![2],
    ])
    : undefined;
  const view = normalizeHorizontal([
    camera.target[0] - camera.position[0],
    0,
    camera.target[2] - camera.position[2],
  ]);
  const forward = travel ?? view;
  if (!forward) return camera;
  const lateral: Vec3 = [forward[2], 0, -forward[0]];
  const centroid: Vec3 = stagedPositions.reduce((sum, position, _index, list) => [
    sum[0] + position[0] / list.length,
    sum[1] + position[1] / list.length,
    sum[2] + position[2] / list.length,
  ], [0, 0, 0]);
  const offset: Vec3 = [
    camera.position[0] - centroid[0],
    0,
    camera.position[2] - centroid[2],
  ];
  const lateralDistance = offset[0] * lateral[0] + offset[2] * lateral[2];
  const desired = isLocomotionAction(shot)
    ? READABLE_LOCOMOTION_CAMERA_LATERAL_METERS
    : 1.2;
  let position: Vec3 = camera.position;
  if (Math.abs(lateralDistance) < desired) {
    const sign = lateralDistance < 0 ? -1 : 1;
    const correction = desired * sign - lateralDistance;
    position = [
      camera.position[0] + lateral[0] * correction,
      camera.position[1],
      camera.position[2] + lateral[2] * correction,
    ];
  }
  if (isLocomotionAction(shot)) {
    const first = shot.motion?.keyframes[0]?.camera?.position;
    if (first) {
      const firstAlong = first[0] * forward[0] + first[2] * forward[2];
      const currentAlong = position[0] * forward[0] + position[2] * forward[2];
      const laggedAlong = firstAlong
        + READABLE_LOCOMOTION_CAMERA_TRACKING * (currentAlong - firstAlong);
      const travelDelta = laggedAlong - currentAlong;
      position = [
        position[0] + forward[0] * travelDelta,
        position[1],
        position[2] + forward[2] * travelDelta,
      ];
    }
  }
  if (position[0] === camera.position[0] && position[2] === camera.position[2]) return camera;
  return {
    ...camera,
    position,
  };
}

/**
 * Keep a runner and pursuer from sharing one screen silhouette during
 * locomotion. Offsets are lateral only, bounded, and derived from travel plus
 * the readable tracking camera; authored along-path spacing is preserved.
 */
export function resolveReadableMotionSubjectPosition(
  shot: PrevisShotDefinition,
  keyframe: PrevisShotMotionKeyframe,
  subjectId: string,
): Vec3 | undefined {
  const authored = keyframe.staging?.find((entry) => entry.subject === subjectId)?.transform?.position;
  if (!authored) return undefined;
  if (!isLocomotionAction(shot) || shot.camera.subjects.length < 2) return authored;

  const placed = shot.camera.subjects.flatMap((id) => {
    const position = keyframe.staging?.find((entry) => entry.subject === id)?.transform?.position;
    return position ? [{ id, position }] : [];
  });
  if (placed.length < 2) return authored;

  const travel = subjectTravel(shot, shot.camera.subjects[0]!)
    ?? subjectTravel(shot, placed[0]!.id);
  if (!travel) return authored;
  const lateral: Vec3 = [travel[2], 0, -travel[0]];
  const lateralValues = placed.map((entry) => (
    entry.position[0] * lateral[0] + entry.position[2] * lateral[2]
  ));
  const alreadySeparated = Math.max(...lateralValues) - Math.min(...lateralValues)
    >= READABLE_LOCOMOTION_SPREAD_METERS * (17 / 10);
  if (alreadySeparated) return authored;

  const camera = resolveReadableMotionCamera(shot, keyframe);
  if (!camera?.position) return authored;
  const centroid: Vec3 = placed.reduce((sum, entry, _index, list) => [
    sum[0] + entry.position[0] / list.length,
    0,
    sum[2] + entry.position[2] / list.length,
  ], [0, 0, 0]);
  const cameraLateral = (camera.position[0] - centroid[0]) * lateral[0]
    + (camera.position[2] - centroid[2]) * lateral[2];
  const cameraSide = cameraLateral < 0 ? -1 : 1;
  const ranked = [...placed].sort((left, right) => (
    (left.position[0] * travel[0] + left.position[2] * travel[2])
    - (right.position[0] * travel[0] + right.position[2] * travel[2])
  ));
  const rank = ranked.findIndex((entry) => entry.id === subjectId);
  if (rank < 0) return authored;
  const t = rank / (ranked.length - 1);
  const offset = cameraSide * READABLE_LOCOMOTION_SPREAD_METERS * (1 - 2 * t);
  return [
    authored[0] + lateral[0] * offset,
    authored[1],
    authored[2] + lateral[2] * offset,
  ];
}

export interface DerivedEmbeddedPropIntent {
  propId: string;
  hostSubjectId: string;
  reason: string;
}

/**
 * Materialize explicit "use built-in character geometry" instructions as the
 * existing embedded-prop contract. This avoids authoring duplicate primitives
 * over a saved-rig character while preserving a semantic prop binding.
 */
export function resolveEmbeddedPropIntents(manifest: PrevisProductionManifestV1): {
  manifest: PrevisProductionManifestV1;
  derived: DerivedEmbeddedPropIntent[];
} {
  const derived: DerivedEmbeddedPropIntent[] = [];
  const props = (manifest.props ?? []).map((prop) => {
    if (prop.embeddedIn) return prop;
    const candidates = manifest.shots.flatMap((shot) => {
      if (!(shot.requirements?.visibleProps ?? []).includes(prop.id)) return [];
      const notes = (shot.requirements?.notes ?? []).join(' ').toLowerCase();
      if (!/(built[- ]in character geometry|embedded (?:in|on) (?:the )?character|character[- ]integrated)/.test(notes)) {
        return [];
      }
      const hosts = shot.subjects.filter((subjectId) => manifest.cast.some((cast) => cast.id === subjectId));
      return hosts.length === 1 ? [{ shot, hostSubjectId: hosts[0]! }] : [];
    });
    const uniqueHosts = [...new Set(candidates.map((candidate) => candidate.hostSubjectId))];
    if (uniqueHosts.length !== 1) return prop;
    const hostSubjectId = uniqueHosts[0]!;
    const host = manifest.cast.find((cast) => cast.id === hostSubjectId);
    if (host?.type !== 'imported_character' || host.rigMode !== 'saved-rig') return prop;
    const joint = prop.primitive === 'shield'
      ? 'leftHand' as const
      : prop.primitive === 'sword'
        ? 'rightHand' as const
        : undefined;
    derived.push({
      propId: prop.id,
      hostSubjectId,
      reason: 'Manifest explicitly prefers built-in character geometry and the sole host is a saved-rig character.',
    });
    return {
      ...prop,
      embeddedIn: {
        subject: hostSubjectId,
        ...(joint ? { joint } : {}),
      },
    };
  });
  return {
    manifest: { ...manifest, props },
    derived,
  };
}
