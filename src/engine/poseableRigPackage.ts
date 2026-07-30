import JSZip from 'jszip';
import type {
  AssetRegistry,
  PoseableRigAsset,
  ProjectAsset,
  SceneObject,
} from '../domain/types';
import { BRAND } from '../config/brand';
import { createId } from '../utils/ids';
import { sanitizeAutorigMarkers } from './autorigMarkers';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { getModelAsset, putModelAsset } from './modelAssetStore';
import { normalizePoseableRigAsset } from './poseableRigNormalize';
import { downloadBlob } from './fileTransfers';

/** ForeScene poseable-rig package (zip). Not a universal DCC interchange format. */
export const POSEABLE_RIG_PACKAGE_MIME = 'application/zip';
export const POSEABLE_RIG_PACKAGE_EXTENSION = BRAND.rigExtension;
export const POSEABLE_RIG_PACKAGE_FORMAT = BRAND.rigFormat;
export const POSEABLE_RIG_PACKAGE_VERSION = 2 as const;

/** Pre-rebrand PanoRef rig packages stay importable. */
export const LEGACY_POSEABLE_RIG_PACKAGE_EXTENSION = BRAND.legacyRigExtension;
export const LEGACY_POSEABLE_RIG_PACKAGE_FORMAT = BRAND.legacyRigFormat;
export const LEGACY_POSEABLE_RIG_PACKAGE_VERSION = 1 as const;

export const POSEABLE_RIG_PACKAGE_ACCEPT = [
  POSEABLE_RIG_PACKAGE_EXTENSION,
  LEGACY_POSEABLE_RIG_PACKAGE_EXTENSION,
  'application/zip',
].join(',');

export interface PoseableRigPackageManifest {
  format: typeof POSEABLE_RIG_PACKAGE_FORMAT | typeof LEGACY_POSEABLE_RIG_PACKAGE_FORMAT;
  version: typeof POSEABLE_RIG_PACKAGE_VERSION | typeof LEGACY_POSEABLE_RIG_PACKAGE_VERSION;
  exportedAt: string;
  characterName?: string;
  topologyHash?: string;
  /** Rig metadata without live project asset id remapping. */
  rig: PoseableRigAsset;
  skinFile?: string;
  regionFile?: string;
}

export interface PoseableRigPackageBytes {
  skin?: ArrayBuffer;
  region?: ArrayBuffer;
}

export interface BuiltPoseableRigPackage {
  manifest: PoseableRigPackageManifest;
  bytes: PoseableRigPackageBytes;
  blob: Blob;
  fileName: string;
}

export interface ImportedPoseableRigPackage {
  manifest: PoseableRigPackageManifest;
  rig: PoseableRigAsset;
  skinAsset?: ProjectAsset;
  regionAsset?: ProjectAsset;
}

function isPoseableRigPackageManifest(value: unknown): value is PoseableRigPackageManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Partial<PoseableRigPackageManifest>;
  // Each brand generation pairs its own format id with its own version number;
  // a mismatched pair is not a package this build knows how to read.
  const knownFormat = (raw.format === POSEABLE_RIG_PACKAGE_FORMAT && raw.version === POSEABLE_RIG_PACKAGE_VERSION)
    || (raw.format === LEGACY_POSEABLE_RIG_PACKAGE_FORMAT && raw.version === LEGACY_POSEABLE_RIG_PACKAGE_VERSION);
  return knownFormat && Boolean(raw.rig && typeof raw.rig === 'object');
}

async function readAssetBytes(assetId: string | undefined, assets: AssetRegistry): Promise<ArrayBuffer | undefined> {
  if (!assetId) return undefined;
  const asset = assets.assets[assetId];
  if (!asset?.uri) return undefined;
  if (asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
    const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
    return (await getModelAsset(key)) ?? undefined;
  }
  if (asset.uri.startsWith('data:')) {
    const response = await fetch(asset.uri);
    return response.arrayBuffer();
  }
  return undefined;
}

/** Strip project-local asset ids so the package is remapped on import. */
export function detachPoseableRigForPackage(rig: PoseableRigAsset): PoseableRigAsset {
  const normalized = normalizePoseableRigAsset(rig) ?? rig;
  const next: PoseableRigAsset = {
    ...normalized,
    markers: sanitizeAutorigMarkers(normalized.markers ?? rig.markers),
    skin: normalized.skin
      ? {
        influencesPerVertex: normalized.skin.influencesPerVertex || 4,
        ...(normalized.skin.indices ? { indices: [...normalized.skin.indices] } : {}),
        ...(normalized.skin.weights ? { weights: [...normalized.skin.weights] } : {}),
      }
      : undefined,
  };
  // Region map bytes travel beside the manifest; keep topology metadata for compatibility checks.
  if (rig.regionMap) {
    next.regionMap = {
      version: 1,
      regionAssetId: 'package',
      vertexCount: rig.regionMap.vertexCount,
      topologyHash: rig.regionMap.topologyHash,
      sourceAssetId: 'package',
    };
  }
  delete next.originalSourceAssetId;
  delete next.sourceMeshAssetId;
  delete next.meshAssetId;
  return next;
}

export async function buildPoseableRigPackage(params: {
  rig: PoseableRigAsset;
  assets: AssetRegistry;
  characterName?: string;
}): Promise<BuiltPoseableRigPackage> {
  const detached = detachPoseableRigForPackage(params.rig);
  const skinBytes = await readAssetBytes(params.rig.skin?.skinAssetId, params.assets);
  const regionBytes = await readAssetBytes(params.rig.regionMap?.regionAssetId, params.assets);

  const manifest: PoseableRigPackageManifest = {
    format: POSEABLE_RIG_PACKAGE_FORMAT,
    version: POSEABLE_RIG_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    characterName: params.characterName,
    topologyHash: params.rig.regionMap?.topologyHash,
    rig: detached,
    ...(skinBytes ? { skinFile: 'skin.bin' } : {}),
    ...(regionBytes ? { regionFile: 'region.bin' } : {}),
  };

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  if (skinBytes) zip.file('skin.bin', skinBytes);
  if (regionBytes) zip.file('region.bin', regionBytes);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const safeName = (params.characterName || 'character')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'character';
  return {
    manifest,
    bytes: {
      ...(skinBytes ? { skin: skinBytes } : {}),
      ...(regionBytes ? { region: regionBytes } : {}),
    },
    blob,
    fileName: `${safeName}-rig${POSEABLE_RIG_PACKAGE_EXTENSION}`,
  };
}

export async function exportPoseableRigPackage(params: {
  rig: PoseableRigAsset;
  assets: AssetRegistry;
  characterName?: string;
}): Promise<BuiltPoseableRigPackage> {
  const built = await buildPoseableRigPackage(params);
  downloadBlob(built.blob, built.fileName);
  return built;
}

export async function parsePoseableRigPackageFile(file: File): Promise<ImportedPoseableRigPackage> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) {
    throw new Error('Rig package is missing manifest.json.');
  }
  const manifestJson = JSON.parse(await manifestEntry.async('string')) as unknown;
  if (!isPoseableRigPackageManifest(manifestJson)) {
    throw new Error(
      `Rig package manifest is not a ${BRAND.name} ${POSEABLE_RIG_PACKAGE_EXTENSION} file`
      + ` (legacy ${LEGACY_POSEABLE_RIG_PACKAGE_EXTENSION} packages are also accepted).`,
    );
  }

  const baseRig = normalizePoseableRigAsset(manifestJson.rig);
  if (!baseRig) {
    throw new Error('Rig package contains an invalid poseable rig.');
  }

  const nextRigId = createId('poseable_rig');
  let skinAsset: ProjectAsset | undefined;
  let regionAsset: ProjectAsset | undefined;
  const rig: PoseableRigAsset = {
    ...baseRig,
    id: nextRigId,
  };

  if (manifestJson.skinFile) {
    const skinEntry = zip.file(manifestJson.skinFile);
    if (!skinEntry) throw new Error(`Rig package is missing ${manifestJson.skinFile}.`);
    const skinBytes = await skinEntry.async('arraybuffer');
    const skinAssetId = createId('poseable_skin');
    const key = `poseable-skin-${skinAssetId}`;
    await putModelAsset(key, skinBytes);
    skinAsset = {
      id: skinAssetId,
      name: `${manifestJson.characterName ?? 'Character'} skin`,
      type: 'other',
      uri: `${MODEL_ASSET_URI_PREFIX}${key}`,
      createdAt: new Date().toISOString(),
      metadata: { poseableSkin: true },
    };
    rig.skin = {
      influencesPerVertex: rig.skin?.influencesPerVertex || 4,
      skinAssetId,
    };
  }

  if (manifestJson.regionFile) {
    const regionEntry = zip.file(manifestJson.regionFile);
    if (!regionEntry) throw new Error(`Rig package is missing ${manifestJson.regionFile}.`);
    const regionBytes = await regionEntry.async('arraybuffer');
    const regionAssetId = createId('poseable_region');
    const key = `poseable-region-${regionAssetId}`;
    await putModelAsset(key, regionBytes);
    regionAsset = {
      id: regionAssetId,
      name: `${manifestJson.characterName ?? 'Character'} regions`,
      type: 'other',
      uri: `${MODEL_ASSET_URI_PREFIX}${key}`,
      createdAt: new Date().toISOString(),
      metadata: { poseableRegionMap: true },
    };
    const topologyHash = manifestJson.topologyHash
      ?? baseRig.regionMap?.topologyHash
      ?? 'unknown';
    rig.regionMap = {
      version: 1,
      regionAssetId,
      vertexCount: baseRig.regionMap?.vertexCount ?? 0,
      topologyHash,
      sourceAssetId: 'package-import',
    };
  } else {
    delete rig.regionMap;
  }

  return {
    manifest: manifestJson,
    rig,
    skinAsset,
    regionAsset,
  };
}

/**
 * Apply an imported rig package onto a selected autorigged character.
 * Requires matching topology when both sides publish a topology hash.
 * When importing onto a fresh mesh, pass `meshVertexCount` to gate skin compatibility.
 */
export function canApplyPoseableRigPackage(params: {
  targetRig: PoseableRigAsset;
  imported: ImportedPoseableRigPackage;
  meshVertexCount?: number;
}): { ok: true } | { ok: false; reason: string } {
  const importedHash = params.imported.manifest.topologyHash
    ?? params.imported.rig.regionMap?.topologyHash;
  const targetHash = params.targetRig.regionMap?.topologyHash;
  if (importedHash && targetHash && importedHash !== targetHash) {
    return {
      ok: false,
      reason: 'This rig was built for a different mesh topology. Re-rig this character instead.',
    };
  }
  if (!params.imported.rig.bindMatrices || !params.imported.rig.skin) {
    return {
      ok: false,
      reason: 'This rig package is incomplete (missing bind pose or skin weights).',
    };
  }
  const packageVertexCount = poseableRigPackageVertexCount(params.imported);
  if (
    typeof params.meshVertexCount === 'number'
    && Number.isFinite(params.meshVertexCount)
    && typeof packageVertexCount === 'number'
    && packageVertexCount > 0
    && packageVertexCount !== params.meshVertexCount
  ) {
    return {
      ok: false,
      reason: `This rig was built for a mesh with ${packageVertexCount} vertices, but the imported character has ${params.meshVertexCount}.`,
    };
  }
  return { ok: true };
}

/** Best-effort vertex count from region map or inline skin tables. */
export function poseableRigPackageVertexCount(
  imported: Pick<ImportedPoseableRigPackage, 'rig'>,
): number | undefined {
  const fromRegion = imported.rig.regionMap?.vertexCount;
  if (typeof fromRegion === 'number' && fromRegion > 0) return fromRegion;
  const influences = imported.rig.skin?.influencesPerVertex || 4;
  const indexLen = imported.rig.skin?.indices?.length;
  if (typeof indexLen === 'number' && indexLen > 0 && influences > 0) {
    return Math.floor(indexLen / influences);
  }
  return undefined;
}

/** Read vertex count from a parsed package’s skin binary when region metadata is absent. */
export async function resolvePoseableRigPackageVertexCount(
  imported: ImportedPoseableRigPackage,
): Promise<number | undefined> {
  const quick = poseableRigPackageVertexCount(imported);
  if (typeof quick === 'number') return quick;
  const skinAssetId = imported.rig.skin?.skinAssetId ?? imported.skinAsset?.id;
  if (!skinAssetId || !imported.skinAsset?.uri) return undefined;
  if (!imported.skinAsset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) return undefined;
  const key = imported.skinAsset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
  const bytes = await getModelAsset(key);
  if (!bytes || bytes.byteLength < 24) return undefined;
  const view = new DataView(bytes);
  const version = view.getUint32(0, true);
  if (version !== 1) return undefined;
  const influencesPerVertex = view.getUint32(4, true) || 4;
  const indexCount = view.getUint32(8, true);
  if (influencesPerVertex <= 0 || indexCount <= 0) return undefined;
  return Math.floor(indexCount / influencesPerVertex);
}

/** Merge imported rig data onto the target character’s existing rig identity / source links. */
export function mergeImportedRigOntoTarget(params: {
  targetRig: PoseableRigAsset;
  imported: ImportedPoseableRigPackage;
}): PoseableRigAsset {
  const { targetRig, imported } = params;
  return {
    ...imported.rig,
    id: targetRig.id,
    originalSourceAssetId: targetRig.originalSourceAssetId,
    sourceMeshAssetId: targetRig.sourceMeshAssetId ?? targetRig.originalSourceAssetId,
    meshAssetId: targetRig.meshAssetId,
    orientation: imported.rig.orientation ?? targetRig.orientation,
    restTransform: imported.rig.restTransform ?? targetRig.restTransform,
    generationSettings: imported.rig.generationSettings ?? targetRig.generationSettings,
    requiresRerigging: false,
  };
}

export function isPoseableRigPackageFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(POSEABLE_RIG_PACKAGE_EXTENSION)
    || name.endsWith(LEGACY_POSEABLE_RIG_PACKAGE_EXTENSION)
    || name.endsWith('.zip');
}

export function resolvePoseableRigForObject(
  object: SceneObject | undefined,
  assets: AssetRegistry,
): { rigAsset: ProjectAsset; rig: PoseableRigAsset } | undefined {
  const source = object?.poseableCharacter;
  if (!source || source.kind !== 'autorigged') return undefined;
  const rigAsset = assets.assets[source.assetId];
  const rig = rigAsset?.metadata?.poseableRig;
  if (!rigAsset || !rig) return undefined;
  return { rigAsset, rig };
}
