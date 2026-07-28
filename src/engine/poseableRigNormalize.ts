import type {
  PoseableAxisHint,
  PoseableCharacterOrientation,
  PoseableRestTransform,
  PoseableRigAsset,
  PoseableRigGenerationSettings,
  Vec3,
} from '../domain/types';
import { HUMAN_JOINT_IDS } from './humanPose';

export const DEFAULT_POSEABLE_HEIGHT_METERS = 1.75;
export const MIN_POSEABLE_HEIGHT_METERS = 0.5;
export const MAX_POSEABLE_HEIGHT_METERS = 3.5;

export function defaultPoseableOrientation(): PoseableCharacterOrientation {
  return {
    frontAxis: '+z',
    upAxis: '+y',
    groundLevelMeters: 0,
  };
}

export function normalizePoseableAxisHint(value: unknown, fallback: PoseableAxisHint): PoseableAxisHint {
  if (value === '+x' || value === '-x' || value === '+y' || value === '-y' || value === '+z' || value === '-z') {
    return value;
  }
  return fallback;
}

export function normalizePoseableCharacterOrientation(value: unknown): PoseableCharacterOrientation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<PoseableCharacterOrientation>;
  const ground = typeof raw.groundLevelMeters === 'number' && Number.isFinite(raw.groundLevelMeters)
    ? raw.groundLevelMeters
    : 0;
  return {
    frontAxis: normalizePoseableAxisHint(raw.frontAxis, '+z'),
    upAxis: normalizePoseableAxisHint(raw.upAxis, '+y'),
    groundLevelMeters: ground,
  };
}

export function normalizePoseableRestTransform(value: unknown): PoseableRestTransform | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<PoseableRestTransform>;
  const asVec3 = (candidate: unknown, fallback: Vec3): Vec3 => {
    if (!Array.isArray(candidate) || candidate.length < 3) return fallback;
    const x = Number(candidate[0]);
    const y = Number(candidate[1]);
    const z = Number(candidate[2]);
    if (![x, y, z].every(Number.isFinite)) return fallback;
    return [x, y, z];
  };
  return {
    position: asVec3(raw.position, [0, 0, 0]),
    rotation: asVec3(raw.rotation, [0, 0, 0]),
    scale: asVec3(raw.scale, [1, 1, 1]),
  };
}

export function normalizePoseableRigGenerationSettings(value: unknown): PoseableRigGenerationSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<PoseableRigGenerationSettings>;
  const height = typeof raw.approximateHeightMeters === 'number' && Number.isFinite(raw.approximateHeightMeters)
    ? Math.min(MAX_POSEABLE_HEIGHT_METERS, Math.max(MIN_POSEABLE_HEIGHT_METERS, raw.approximateHeightMeters))
    : DEFAULT_POSEABLE_HEIGHT_METERS;
  const poseHint = raw.poseHint === 't-pose' || raw.poseHint === 'a-pose' ? raw.poseHint : undefined;
  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((note): note is string => typeof note === 'string')
    : undefined;
  return {
    approximateHeightMeters: height,
    ...(poseHint ? { poseHint } : {}),
    ...(notes && notes.length > 0 ? { notes } : {}),
  };
}

export function normalizePoseableRigAsset(value: unknown): PoseableRigAsset | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<PoseableRigAsset>;
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  const skeletonJoints = Array.isArray(raw.skeletonJoints)
    ? raw.skeletonJoints.filter((id): id is typeof HUMAN_JOINT_IDS[number] => (
      typeof id === 'string' && (HUMAN_JOINT_IDS as readonly string[]).includes(id)
    ))
    : [...HUMAN_JOINT_IDS];
  return {
    version: 1,
    id: raw.id,
    skeletonJoints: skeletonJoints.length > 0 ? skeletonJoints : [...HUMAN_JOINT_IDS],
    ...(typeof raw.meshAssetId === 'string' ? { meshAssetId: raw.meshAssetId } : {}),
    ...(typeof raw.sourceMeshAssetId === 'string' ? { sourceMeshAssetId: raw.sourceMeshAssetId } : {}),
    ...(typeof raw.originalSourceAssetId === 'string' ? { originalSourceAssetId: raw.originalSourceAssetId } : {}),
    ...(typeof raw.rigGenerationVersion === 'number' ? { rigGenerationVersion: raw.rigGenerationVersion } : {}),
    ...(raw.bindMatrices && typeof raw.bindMatrices === 'object' ? { bindMatrices: raw.bindMatrices } : {}),
    ...(raw.skin && typeof raw.skin === 'object' ? { skin: raw.skin } : {}),
    ...(Array.isArray(raw.markers) ? { markers: raw.markers } : {}),
    ...(normalizePoseableCharacterOrientation(raw.orientation)
      ? { orientation: normalizePoseableCharacterOrientation(raw.orientation) }
      : {}),
    ...(normalizePoseableRestTransform(raw.restTransform)
      ? { restTransform: normalizePoseableRestTransform(raw.restTransform) }
      : {}),
    ...(normalizePoseableRigGenerationSettings(raw.generationSettings)
      ? { generationSettings: normalizePoseableRigGenerationSettings(raw.generationSettings) }
      : {}),
    ...(raw.correctionMetadata && typeof raw.correctionMetadata === 'object'
      ? { correctionMetadata: raw.correctionMetadata }
      : {}),
  };
}
