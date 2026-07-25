import { Euler, LocationProject, PanoReference, SceneObject, Shot, Transform, Vec3 } from '../domain/types';
import { normalizeProductionShotId } from '../domain/shotIdentity';
import {
  DEFAULT_CAMERA_HEIGHT_METERS,
  normalizeProjectSettings,
  normalizeProjectWorkflow,
} from '../domain/defaults';
import JSZip from 'jszip';
import { MODEL_ASSET_URI_PREFIX } from './importedMesh';
import { deleteModelAsset, getModelAsset, putModelAsset } from './modelAssetStore';

const PROJECT_MANIFEST = 'project.json';
const DEFAULT_SCENE_PANO_ORIGIN: Vec3 = [0, DEFAULT_CAMERA_HEIGHT_METERS, 0];
const DEFAULT_SCENE_PANO_ROTATION: Euler = [0, 0, 0];

export function serializeProject(project: LocationProject): string {
  return JSON.stringify(withoutOrphanedModelAssets(project), null, 2);
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
  const portable = structuredClone(withoutOrphanedModelAssets(project));
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
  if (binaryAssets.length === 0) return new Blob([serializeProject(portable)], { type: 'application/json' });
  const zip = new JSZip();
  zip.file(PROJECT_MANIFEST, serializeProject(portable));
  for (const asset of binaryAssets) {
    const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
    const bytes = migratedBytes.get(key) ?? await getModelAsset(key);
    if (!bytes) throw new Error(`Cannot save project: binary model asset ${asset.name} is missing.`);
    zip.file(`model-assets/${encodeURIComponent(key)}.bin`, bytes);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

export async function readProjectFile(file: File): Promise<LocationProject> {
  if (!file.name.toLowerCase().endsWith('.zip') && !file.name.toLowerCase().endsWith('.panoref-project')) return parseProject(await file.text());
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifest = zip.file(PROJECT_MANIFEST);
  if (!manifest) throw new Error(`Invalid project package: missing ${PROJECT_MANIFEST}.`);
  const project = parseProject(await manifest.async('text'));
  for (const asset of Object.values(project.assets.assets)) {
    if (asset.type !== 'model' || !asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) continue;
    const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
    const entry = zip.file(`model-assets/${encodeURIComponent(key)}.bin`);
    if (!entry) throw new Error(`Project package is missing binary model asset ${asset.name}.`);
    const bytes = await entry.async('arraybuffer');
    await putModelAsset(key, bytes);
  }
  return project;
}

export async function downloadProject(project: LocationProject) {
  const blob = await createProjectPackage(project);
  const referenced = new Set(project.scene.objects.map((object) => object.modelAssetId).filter(Boolean));
  await Promise.all(Object.values(project.assets.assets).filter((asset) => asset.type === 'model' && !referenced.has(asset.id) && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)).map((asset) => deleteModelAsset(asset.uri.slice(MODEL_ASSET_URI_PREFIX.length))));
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
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Delay revoke so the browser can finish starting the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/** Convert a data URL to a Blob (supports base64 and URL-encoded payloads). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) {
    throw new Error('Invalid data URL.');
  }
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const mimeType = mimeMatch?.[1] ?? 'application/octet-stream';
  const isBase64 = /;base64/i.test(header);
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(payload)], { type: mimeType });
}

export function downloadDataUrl(dataUrl: string, fileName: string) {
  // Always route data URLs through a blob object URL — video MP4 data URLs are
  // multi‑MB and routinely fail when assigned to an anchor href.
  if (dataUrl.startsWith('data:')) {
    downloadBlob(dataUrlToBlob(dataUrl), fileName);
    return;
  }
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function withoutOrphanedModelAssets(project: LocationProject): LocationProject {
  const referencedModelIds = new Set(
    project.scene.objects
      .map((object) => object.modelAssetId)
      .filter((id): id is string => Boolean(id)),
  );
  const assets = Object.fromEntries(
    Object.entries(project.assets.assets).filter(([, asset]) => (
      asset.type !== 'model' || referencedModelIds.has(asset.id)
    )),
  );
  if (Object.keys(assets).length === Object.keys(project.assets.assets).length) return project;
  return {
    ...project,
    assets: { assets },
  };
}
