import type { Vec3 } from '../../domain/types';
import type {
  PrevisProductionManifestV1,
  PrevisShotDefinition,
  PrevisShotMotionKeyframe,
} from './manifest';

function actionText(shot: PrevisShotDefinition): string {
  return [
    shot.name,
    shot.description,
    ...(shot.requirements?.notes ?? []),
  ].join(' ').toLowerCase();
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

function normalizeHorizontal(value: Vec3): Vec3 | undefined {
  const length = Math.hypot(value[0], value[2]);
  if (length < 1e-6) return undefined;
  return [value[0] / length, 0, value[2] / length];
}

/**
 * Keep multiple moving subjects readable when an authored tracking camera is
 * nearly collinear with their path. The correction is lateral only and bounded;
 * timing, height, target, lens, and forward/back tracking remain authored.
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
  // A five-metre lateral baseline keeps a modest depth chase legible in a full
  // shot, while also increasing camera distance enough to protect feet and
  // multipart silhouettes from edge cropping. It remains bounded and changes
  // neither authored timing nor the along-path tracking relationship.
  const desired = 5;
  if (Math.abs(lateralDistance) >= desired) return camera;
  const sign = lateralDistance < 0 ? -1 : 1;
  const correction = desired * sign - lateralDistance;
  return {
    ...camera,
    position: [
      camera.position[0] + lateral[0] * correction,
      camera.position[1],
      camera.position[2] + lateral[2] * correction,
    ],
  };
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
