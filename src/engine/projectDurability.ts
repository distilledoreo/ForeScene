/**
 * Persist and backup identity: what must survive process death.
 *
 * Distinguishes explicit `linkedPanoId: null` from an omitted field.
 * Package inspect is a pure function of zip bytes — it does not hydrate
 * IndexedDB or a browser profile.
 */

import JSZip from 'jszip';
import type { LocationProject } from '../domain/types';
import { getModelAssetStorageKey, MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { parseProject } from './projectIO';

export const PROJECT_BACKUP_MANIFEST = 'project.json';

export type ShotPanoramaBinding = 'linked' | 'explicit_null' | 'omitted';

export interface DurableShotEvidence {
  id: string;
  shotNumber?: string;
  panoramaBinding: ShotPanoramaBinding;
  linkedPanoId: string | null | undefined;
}

export interface DurableObjectEvidence {
  id: string;
  type: string;
  modelAssetId?: string;
}

export interface DurableModelAssetEvidence {
  id: string;
  present: boolean;
  zipPath?: string;
  byteLength?: number;
  resolutionStatus?: string;
}

export interface DurableProjectEvidence {
  projectId: string;
  shots: DurableShotEvidence[];
  objects: DurableObjectEvidence[];
  modelAssets: DurableModelAssetEvidence[];
}

export interface DurableCompareResult {
  ok: boolean;
  mismatches: string[];
}

export interface ProjectBackupInspectResult {
  /** Raw `project.json` before schema normalize — source of null vs omitted. */
  rawProject: Record<string, unknown>;
  project: LocationProject;
  evidence: DurableProjectEvidence;
  zipEntries: string[];
}

export function shotPanoramaBinding(shot: { linkedPanoId?: string | null }): ShotPanoramaBinding {
  if (!Object.prototype.hasOwnProperty.call(shot, 'linkedPanoId') || shot.linkedPanoId === undefined) {
    return 'omitted';
  }
  if (shot.linkedPanoId === null) return 'explicit_null';
  return 'linked';
}

export function collectDurableProjectEvidence(
  project: LocationProject,
  packaged?: { zipPaths: Set<string>; zipSizes: Map<string, number> },
): DurableProjectEvidence {
  const modelAssets: DurableModelAssetEvidence[] = [];
  for (const asset of Object.values(project.assets.assets)) {
    if (asset.type !== 'model') continue;
    const key = getModelAssetStorageKey(asset);
    const zipPath = key ? `model-assets/${encodeURIComponent(key)}.bin` : undefined;
    const zipBytes = zipPath ? packaged?.zipSizes.get(zipPath) : undefined;
    const present = packaged
      ? Boolean(zipPath && packaged.zipPaths.has(zipPath) && (zipBytes ?? 0) > 0)
      : asset.resolutionStatus !== 'missing'
        && asset.resolutionStatus !== 'corrupt'
        && asset.resolutionStatus !== 'unsupported'
        && Boolean(key || asset.uri.startsWith('data:'));
    modelAssets.push({
      id: asset.id,
      present,
      zipPath,
      byteLength: zipBytes,
      resolutionStatus: asset.resolutionStatus,
    });
  }

  return {
    projectId: project.id,
    shots: project.shots.map((shot) => ({
      id: shot.id,
      shotNumber: shot.shotNumber,
      panoramaBinding: shotPanoramaBinding(shot),
      linkedPanoId: shot.linkedPanoId,
    })),
    objects: project.scene.objects.map((object) => ({
      id: object.id,
      type: object.type,
      modelAssetId: object.modelAssetId,
    })),
    modelAssets,
  };
}

export function compareDurableProjectEvidence(
  expected: DurableProjectEvidence,
  actual: DurableProjectEvidence,
): DurableCompareResult {
  const mismatches: string[] = [];
  if (expected.projectId !== actual.projectId) {
    mismatches.push(`projectId ${expected.projectId} → ${actual.projectId}`);
  }

  const actualShots = new Map(actual.shots.map((shot) => [shot.id, shot]));
  const expectedShotIds = new Set(expected.shots.map((shot) => shot.id));
  for (const shot of expected.shots) {
    const found = actualShots.get(shot.id);
    if (!found) {
      mismatches.push(`missing shot ${shot.id}`);
      continue;
    }
    if (shot.panoramaBinding !== found.panoramaBinding) {
      mismatches.push(
        `shot ${shot.id} panoramaBinding ${shot.panoramaBinding} → ${found.panoramaBinding}`,
      );
    }
    if (shot.panoramaBinding === 'explicit_null' && found.linkedPanoId !== null) {
      mismatches.push(`shot ${shot.id} linkedPanoId is not explicit null (${String(found.linkedPanoId)})`);
    }
    if (shot.panoramaBinding === 'linked' && shot.linkedPanoId !== found.linkedPanoId) {
      mismatches.push(`shot ${shot.id} linkedPanoId ${String(shot.linkedPanoId)} → ${String(found.linkedPanoId)}`);
    }
  }
  for (const shot of actual.shots) {
    if (!expectedShotIds.has(shot.id)) {
      mismatches.push(`unexpected shot ${shot.id}`);
    }
  }

  const actualObjects = new Map(actual.objects.map((object) => [object.id, object]));
  const expectedObjectIds = new Set(expected.objects.map((object) => object.id));
  for (const object of expected.objects) {
    const found = actualObjects.get(object.id);
    if (!found) {
      mismatches.push(`missing object ${object.id}`);
      continue;
    }
    if (object.type !== found.type) {
      mismatches.push(`object ${object.id} type ${object.type} → ${found.type}`);
    }
    if (object.type === 'imported_model' && found.type !== 'imported_model') {
      mismatches.push(`object ${object.id} is no longer imported_model`);
    }
    if (object.modelAssetId !== found.modelAssetId) {
      mismatches.push(
        `object ${object.id} modelAssetId ${String(object.modelAssetId)} → ${String(found.modelAssetId)}`,
      );
    }
  }
  for (const object of actual.objects) {
    if (!expectedObjectIds.has(object.id)) {
      mismatches.push(`unexpected object ${object.id}`);
    }
  }

  const expectedModels = expected.modelAssets.filter((asset) => asset.present);
  const actualModels = new Map(actual.modelAssets.map((asset) => [asset.id, asset]));
  for (const asset of expectedModels) {
    const found = actualModels.get(asset.id);
    if (!found || !found.present) {
      mismatches.push(`model binary ${asset.id} is missing`);
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

function rawShotsOf(rawProject: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(rawProject.shots)
    ? rawProject.shots.filter((shot): shot is Record<string, unknown> => Boolean(shot) && typeof shot === 'object')
    : [];
}

export function rawShotPanoramaBinding(rawShot: Record<string, unknown>): ShotPanoramaBinding {
  if (!Object.prototype.hasOwnProperty.call(rawShot, 'linkedPanoId')) return 'omitted';
  if (rawShot.linkedPanoId === null) return 'explicit_null';
  if (typeof rawShot.linkedPanoId === 'string' && rawShot.linkedPanoId.length > 0) return 'linked';
  if (rawShot.linkedPanoId === undefined) return 'omitted';
  return 'omitted';
}

export async function inspectProjectBackupBytes(
  bytes: ArrayBuffer | Uint8Array,
): Promise<ProjectBackupInspectResult> {
  const zip = await JSZip.loadAsync(bytes);
  const zipEntries = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir).sort();
  const manifest = zip.file(PROJECT_BACKUP_MANIFEST);
  if (!manifest) {
    throw new Error(`Project backup is missing ${PROJECT_BACKUP_MANIFEST}.`);
  }
  const manifestText = await manifest.async('text');
  const rawParsed = JSON.parse(manifestText) as unknown;
  if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
    throw new Error('Project backup project.json is not an object.');
  }
  const rawProject = rawParsed as Record<string, unknown>;
  const project = parseProject(manifestText);
  const zipPaths = new Set(zipEntries);
  const zipSizes = new Map<string, number>();
  for (const name of zipEntries) {
    const entry = zip.file(name);
    if (!entry) continue;
    const data = await entry.async('uint8array');
    zipSizes.set(name, data.byteLength);
  }
  const evidence = collectDurableProjectEvidence(project, { zipPaths, zipSizes });
  for (const rawShot of rawShotsOf(rawProject)) {
    const id = typeof rawShot.id === 'string' ? rawShot.id : undefined;
    if (!id) continue;
    const binding = rawShotPanoramaBinding(rawShot);
    const shot = evidence.shots.find((candidate) => candidate.id === id);
    if (shot) shot.panoramaBinding = binding;
  }
  return { rawProject, project, evidence, zipEntries };
}

export function verifyBackupMatchesProject(
  inspect: ProjectBackupInspectResult,
  expectedProject: LocationProject,
): DurableCompareResult {
  const expected = collectDurableProjectEvidence(expectedProject);
  return compareDurableProjectEvidence(expected, inspect.evidence);
}

export async function persistAndVerifyProject(input: {
  liveProject: LocationProject;
  persist: () => Promise<{ project: LocationProject; revisionId?: string } | undefined>;
}): Promise<{
  ok: boolean;
  mismatches: string[];
  live: DurableProjectEvidence;
  persisted?: DurableProjectEvidence;
  revisionId?: string;
  project?: LocationProject;
}> {
  const live = collectDurableProjectEvidence(input.liveProject);
  const persisted = await input.persist();
  if (!persisted) {
    return {
      ok: false,
      mismatches: ['persist returned no verified revision'],
      live,
    };
  }
  const persistedEvidence = collectDurableProjectEvidence(persisted.project);
  const compared = compareDurableProjectEvidence(live, persistedEvidence);
  return {
    ok: compared.ok,
    mismatches: compared.mismatches,
    live,
    persisted: persistedEvidence,
    revisionId: persisted.revisionId,
    project: persisted.project,
  };
}

export function importedModelObjectsOf(project: LocationProject): DurableObjectEvidence[] {
  return collectDurableProjectEvidence(project).objects.filter((object) => object.type === 'imported_model');
}

/** Kept so callers can mention the URI prefix without importing mesh constants. */
export const DURABLE_MODEL_URI_PREFIX = MODEL_ASSET_URI_PREFIX;
