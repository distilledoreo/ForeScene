import { objectDisplayName } from '../domain/defaults';
import { AssetRegistry, ProjectAsset, SceneObject, SceneObjectType, Vec3 } from '../domain/types';
import { createId } from '../utils/ids';
import { snapBuildPoint } from './sandboxCore';
import { LEGACY_PANOREF_MESH_MIME, MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';

export const BUILD_CLIPBOARD_KIND = 'panoref/build-objects';
export const BUILD_CLIPBOARD_VERSION = 2;
export const BUILD_PASTE_OFFSET = 0.75;

const SCENE_OBJECT_TYPES = new Set<SceneObjectType>([
  'floor', 'wall', 'box', 'arch', 'doorway', 'column', 'stairs', 'tree_blob',
  'terrain_mass', 'background_card', 'human_dummy', 'sun_marker', 'imported_model',
]);
const CATEGORIES = new Set<SceneObject['category']>(['architecture', 'environment', 'helper', 'landmark']);

export interface BuildClipboardPayload {
  kind: typeof BUILD_CLIPBOARD_KIND;
  version: number;
  sourceProjectId: string;
  copiedAt: string;
  anchor: Vec3;
  objects: SceneObject[];
  assets?: Record<string, ProjectAsset>;
}

export function createBuildClipboardPayload(
  sourceProjectId: string,
  objects: SceneObject[],
  assets?: AssetRegistry,
): BuildClipboardPayload {
  if (objects.length === 0) throw new Error('Select at least one Build object to copy.');
  const clonedObjects = structuredClone(objects);
  const assetsMap: Record<string, ProjectAsset> = {};
  if (assets) {
    for (const obj of clonedObjects) {
      if (obj.modelAssetId) {
        const asset = assets.assets[obj.modelAssetId];
        if (asset && asset.type === 'model') {
          assetsMap[asset.id] = structuredClone(asset);
        }
      }
    }
  }
  return {
    kind: BUILD_CLIPBOARD_KIND,
    version: BUILD_CLIPBOARD_VERSION,
    sourceProjectId,
    copiedAt: new Date().toISOString(),
    anchor: selectionCenter(clonedObjects),
    objects: clonedObjects,
    assets: Object.keys(assetsMap).length > 0 ? assetsMap : undefined,
  };
}

export function serializeBuildClipboard(payload: BuildClipboardPayload): string {
  return JSON.stringify(payload);
}

export function parseBuildClipboard(text: string): BuildClipboardPayload | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.kind !== BUILD_CLIPBOARD_KIND) return undefined;
  // Support version 1 (legacy, no assets) and version 2 (with assets map)
  const version = value.version;
  if (typeof version !== 'number' || ![1, 2].includes(version)) return undefined;
  if (typeof value.sourceProjectId !== 'string' || typeof value.copiedAt !== 'string') return undefined;
  if (!isVec3(value.anchor) || !Array.isArray(value.objects) || value.objects.length === 0) return undefined;
  if (!value.objects.every(isSceneObject)) return undefined;

  // For v2, validate assets map if present; for v1 with modelAssetId, reject gracefully (old bug placeholder)
  if (version === 1) {
    // Legacy v1: if any object references a model asset, it had no assets map – reject to avoid placeholder replacement
    const hasModelRef = (value.objects as SceneObject[]).some((obj) => Boolean(obj.modelAssetId));
    if (hasModelRef) {
      // Allow legacy non-imported objects, but reject if they referenced imported models
      // Actually per spec: need backward compat – if no modelAssetId, allow v1; else reject
      return undefined;
    }
    return structuredClone(value) as unknown as BuildClipboardPayload;
  }

  // Version 2
  let assets: Record<string, unknown> | undefined;
  if (value.assets !== undefined) {
    if (!isRecord(value.assets)) return undefined;
    assets = value.assets;
    for (const [, asset] of Object.entries(assets)) {
      if (!isValidClipboardAsset(asset)) return undefined;
    }
  } else {
    // In v2, if any object has modelAssetId, assets map must be present (or else reject)
    const hasModelRef = (value.objects as SceneObject[]).some((obj) => Boolean(obj.modelAssetId));
    if (hasModelRef) return undefined;
  }
  for (const object of value.objects as SceneObject[]) {
    if (object.modelAssetId && !assets?.[object.modelAssetId]) return undefined;
  }

  return structuredClone(value) as unknown as BuildClipboardPayload;
}

export interface PasteWithAssets {
  objects: SceneObject[];
  assets: Record<string, ProjectAsset>;
}

export function pasteBuildClipboardObjects(params: {
  payload: BuildClipboardPayload;
  existingObjects: SceneObject[];
  existingAssets?: AssetRegistry;
  pasteIndex: number;
  snapToGrid: boolean;
  inPlace?: boolean;
}): SceneObject[] {
  // Maintain backward compat for callers that only want objects
  const result = pasteBuildClipboardObjectsWithAssets(params);
  return result.objects;
}

export function pasteBuildClipboardObjectsWithAssets(params: {
  payload: BuildClipboardPayload;
  existingObjects: SceneObject[];
  existingAssets?: AssetRegistry;
  pasteIndex: number;
  snapToGrid: boolean;
  inPlace?: boolean;
}): PasteWithAssets {
  const distance = params.inPlace ? 0 : BUILD_PASTE_OFFSET * Math.max(1, params.pasteIndex);
  const offset = snapBuildPoint([distance, 0, distance], params.snapToGrid);
  const counts = countTypes(params.existingObjects);
  const existingAssetMap = params.existingAssets?.assets ?? {};

  // Build remapping for imported-model assets
  const idRemap = new Map<string, string>();
  const resultingAssets: Record<string, ProjectAsset> = {};

  // First, compute asset remapping
  const payloadAssets = params.payload.assets ?? {};
  for (const [oldId, asset] of Object.entries(payloadAssets)) {
    const existing = existingAssetMap[oldId];
    if (existing && existing.uri === asset.uri) {
      // Same project reuse path – keep same ID
      idRemap.set(oldId, oldId);
    } else if (existing && existing.uri !== asset.uri) {
      // Collision with different URI – new ID, never overwrite
      const newId = createId('model');
      idRemap.set(oldId, newId);
      resultingAssets[newId] = { ...structuredClone(asset), id: newId };
    } else {
      // No existing – check if any existing asset has same URI (cross-project dedup)
      const sameUriExisting = Object.values(existingAssetMap).find((ea) => ea.uri === asset.uri);
      if (sameUriExisting) {
        idRemap.set(oldId, sameUriExisting.id);
      } else {
        // Check if we already created a remapped asset with same URI in this batch (shared source)
        const alreadyMappedNewId = Object.entries(resultingAssets).find(([, a]) => a.uri === asset.uri)?.[0];
        if (alreadyMappedNewId) {
          idRemap.set(oldId, alreadyMappedNewId);
        } else {
          const newId = oldId; // for cross-project first time, keep stable? Safer to keep oldId if not colliding, but to avoid overwrite always new? Spec: remap old->new, shared still shared
          // In cross-project, if oldId not colliding, reuse it as is.
          idRemap.set(oldId, oldId);
          resultingAssets[oldId] = structuredClone(asset);
        }
      }
    }
  }

  // Now build objects
  const newObjects: SceneObject[] = params.payload.objects.map((source) => {
    const index = (counts.get(source.type) ?? 0) + 1;
    counts.set(source.type, index);
    const position = snapBuildPoint([
      source.transform.position[0] + offset[0],
      source.transform.position[1],
      source.transform.position[2] + offset[2],
    ], params.snapToGrid);

    const cloned = structuredClone(source);
    const newId = createId('obj');
    let modelAssetId = cloned.modelAssetId;
    if (modelAssetId) {
      const remapped = idRemap.get(modelAssetId);
      if (remapped) modelAssetId = remapped;
    }
    // Name dedup: keep unique within paste? The counting above handles it.
    return {
      ...cloned,
      id: newId,
      name: `${objectDisplayName(source.type)} ${index}`,
      locked: false,
      visible: true,
      modelAssetId,
      transform: {
        position,
        rotation: [...source.transform.rotation] as Vec3,
        scale: [...source.transform.scale] as Vec3,
      },
      dimensions: [...source.dimensions] as Vec3,
    } as SceneObject;
  });

  return { objects: newObjects, assets: resultingAssets };
}

export function selectionCenter(objects: SceneObject[]): Vec3 {
  if (objects.length === 0) return [0, 0, 0];
  const sum = objects.reduce<Vec3>((result, object) => [
    result[0] + object.transform.position[0],
    result[1] + object.transform.position[1],
    result[2] + object.transform.position[2],
  ], [0, 0, 0]);
  return sum.map((value) => value / objects.length) as Vec3;
}

function countTypes(objects: SceneObject[]) {
  const counts = new Map<SceneObjectType, number>();
  objects.forEach((object) => counts.set(object.type, (counts.get(object.type) ?? 0) + 1));
  return counts;
}

function isSceneObject(value: unknown): value is SceneObject {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return false;
  if (!SCENE_OBJECT_TYPES.has(value.type as SceneObjectType)) return false;
  if (!CATEGORIES.has(value.category as SceneObject['category'])) return false;
  if (typeof value.locked !== 'boolean' || typeof value.visible !== 'boolean') return false;
  if (!isVec3(value.dimensions) || value.dimensions.some((number) => number <= 0)) return false;
  if (!isRecord(value.transform)) return false;
  if (!isVec3(value.transform.position) || !isVec3(value.transform.rotation) || !isVec3(value.transform.scale)) return false;
  if (value.metadata !== undefined && !isJsonSafe(value.metadata)) return false;
  return true;
}

function isValidClipboardAsset(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type !== 'model') return false;
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.uri !== 'string') return false;
  if (typeof value.uri !== 'string' || (!value.uri.startsWith(`data:${LEGACY_PANOREF_MESH_MIME};base64,`) && !value.uri.startsWith(MODEL_ASSET_URI_PREFIX))) return false;
  // Basic mime check
  return true;
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSafe(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}
