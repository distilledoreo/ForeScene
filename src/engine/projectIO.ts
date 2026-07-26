import { Euler, LocationProject, PanoReference, ProjectAsset, SceneObject, Shot, Transform, Vec3 } from '../domain/types';
import { normalizeProductionShotId } from '../domain/shotIdentity';
import {
  DEFAULT_CAMERA_HEIGHT_METERS,
  normalizeProjectSettings,
  normalizeProjectWorkflow,
} from '../domain/defaults';
import JSZip from 'jszip';
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

const PROJECT_MANIFEST = 'project.json';
const DEFAULT_SCENE_PANO_ORIGIN: Vec3 = [0, DEFAULT_CAMERA_HEIGHT_METERS, 0];
const DEFAULT_SCENE_PANO_ROTATION: Euler = [0, 0, 0];

export function serializeProject(project: LocationProject): string {
  return JSON.stringify(createPortableProject(project), null, 2);
}

function createPortableProject(project: LocationProject): LocationProject {
  const portable = structuredClone(pruneUnreferencedProjectAssets(project));
  for (const asset of Object.values(portable.assets.assets)) {
    if (asset.storageKey) asset.uri = `${PROJECT_ASSET_URI_PREFIX}${asset.storageKey}`;
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
  if (parsed.schemaVersion !== '0.1') {
    throw new Error('Unsupported project schema version.');
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
    return {
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
    };
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
  };
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
    const candidate = rawOverride as { transform?: unknown; visible?: unknown };
    const transform = normalizeTransform(candidate.transform);
    const visible = typeof candidate.visible === 'boolean' ? candidate.visible : undefined;
    if (!transform && visible === undefined) continue;
    result[objectId] = {
      ...(transform ? { transform } : {}),
      ...(visible !== undefined ? { visible } : {}),
    };
  }
  return result;
}

function normalizePeopleExportMode(value: unknown): Shot['exportSettings']['peopleExportMode'] {
  if (value === 'clean_plate' || value === 'both') return value;
  return 'with_people';
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
    exportSettings: {
      ...exportSettings,
      peopleExportMode: normalizePeopleExportMode(legacyExportSettings.peopleExportMode),
      includeAiResultFrame: legacyExportSettings.includeAiResultFrame ?? legacyExportSettings.includeSkinnedFrame ?? true,
      includeCameraMoveVideo: legacyExportSettings.includeCameraMoveVideo ?? true,
      includeCameraMoveReferenceFrames: legacyExportSettings.includeCameraMoveReferenceFrames ?? true,
      includeProjectedViewport: legacyExportSettings.includeProjectedViewport ?? true,
      includeProjectedCameraMoveReferenceFrames:
        legacyExportSettings.includeProjectedCameraMoveReferenceFrames ?? true,
      includeProjectedCameraMoveVideo:
        legacyExportSettings.includeProjectedCameraMoveVideo ?? true,
    },
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
  if (binaryAssets.length === 0 && storedProjectAssets.length === 0) {
    return new Blob([serializeProject(portable)], { type: 'application/json' });
  }
  const zip = new JSZip();
  zip.file(PROJECT_MANIFEST, serializeProject(portable));
  for (const asset of binaryAssets) {
    const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
    const bytes = migratedBytes.get(key) ?? await getModelAsset(key);
    if (!bytes) throw new Error(`Cannot save project: binary model asset ${asset.name} is missing.`);
    zip.file(`model-assets/${encodeURIComponent(key)}.bin`, bytes);
  }
  for (const asset of storedProjectAssets) {
    const key = portableStorageKey(asset);
    if (!key) continue;
    const blob = migratedProjectAssetBlobs.get(key) ?? await getProjectAssetBlob(key);
    if (!blob) throw new Error(`Cannot save project: binary asset ${asset.name} is missing.`);
    zip.file(`project-assets/${encodeURIComponent(key)}.bin`, await blob.arrayBuffer());
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
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

function createImportNamespace(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function importedPayloadKey(projectId: string, importNamespace: string, kind: 'asset' | 'model', sourceKey: string): string {
  return `import/${projectId}/${importNamespace}/${kind}/${encodeURIComponent(sourceKey)}`;
}

async function inspectProjectFile(file: File): Promise<ValidatedProjectFileContents> {
  if (!file.name.toLowerCase().endsWith('.zip') && !file.name.toLowerCase().endsWith('.panoref-project')) {
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
  const modelWrites = await Promise.all(
    Object.values(project.assets.assets)
      .filter((asset) => asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX))
      .map(async (asset) => {
        const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
        const entry = zip.file(`model-assets/${encodeURIComponent(key)}.bin`);
        if (!entry) throw new Error(`Project package is missing binary model asset ${asset.name}.`);
        const bytes = await entry.async('arraybuffer');
        assertNonEmptyBinary(asset.name, bytes.byteLength);
        return { key, bytes };
      }),
  );
  const projectAssetWrites = await Promise.all(
    Object.values(project.assets.assets)
      .filter((asset) => isRasterOrVideoAsset(asset) && portableStorageKey(asset))
      .map(async (asset) => {
        const key = portableStorageKey(asset);
        if (!key) throw new Error(`Project package is missing binary asset ${asset.name}.`);
        const entry = zip.file(`project-assets/${encodeURIComponent(key)}.bin`);
        if (!entry) throw new Error(`Project package is missing binary asset ${asset.name}.`);
        const bytes = await entry.async('arraybuffer');
        assertNonEmptyBinary(asset.name, bytes.byteLength);
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
  for (const asset of Object.values(project.assets.assets)) {
    if (asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
      const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
      const entry = zip.file(`model-assets/${encodeURIComponent(key)}.bin`);
      if (!entry) throw new Error(`Project package is missing binary model asset ${asset.name}.`);
      assertNonEmptyBinary(asset.name, (await entry.async('arraybuffer')).byteLength);
      continue;
    }
    if (isRasterOrVideoAsset(asset) && portableStorageKey(asset)) {
      const key = portableStorageKey(asset);
      if (!key) throw new Error(`Project package is missing binary asset ${asset.name}.`);
      const entry = zip.file(`project-assets/${encodeURIComponent(key)}.bin`);
      if (!entry) throw new Error(`Project package is missing binary asset ${asset.name}.`);
      assertNonEmptyBinary(asset.name, (await entry.async('arraybuffer')).byteLength);
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
  link.download = `${project.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_continuity_stage.${blob.type === 'application/json' ? 'json' : 'panoref-project'}`;
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
