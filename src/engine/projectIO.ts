import { Euler, LocationProject, PanoReference, ProjectAsset, SceneObject, Shot, Transform, Vec3 } from '../domain/types';
import { isProjectBackupFileName, projectDownloadFileName } from '../config/brand';
import { normalizeProductionShotId } from '../domain/shotIdentity';
import {
  DEFAULT_CAMERA_HEIGHT_METERS,
  normalizeProjectSettings,
  normalizeProjectWorkflow,
  normalizeShotExportSettings,
} from '../domain/defaults';
import { ensureProjectExportConfiguration } from './exportConfiguration';
import { normalizeHumanPose, normalizePoseableCharacterSource } from './humanPose';
import { normalizePoseableRigAsset } from './poseableRigNormalize';
import { hydrateAutoriggedCharactersFromAssets } from './autoriggedPoseableCharacter';
import { hydrateImportedRiggedCharactersFromAssets } from './importedRiggedPoseableCharacter';
import { stripInlineSkinArraysFromRig } from './autorigSkinWeights';
import type { PoseableRigAsset } from '../domain/types';
import JSZip from 'jszip';
import { digestFromRecoveryResourceKey, sha256Digest, verifyBinaryDigest } from './binaryIntegrity';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { dataUrlToBlob, readFileAsText } from './fileTransfers';
import { pruneUnreferencedProjectAssets } from './projectAssets';
import { getModelAsset, putModelAssets } from './modelAssetStore';
import {
  PROJECT_ASSET_URI_PREFIX,
  getProjectAssetBlob,
  putProjectAssetBlobs,
  registerProjectAssetBlob,
  resolveProjectAssetUri,
} from './projectAssetStore';
import {
  CURRENT_SCHEMA_VERSION,
  migrateProjectToCurrent,
  stripEphemeralKeyframePreviewUris,
} from './schemaMigrations';

const PROJECT_MANIFEST = 'project.json';
const PROJECT_INTEGRITY = 'integrity.json';
const DEFAULT_SCENE_PANO_ORIGIN: Vec3 = [0, DEFAULT_CAMERA_HEIGHT_METERS, 0];
const DEFAULT_SCENE_PANO_ROTATION: Euler = [0, 0, 0];

export function serializeProject(project: LocationProject): string {
  return JSON.stringify(createPortableProject(project), null, 2);
}

function createPortableProject(project: LocationProject): LocationProject {
  const withExportConfig = ensureProjectExportConfiguration(project);
  const withoutEphemeral = stripEphemeralKeyframePreviewUris(withExportConfig);
  const portable = structuredClone(pruneUnreferencedProjectAssets(withoutEphemeral));
  portable.schemaVersion = CURRENT_SCHEMA_VERSION;
  portable.productVersion = portable.productVersion ?? '0.1.0';
  for (const asset of Object.values(portable.assets.assets)) {
    // Keep inline data URLs until package staging extracts them. Pure migrations
    // may assign a planned storageKey without having written binary storage yet.
    if (asset.storageKey && !asset.uri.startsWith('data:')) {
      asset.uri = `${PROJECT_ASSET_URI_PREFIX}${asset.storageKey}`;
    }
    // Binary skin is the source of truth — never re-embed vertex weight tables.
    if (asset.type === 'poseable_rig') {
      const rig = asset.metadata?.poseableRig as PoseableRigAsset | undefined;
      if (rig) {
        const compact = stripInlineSkinArraysFromRig(rig);
        if (compact !== rig) {
          asset.metadata = {
            ...asset.metadata,
            poseableRig: compact,
          };
        }
      }
    }
  }
  return portable;
}

function storageKeyForAsset(project: LocationProject, asset: ProjectAsset): string {
  return asset.storageKey ?? `project/${project.id}/asset/${asset.id}`;
}

function isRasterOrVideoAsset(asset: ProjectAsset): boolean {
  return asset.type === 'image' || asset.type === 'video';
}

function portableStorageKey(asset: ProjectAsset): string | undefined {
  if (asset.storageKey) return asset.storageKey;
  return asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
    ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
    : undefined;
}

/** Convert older in-manifest base64 raster/video assets into package entries. */
function migratePortableInlineProjectAssets(project: LocationProject): Map<string, Blob> {
  const migrated = new Map<string, Blob>();
  for (const asset of Object.values(project.assets.assets)) {
    if (!isRasterOrVideoAsset(asset) || !asset.uri.startsWith('data:')) continue;
    const storageKey = storageKeyForAsset(project, asset);
    const blob = dataUrlToBlob(asset.uri);
    migrated.set(storageKey, blob);
    registerProjectAssetBlob(storageKey, blob);
    asset.storageKey = storageKey;
    asset.uri = `${PROJECT_ASSET_URI_PREFIX}${storageKey}`;
  }
  return migrated;
}

async function hydrateProjectAssetUris(project: LocationProject): Promise<LocationProject> {
  const writes: Array<{ key: string; blob: Blob }> = [];
  for (const asset of Object.values(project.assets.assets)) {
    if (!isRasterOrVideoAsset(asset)) continue;
    if (asset.uri.startsWith('data:')) {
      const storageKey = storageKeyForAsset(project, asset);
      writes.push({ key: storageKey, blob: dataUrlToBlob(asset.uri) });
      asset.storageKey = storageKey;
      asset.uri = `${PROJECT_ASSET_URI_PREFIX}${storageKey}`;
      continue;
    }
    const storageKey = portableStorageKey(asset);
    if (storageKey) asset.storageKey = storageKey;
  }
  await putProjectAssetBlobs(writes);

  for (const asset of Object.values(project.assets.assets)) {
    if (!isRasterOrVideoAsset(asset) || !asset.storageKey) continue;
    const uri = await resolveProjectAssetUri(asset);
    if (!uri) throw new Error(`Project package is missing binary asset ${asset.name}.`);
    asset.uri = uri;
  }
  return project;
}

export function parseProject(json: string): LocationProject {
  let parsed: LocationProject;
  try {
    parsed = JSON.parse(json) as LocationProject;
  } catch {
    throw new Error('Invalid project file: not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid project file.');
  }
  if (typeof parsed.schemaVersion !== 'string') {
    throw new Error('Invalid project file: missing schemaVersion.');
  }
  if (!parsed.scene || typeof parsed.scene !== 'object') {
    throw new Error('Invalid project file: missing scene.');
  }
  if (!Array.isArray(parsed.scene.objects)) {
    throw new Error('Invalid project file: scene.objects must be an array.');
  }
  if (!parsed.assets || typeof parsed.assets !== 'object' || !parsed.assets.assets) {
    throw new Error('Invalid project file: missing assets.');
  }
  if (!Array.isArray(parsed.shots)) {
    throw new Error('Invalid project file: shots must be an array.');
  }
  if (!Array.isArray(parsed.panoRefs)) {
    throw new Error('Invalid project file: panoRefs must be an array.');
  }
  try {
    const normalized: LocationProject = {
      ...parsed,
      scene: {
        ...parsed.scene,
        objects: parsed.scene.objects.map(normalizeSceneObject),
        panoOrigin: normalizeVec3(parsed.scene.panoOrigin, DEFAULT_SCENE_PANO_ORIGIN),
        // Pre-multi-origin projects omit scene.panoRotation; default identity so origin gizmos work.
        panoRotation: normalizeEuler(parsed.scene.panoRotation, DEFAULT_SCENE_PANO_ROTATION),
      },
      panoRefs: parsed.panoRefs.map(normalizePanoReference),
      shots: parsed.shots.map(normalizeShot),
      landmarks: Array.isArray(parsed.landmarks) ? parsed.landmarks : [],
      settings: normalizeProjectSettings(parsed.settings),
      workflow: normalizeProjectWorkflow(parsed.workflow),
      assets: {
        ...parsed.assets,
        assets: normalizeProjectAssets(parsed.assets.assets),
      },
    };
    const migrated = ensureProjectExportConfiguration(migrateProjectToCurrent(normalized));
    hydrateAutoriggedCharactersFromAssets(migrated.assets);
    hydrateImportedRiggedCharactersFromAssets(migrated.assets);
    return migrated;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Invalid project file: ${error.message}`
        : 'Invalid project file.',
    );
  }
}

function normalizeVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return [...fallback] as Vec3;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (![x, y, z].every(Number.isFinite)) return [...fallback] as Vec3;
  return [x, y, z];
}

function normalizeEuler(value: unknown, fallback: Euler): Euler {
  return normalizeVec3(value, fallback) as Euler;
}

function normalizeSceneObject(object: SceneObject & { projectionStamp?: unknown }): SceneObject {
  const { projectionStamp: _ignored, ...normalized } = object;
  const surfaceStyle = normalized.surfaceStyle === 'solid' || normalized.surfaceStyle === 'checkerboard'
    ? normalized.surfaceStyle
    : normalized.surfaceStyle === 'default'
      ? 'default'
      : undefined;
  return {
    ...normalized,
    stagingRole: normalizeStagingRole(normalized.stagingRole, normalized.type),
    surfaceStyle,
    color: normalizeHexColor(normalized.color),
    secondaryColor: normalizeHexColor(normalized.secondaryColor),
    poseableCharacter: normalizePoseableCharacterSource(normalized.poseableCharacter, normalized.type),
    humanPose: normalizeHumanPose(normalized.humanPose),
  };
}

function normalizeProjectAssets(
  assets: Record<string, ProjectAsset>,
): Record<string, ProjectAsset> {
  const next: Record<string, ProjectAsset> = {};
  for (const [id, asset] of Object.entries(assets)) {
    if (asset.type === 'poseable_rig') {
      const poseableRig = normalizePoseableRigAsset(asset.metadata?.poseableRig);
      next[id] = {
        ...asset,
        metadata: {
          ...asset.metadata,
          ...(poseableRig ? { poseableRig } : {}),
        },
      };
      continue;
    }
    next[id] = asset;
  }
  return next;
}

function normalizeStagingRole(
  value: unknown,
  type: SceneObject['type'],
): SceneObject['stagingRole'] {
  if (value === 'set' || value === 'prop' || value === 'person') return value;
  return type === 'human_dummy' ? 'person' : 'set';
}

function normalizeHexColor(value?: string): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  return undefined;
}

function normalizePanoReference(pano: PanoReference): PanoReference {
  return {
    ...pano,
    rotation: pano.rotation ?? [0, 0, 0],
  };
}

function normalizeTransform(value: unknown): Transform | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<Transform>;
  return {
    position: normalizeVec3(candidate.position, [0, 0, 0]),
    rotation: normalizeEuler(candidate.rotation, [0, 0, 0]),
    scale: normalizeVec3(candidate.scale, [1, 1, 1]),
  };
}

function normalizeShotObjectOverrides(value: unknown): NonNullable<Shot['objectOverrides']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: NonNullable<Shot['objectOverrides']> = {};
  for (const [objectId, rawOverride] of Object.entries(value as Record<string, unknown>)) {
    if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) continue;
    const candidate = rawOverride as { transform?: unknown; visible?: unknown; humanPose?: unknown };
    const transform = normalizeTransform(candidate.transform);
    const visible = typeof candidate.visible === 'boolean' ? candidate.visible : undefined;
    const humanPose = normalizeHumanPose(candidate.humanPose);
    if (!transform && visible === undefined && !humanPose) continue;
    result[objectId] = {
      ...(transform ? { transform } : {}),
      ...(visible !== undefined ? { visible } : {}),
      ...(humanPose ? { humanPose } : {}),
    };
  }
  return result;
}

function normalizeShot(shot: Shot): Shot {
  const legacyExportSettings = shot.exportSettings as Shot['exportSettings'] & {
    includeContinuityControlView?: boolean;
    includeSkinnedFrame?: boolean;
    includeCameraMoveVideo?: boolean;
    includeCameraMoveReferenceFrames?: boolean;
    includeProjectedViewport?: boolean;
    includeProjectedCameraMoveReferenceFrames?: boolean;
    includeProjectedCameraMoveVideo?: boolean;
  };
  const legacyAssets = shot.assets as Shot['assets'] & { skinnedFrameAssetId?: string };
  const { includeContinuityControlView: _ignored, includeSkinnedFrame: _ignoredSkinned, ...exportSettings } = legacyExportSettings;
  return {
    ...shot,
    productionShotId: normalizeProductionShotId(shot.productionShotId),
    cameraKeyframes: (shot.cameraKeyframes ?? []).map((keyframe) => ({
      ...keyframe,
      easing: keyframe.easing === 'easeIn'
        || keyframe.easing === 'easeOut'
        || keyframe.easing === 'easeInOut'
        ? keyframe.easing
        : 'linear',
      objectOverrides: normalizeShotObjectOverrides(keyframe.objectOverrides),
    })),
    objectOverrides: normalizeShotObjectOverrides(shot.objectOverrides),
    exportSettings: normalizeShotExportSettings({
      ...exportSettings,
      peopleExportMode: legacyExportSettings.peopleExportMode,
      characterPass: legacyExportSettings.characterPass,
      includeAiResultFrame: legacyExportSettings.includeAiResultFrame ?? legacyExportSettings.includeSkinnedFrame ?? true,
      includeCameraMoveVideo: legacyExportSettings.includeCameraMoveVideo ?? true,
      includeCameraMoveReferenceFrames: legacyExportSettings.includeCameraMoveReferenceFrames ?? true,
      includeProjectedViewport: legacyExportSettings.includeProjectedViewport ?? true,
      includeProjectedCameraMoveReferenceFrames:
        legacyExportSettings.includeProjectedCameraMoveReferenceFrames ?? true,
      includeProjectedCameraMoveVideo:
        legacyExportSettings.includeProjectedCameraMoveVideo ?? true,
      depth: legacyExportSettings.depth,
    }),
    exportOverrides: shot.exportOverrides,
    assets: {
      ...shot.assets,
      aiResultFrameAssetId: shot.assets.aiResultFrameAssetId ?? legacyAssets.skinnedFrameAssetId ?? shot.assets.finalBaseFrameAssetId,
    },
  };
}

export async function createProjectPackage(project: LocationProject): Promise<Blob> {
  const portable = createPortableProject(project);
  const migratedProjectAssetBlobs = migratePortableInlineProjectAssets(portable);
  const migratedBytes = new Map<string, ArrayBuffer>();
  const legacyPrefix = 'data:application/vnd.panoref.graybox-mesh;base64,';
  for (const asset of Object.values(portable.assets.assets)) {
    if (asset.type !== 'model' || !asset.uri.startsWith(legacyPrefix)) continue;
    const key = `legacy/${portable.id}/${asset.id}`;
    const decoded = atob(asset.uri.slice(legacyPrefix.length));
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0)).buffer;
    migratedBytes.set(key, bytes);
    asset.uri = `${MODEL_ASSET_URI_PREFIX}${key}`;
  }
  const binaryAssets = Object.values(portable.assets.assets).filter((asset) => asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX));
  const storedProjectAssets = Object.values(portable.assets.assets)
    .filter((asset) => isRasterOrVideoAsset(asset) && portableStorageKey(asset));
  // Always emit a ZIP `.fsp` package — even asset-free projects — so downloads use one extension.
  const zip = new JSZip();
  zip.file(PROJECT_MANIFEST, serializeProject(portable));
  const integrity: ProjectPackageIntegrity = { version: 1, entries: {} };
  for (const asset of binaryAssets) {
    const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
    const bytes = migratedBytes.get(key) ?? await getModelAsset(key);
    if (!bytes) throw new Error(`Cannot save project: binary model asset ${asset.name} is missing.`);
    const path = `model-assets/${encodeURIComponent(key)}.bin`;
    integrity.entries[path] = { sha256: await sha256Digest(bytes), byteLength: bytes.byteLength };
    zip.file(path, bytes);
  }
  for (const asset of storedProjectAssets) {
    const key = portableStorageKey(asset);
    if (!key) continue;
    const blob = migratedProjectAssetBlobs.get(key) ?? await getProjectAssetBlob(key);
    if (!blob) throw new Error(`Cannot save project: binary asset ${asset.name} is missing.`);
    const bytes = await blob.arrayBuffer();
    const path = `project-assets/${encodeURIComponent(key)}.bin`;
    integrity.entries[path] = { sha256: await sha256Digest(bytes), byteLength: bytes.byteLength };
    zip.file(path, bytes);
  }
  zip.file(PROJECT_INTEGRITY, JSON.stringify(integrity));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

interface ProjectPackageIntegrity {
  version: 1;
  entries: Record<string, { sha256: string; byteLength: number }>;
}

interface ValidatedProjectFileContents {
  project: LocationProject;
  isPackage: boolean;
  modelWrites: Array<{ key: string; bytes: ArrayBuffer }>;
  projectAssetWrites: Array<{ key: string; blob: Blob }>;
}

function assertNonEmptyBinary(name: string, byteLength: number): void {
  if (byteLength <= 0) throw new Error(`Project package contains an empty binary asset ${name}.`);
}

async function readPackageIntegrity(zip: JSZip): Promise<ProjectPackageIntegrity | undefined> {
  const entry = zip.file(PROJECT_INTEGRITY);
  if (!entry) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await entry.async('text'));
  } catch {
    throw new Error('Project package has invalid binary integrity metadata.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Project package has invalid binary integrity metadata.');
  const candidate = parsed as Partial<ProjectPackageIntegrity>;
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== 'object') {
    throw new Error('Project package has unsupported binary integrity metadata.');
  }
  return candidate as ProjectPackageIntegrity;
}

async function validatePackagedBinary(
  name: string,
  key: string,
  path: string,
  bytes: ArrayBuffer,
  integrity?: ProjectPackageIntegrity,
): Promise<void> {
  assertNonEmptyBinary(name, bytes.byteLength);
  const declared = integrity?.entries[path];
  if (integrity && !declared) throw new Error(`Project package is missing integrity metadata for binary asset ${name}.`);
  if (declared && declared.byteLength !== bytes.byteLength) {
    throw new Error(`Project package binary asset ${name} has an unexpected byte length.`);
  }
  const expectedSha256 = declared?.sha256 ?? digestFromRecoveryResourceKey(key);
  // Legacy packages without an integrity manifest remain importable when they
  // have no content-addressed key. Newly generated backups always take the
  // SHA-256 path above and reject same-length corruption.
  if (expectedSha256) await verifyBinaryDigest(bytes, expectedSha256, `Project package binary asset ${name}`);
}

function createImportNamespace(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function importedPayloadKey(projectId: string, importNamespace: string, kind: 'asset' | 'model', sourceKey: string): string {
  return `import/${projectId}/${importNamespace}/${kind}/${encodeURIComponent(sourceKey)}`;
}

async function inspectProjectFile(file: File): Promise<ValidatedProjectFileContents> {
  // Packaged backups (.fsp / legacy .forescene-project / .panoref-project / .zip) carry
  // binaries; anything else is read as a plain project JSON manifest.
  if (!isProjectBackupFileName(file.name)) {
    const project = parseProject(await file.text());
    for (const asset of Object.values(project.assets.assets)) {
      if (isRasterOrVideoAsset(asset) && asset.uri.startsWith('data:')) {
        assertNonEmptyBinary(asset.name, dataUrlToBlob(asset.uri).size);
        continue;
      }
      if (isRasterOrVideoAsset(asset) && portableStorageKey(asset)) {
        throw new Error(`Project JSON references local binary asset ${asset.name}. Import its portable project backup instead.`);
      }
      if (asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
        throw new Error(`Project JSON references local model asset ${asset.name}. Import its portable project backup instead.`);
      }
    }
    return { project, isPackage: false, modelWrites: [], projectAssetWrites: [] };
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifest = zip.file(PROJECT_MANIFEST);
  if (!manifest) throw new Error(`Invalid project package: missing ${PROJECT_MANIFEST}.`);
  const project = parseProject(await manifest.async('text'));
  const integrity = await readPackageIntegrity(zip);
  const modelWrites = await Promise.all(
    Object.values(project.assets.assets)
      .filter((asset) => asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX))
      .map(async (asset) => {
        const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
        const path = `model-assets/${encodeURIComponent(key)}.bin`;
        const entry = zip.file(path);
        if (!entry) throw new Error(`Project package is missing binary model asset ${asset.name}.`);
        const bytes = await entry.async('arraybuffer');
        await validatePackagedBinary(asset.name, key, path, bytes, integrity);
        return { key, bytes };
      }),
  );
  const projectAssetWrites = await Promise.all(
    Object.values(project.assets.assets)
      .filter((asset) => isRasterOrVideoAsset(asset) && portableStorageKey(asset))
      .map(async (asset) => {
        const key = portableStorageKey(asset);
        if (!key) throw new Error(`Project package is missing binary asset ${asset.name}.`);
        const path = `project-assets/${encodeURIComponent(key)}.bin`;
        const entry = zip.file(path);
        if (!entry) throw new Error(`Project package is missing binary asset ${asset.name}.`);
        const bytes = await entry.async('arraybuffer');
        await validatePackagedBinary(asset.name, key, path, bytes, integrity);
        asset.storageKey = key;
        return { key, blob: new Blob([bytes], { type: asset.mimeType }) };
      }),
  );
  return { project, isPackage: true, modelWrites, projectAssetWrites };
}

/** Parse and verify a backup before any project state or local storage is replaced. */
export async function validateProjectFile(file: File): Promise<LocationProject> {
  const contents = await inspectProjectFile(file);
  return contents.project;
}

/** Verify a generated package without importing it into local asset storage. */
export async function validateProjectPackage(blob: Blob): Promise<void> {
  if (blob.type === 'application/json') {
    parseProject(await blob.text());
    return;
  }
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const manifest = zip.file(PROJECT_MANIFEST);
  if (!manifest) throw new Error(`Invalid project package: missing ${PROJECT_MANIFEST}.`);
  const project = parseProject(await manifest.async('text'));
  const integrity = await readPackageIntegrity(zip);
  for (const asset of Object.values(project.assets.assets)) {
    if (asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
      const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
      const path = `model-assets/${encodeURIComponent(key)}.bin`;
      const entry = zip.file(path);
      if (!entry) throw new Error(`Project package is missing binary model asset ${asset.name}.`);
      await validatePackagedBinary(asset.name, key, path, await entry.async('arraybuffer'), integrity);
      continue;
    }
    if (isRasterOrVideoAsset(asset) && portableStorageKey(asset)) {
      const key = portableStorageKey(asset);
      if (!key) throw new Error(`Project package is missing binary asset ${asset.name}.`);
      const path = `project-assets/${encodeURIComponent(key)}.bin`;
      const entry = zip.file(path);
      if (!entry) throw new Error(`Project package is missing binary asset ${asset.name}.`);
      await validatePackagedBinary(asset.name, key, path, await entry.async('arraybuffer'), integrity);
    }
  }
}

export async function readProjectFile(file: File): Promise<LocationProject> {
  const contents = await inspectProjectFile(file);
  const importNamespace = createImportNamespace();
  if (!contents.isPackage) {
    // Inline legacy JSON is copied under a fresh import namespace so it cannot
    // overwrite a currently open project with the same ids.
    for (const asset of Object.values(contents.project.assets.assets)) {
      if (!isRasterOrVideoAsset(asset) || !asset.uri.startsWith('data:')) continue;
      asset.storageKey = importedPayloadKey(contents.project.id, importNamespace, 'asset', asset.id);
    }
    return hydrateProjectAssetUris(contents.project);
  }
  const importedModelKeys = new Map(contents.modelWrites.map((entry) => [
    entry.key,
    importedPayloadKey(contents.project.id, importNamespace, 'model', entry.key),
  ]));
  const importedProjectAssetKeys = new Map(contents.projectAssetWrites.map((entry) => [
    entry.key,
    importedPayloadKey(contents.project.id, importNamespace, 'asset', entry.key),
  ]));
  for (const asset of Object.values(contents.project.assets.assets)) {
    if (asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
      const sourceKey = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
      const importedKey = importedModelKeys.get(sourceKey);
      if (!importedKey) throw new Error(`Project package is missing binary model asset ${asset.name}.`);
      asset.uri = `${MODEL_ASSET_URI_PREFIX}${importedKey}`;
      continue;
    }
    if (isRasterOrVideoAsset(asset)) {
      const sourceKey = portableStorageKey(asset);
      if (!sourceKey) continue;
      const importedKey = importedProjectAssetKeys.get(sourceKey);
      if (!importedKey) throw new Error(`Project package is missing binary asset ${asset.name}.`);
      asset.storageKey = importedKey;
      asset.uri = `${PROJECT_ASSET_URI_PREFIX}${importedKey}`;
    }
  }
  // Each payload class is staged only after the full package has been checked.
  // The active project is not changed by this function; callers promote it only
  // after a separate verified revision has committed.
  await putModelAssets(contents.modelWrites.map((entry) => ({
    ...entry,
    key: importedModelKeys.get(entry.key)!,
  })));
  await putProjectAssetBlobs(contents.projectAssetWrites.map((entry) => ({
    ...entry,
    key: importedProjectAssetKeys.get(entry.key)!,
  })));
  return hydrateProjectAssetUris(contents.project);
}

export async function downloadProject(project: LocationProject) {
  const blob = await createProjectPackage(project);
  await validateProjectPackage(blob);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = projectDownloadFileName(project.name);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Trigger a browser download from a Blob. Prefer this for video / large files —
 * large `data:` URLs as `<a href>` often fail silently in Chromium.
 */
export {
  dataUrlToBlob,
  downloadBlob,
  downloadDataUrl,
  readFileAsDataUrl,
  readFileAsText,
} from './fileTransfers';
