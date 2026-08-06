import type { LocationProject, PanoReference, PoseableCharacterSource, SceneObject } from '../domain/types';
import { resolveProjectedProjectorAssets } from './multiOriginProjection';

export interface ProjectedSourceDependency {
  panoId: string;
  origin: [number, number, number];
  rotation: [number, number, number];
  width: number;
  height: number;
  imageAssetContentIdentity: string;
  role: 'primary' | 'secondary';
}

export function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const r = value as Record<string, unknown>;
  return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${stableSerialize(r[k])}`).join(',')}}`;
}

export function hash(value: string): string {
  let a = 2166136261;
  let b = 2246822519;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ (c + i), 3266489917);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function assetContentIdentity(project: LocationProject, assetId: string | undefined): string {
  if (!assetId) return 'missing';
  const asset = project.assets.assets[assetId];
  if (!asset) return `missing:${assetId}`;
  return asset.contentHash ?? asset.storageKey ?? asset.uri ?? `id:${assetId}`;
}

export function assetDependency(project: LocationProject, assetId: string | undefined, prefix: string): string | undefined {
  if (!assetId) return undefined;
  return `${prefix}:${assetId}:${assetContentIdentity(project, assetId)}`;
}

export function poseableSourceIdentity(project: LocationProject, source: PoseableCharacterSource | undefined): unknown {
  if (!source) return null;
  if (source.kind === 'builtin') return { kind: 'builtin', characterId: source.characterId };
  return { kind: source.kind, assetId: source.assetId, rigId: source.rigId, assetContent: assetContentIdentity(project, source.assetId) };
}

export function buildObjectRenderDependency(project: LocationProject, object: SceneObject): Record<string, unknown> {
  const modelDep = object.modelAssetId ? assetContentIdentity(project, object.modelAssetId) : null;
  return {
    id: object.id,
    type: object.type,
    transform: object.transform,
    dimensions: object.dimensions,
    visible: object.visible,
    locked: object.locked,
    stagingRole: object.stagingRole,
    category: object.category,
    productionClass: object.productionClass,
    surfaceStyle: object.surfaceStyle ?? null,
    color: object.color ?? null,
    secondaryColor: object.secondaryColor ?? null,
    materialId: object.materialId ?? null,
    parentId: object.parentId ?? null,
    modelAssetId: object.modelAssetId ?? null,
    modelAssetContent: modelDep,
    importedModel: object.importedModel ? { sourceName: object.importedModel.sourceName, sourceFormat: object.importedModel.sourceFormat, sourceKind: object.importedModel.sourceKind, vertexCount: object.importedModel.vertexCount, triangleCount: object.importedModel.triangleCount, meshCount: object.importedModel.meshCount } : null,
    humanPose: object.humanPose ?? null,
    poseableCharacter: poseableSourceIdentity(project, object.poseableCharacter),
    metadata: object.metadata ?? null,
  };
}

function panoSourceDependency(project: LocationProject, pano: PanoReference, role: 'primary' | 'secondary'): ProjectedSourceDependency {
  return { panoId: pano.id, origin: [...pano.origin] as [number, number, number], rotation: [...pano.rotation] as [number, number, number], width: pano.width, height: pano.height, imageAssetContentIdentity: assetContentIdentity(project, pano.imageAssetId), role };
}

export function buildProjectedSourceDependencies(project: LocationProject): ProjectedSourceDependency[] {
  const assets = resolveProjectedProjectorAssets(project);
  if (!assets) return [];
  const s: ProjectedSourceDependency[] = [panoSourceDependency(project, assets.primary, 'primary')];
  if (assets.secondary) s.push(panoSourceDependency(project, assets.secondary, 'secondary'));
  return s;
}
