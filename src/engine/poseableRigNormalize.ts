import type {
  PoseableAxisHint,
  PoseableCharacterOrientation,
  PoseableRegionMapReference,
  PoseableRestTransform,
  PoseableRigAsset,
  PoseableRigGenerationSettings,
  ImportedHumanoidRigBinding,
  Vec3,
} from '../domain/types';
import { HUMAN_JOINT_IDS, normalizeQuaternion } from './humanPose';

export const DEFAULT_POSEABLE_HEIGHT_METERS = 1.75;
export const MIN_POSEABLE_HEIGHT_METERS = 0.5;
export const MAX_POSEABLE_HEIGHT_METERS = 3.5;
/** Bumped whenever canonical fitting/weighting changes invalidate baked rigs. */
export const CURRENT_AUTORIG_RIG_GENERATION_VERSION = 7;
/**
 * Binder algorithm version. V1 = capsule skinning without region constraints.
 * V2 = region-constrained weights. Independent of rigGenerationVersion.
 */
export const CURRENT_AUTORIG_BINDER_VERSION = 2;

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

function normalizeImportedHumanoidRigBinding(value: unknown): ImportedHumanoidRigBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<ImportedHumanoidRigBinding>;
  if (
    raw.version !== 1
    || typeof raw.id !== 'string' || !raw.id
    || typeof raw.sourceAssetId !== 'string' || !raw.sourceAssetId
    || (raw.sourceFormat !== 'glb' && raw.sourceFormat !== 'gltf' && raw.sourceFormat !== 'fbx')
    || (raw.profile !== 'mixamo' && raw.profile !== 'maya-humanik' && raw.profile !== 'generic')
    || typeof raw.hipsBonePath !== 'string' || !raw.hipsBonePath
    || typeof raw.skeletonHash !== 'string' || !raw.skeletonHash
    || typeof raw.restPoseHash !== 'string' || !raw.restPoseHash
  ) return undefined;

  const boneMap: ImportedHumanoidRigBinding['boneMap'] = {};
  if (raw.boneMap && typeof raw.boneMap === 'object') {
    for (const jointId of HUMAN_JOINT_IDS) {
      const path = raw.boneMap[jointId];
      if (typeof path === 'string' && path.trim()) boneMap[jointId] = path;
    }
  }
  const canonicalPoseBases: ImportedHumanoidRigBinding['canonicalPoseBases'] = {};
  if (raw.canonicalPoseBases && typeof raw.canonicalPoseBases === 'object') {
    for (const jointId of HUMAN_JOINT_IDS) {
      const basis = normalizeQuaternion(raw.canonicalPoseBases[jointId]);
      if (basis) canonicalPoseBases[jointId] = basis;
    }
  }
  const orientation = normalizePoseableCharacterOrientation(raw.orientation);
  if (!orientation || !raw.boneMap || Object.keys(boneMap).length === 0) return undefined;
  const coverage = (candidate: unknown): number => (
    typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.min(1, Math.max(0, candidate))
      : 0
  );
  const clips = Array.isArray(raw.sourceAnimationClips)
    ? raw.sourceAnimationClips.flatMap((clip) => {
      if (!clip || typeof clip !== 'object') return [];
      const item = clip as { name?: unknown; durationSeconds?: unknown };
      if (typeof item.name !== 'string' || typeof item.durationSeconds !== 'number' || !Number.isFinite(item.durationSeconds)) return [];
      return [{ name: item.name, durationSeconds: Math.max(0, item.durationSeconds) }];
    })
    : undefined;
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((warning): warning is string => typeof warning === 'string')
    : undefined;
  const approximateHeightMeters = typeof raw.approximateHeightMeters === 'number' && Number.isFinite(raw.approximateHeightMeters)
    ? Math.min(MAX_POSEABLE_HEIGHT_METERS, Math.max(MIN_POSEABLE_HEIGHT_METERS, raw.approximateHeightMeters))
    : DEFAULT_POSEABLE_HEIGHT_METERS;
  return {
    version: 1,
    id: raw.id,
    sourceAssetId: raw.sourceAssetId,
    sourceFormat: raw.sourceFormat,
    profile: raw.profile,
    boneMap,
    canonicalPoseBases,
    skeletonHash: raw.skeletonHash,
    restPoseHash: raw.restPoseHash,
    ...(typeof raw.rootBonePath === 'string' && raw.rootBonePath ? { rootBonePath: raw.rootBonePath } : {}),
    hipsBonePath: raw.hipsBonePath,
    orientation,
    approximateHeightMeters,
    requiredJointCoverage: coverage(raw.requiredJointCoverage),
    optionalJointCoverage: coverage(raw.optionalJointCoverage),
    ...(clips && clips.length > 0 ? { sourceAnimationClips: clips } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

/** Compact region-map reference (labels live in a binary asset). */
export function normalizePoseableRegionMap(value: unknown): PoseableRegionMapReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<PoseableRegionMapReference>;
  if (typeof raw.regionAssetId !== 'string' || !raw.regionAssetId) return undefined;
  if (typeof raw.topologyHash !== 'string' || !raw.topologyHash) return undefined;
  if (typeof raw.sourceAssetId !== 'string' || !raw.sourceAssetId) return undefined;
  const vertexCount = typeof raw.vertexCount === 'number' && Number.isFinite(raw.vertexCount)
    ? Math.max(0, Math.floor(raw.vertexCount))
    : 0;
  return {
    version: 1,
    regionAssetId: raw.regionAssetId,
    vertexCount,
    topologyHash: raw.topologyHash,
    sourceAssetId: raw.sourceAssetId,
  };
}

/** Compact skin on load when binary id is present (legacy dual-storage projects). */
export function normalizePoseableSkin(value: unknown): PoseableRigAsset['skin'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as NonNullable<PoseableRigAsset['skin']>;
  const influences = typeof raw.influencesPerVertex === 'number' && Number.isFinite(raw.influencesPerVertex)
    ? Math.max(1, Math.floor(raw.influencesPerVertex))
    : 4;
  if (typeof raw.skinAssetId === 'string' && raw.skinAssetId) {
    // Binary is authoritative — drop any legacy inline copies immediately.
    return {
      influencesPerVertex: influences,
      skinAssetId: raw.skinAssetId,
    };
  }
  const indices = Array.isArray(raw.indices)
    ? raw.indices.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : undefined;
  const weights = Array.isArray(raw.weights)
    ? raw.weights.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : undefined;
  if (!indices && !weights) {
    return { influencesPerVertex: influences };
  }
  return {
    influencesPerVertex: influences,
    ...(indices ? { indices } : {}),
    ...(weights ? { weights } : {}),
  };
}

/**
 * Strip null/undefined/malformed marker rows from project JSON so Build never
 * crashes on `marker.jointId` when an autorigged character is selected.
 */
export function normalizePoseableMarkers(value: unknown): NonNullable<PoseableRigAsset['markers']> {
  if (!Array.isArray(value)) return [];
  const markers: NonNullable<PoseableRigAsset['markers']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as { id?: unknown; jointId?: unknown; position?: unknown };
    if (typeof raw.jointId !== 'string' || !(HUMAN_JOINT_IDS as readonly string[]).includes(raw.jointId)) continue;
    if (!Array.isArray(raw.position) || raw.position.length < 3) continue;
    const x = Number(raw.position[0]);
    const y = Number(raw.position[1]);
    const z = Number(raw.position[2]);
    if (![x, y, z].every(Number.isFinite)) continue;
    markers.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `marker_${raw.jointId}`,
      jointId: raw.jointId as typeof HUMAN_JOINT_IDS[number],
      position: [x, y, z],
    });
  }
  return markers;
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
    ...(typeof raw.binderVersion === 'number' && Number.isFinite(raw.binderVersion)
      ? { binderVersion: Math.max(0, Math.floor(raw.binderVersion)) }
      : {}),
    ...(raw.requiresRerigging === true
      || (typeof raw.rigGenerationVersion === 'number'
        && raw.rigGenerationVersion < CURRENT_AUTORIG_RIG_GENERATION_VERSION)
      || (typeof raw.binderVersion === 'number'
        && raw.binderVersion < CURRENT_AUTORIG_BINDER_VERSION)
      || (raw.skin && typeof raw.binderVersion !== 'number')
      ? { requiresRerigging: true }
      : {}),
    ...(raw.bindMatrices && typeof raw.bindMatrices === 'object' ? { bindMatrices: raw.bindMatrices } : {}),
    ...(raw.canonicalPoseBases && typeof raw.canonicalPoseBases === 'object'
      ? { canonicalPoseBases: raw.canonicalPoseBases }
      : {}),
    ...(raw.skin && typeof raw.skin === 'object' ? { skin: normalizePoseableSkin(raw.skin) } : {}),
    ...(normalizePoseableRegionMap(raw.regionMap)
      ? { regionMap: normalizePoseableRegionMap(raw.regionMap) }
      : {}),
    ...(Array.isArray(raw.markers) ? { markers: normalizePoseableMarkers(raw.markers) } : {}),
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
    ...(normalizeImportedHumanoidRigBinding(raw.importedRigBinding)
      ? { importedRigBinding: normalizeImportedHumanoidRigBinding(raw.importedRigBinding) }
      : {}),
  };
}

export { normalizeImportedHumanoidRigBinding };
