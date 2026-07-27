/**
 * Ordered project schema migrations.
 * Each step upgrades one version; load always runs the full chain to CURRENT_SCHEMA_VERSION.
 *
 * Migrations are pure: they only rewrite the in-memory project graph. Binary staging
 * (IndexedDB / object URLs) is the caller's job after validation accepts the result.
 */

import type { CameraKeyframe, LocationProject, ProjectAsset, ProjectVersion } from '../domain/types';
import { createId } from '../utils/ids';
import { dataUrlToBlob } from './fileTransfers';
import { createProjectAssetStorageKey } from './projectAssetStore';

/** Product schema lineage (manifest field). */
export const SCHEMA_VERSIONS = ['0.1', '0.2', '1.0'] as const;
export type MigratableSchemaVersion = (typeof SCHEMA_VERSIONS)[number];
export const CURRENT_SCHEMA_VERSION: ProjectVersion = '1.0';

/** Binary payloads produced by pure migration; stage only after the project is accepted. */
export interface PendingProjectAsset {
  asset: ProjectAsset;
  blob: Blob;
}

export interface ProjectMigrationResult {
  project: LocationProject;
  pendingAssets: PendingProjectAsset[];
}

export interface SchemaMigration {
  from: MigratableSchemaVersion;
  to: MigratableSchemaVersion;
  migrate: (project: LocationProject) => LocationProject;
}

function isKnownSchemaVersion(value: unknown): value is MigratableSchemaVersion {
  return typeof value === 'string' && (SCHEMA_VERSIONS as readonly string[]).includes(value);
}

/**
 * 0.1 → 0.2: keyframe previews move from inline data URLs to project assets.
 * Legacy `previewUri` data URLs become assets + `previewAssetId` (still holding the
 * data URL on the asset until a later staging step). Short non-data URIs stay as
 * session `previewUri`.
 */
export function migrateProject01To02(project: LocationProject): LocationProject {
  const assets = { ...project.assets.assets };
  let assetsChanged = false;

  const shots = project.shots.map((shot) => {
    const cameraKeyframes = (shot.cameraKeyframes ?? []).map((keyframe) => {
      const next = migrateKeyframePreviewToAsset(project.id, keyframe, assets);
      if (next.assetsChanged) assetsChanged = true;
      return next.keyframe;
    });
    return { ...shot, cameraKeyframes };
  });

  return {
    ...project,
    schemaVersion: '0.2',
    shots,
    assets: assetsChanged
      ? { ...project.assets, assets }
      : project.assets,
  };
}

function migrateKeyframePreviewToAsset(
  projectId: string,
  keyframe: CameraKeyframe,
  assets: Record<string, LocationProject['assets']['assets'][string]>,
): { keyframe: CameraKeyframe; assetsChanged: boolean } {
  // Already on asset id.
  if (keyframe.previewAssetId && assets[keyframe.previewAssetId]) {
    const { previewUri: _drop, ...rest } = keyframe;
    return {
      keyframe: {
        ...rest,
        previewAssetId: keyframe.previewAssetId,
        previewStorageKey: keyframe.previewStorageKey
          ?? assets[keyframe.previewAssetId]?.storageKey,
      },
      assetsChanged: false,
    };
  }

  const uri = keyframe.previewUri;
  if (!uri || typeof uri !== 'string') {
    const { previewUri: _drop, ...rest } = keyframe;
    return { keyframe: rest, assetsChanged: false };
  }

  // Non-data URI (blob:/http:) — keep as runtime previewUri only; strip from persistence later.
  if (!uri.startsWith('data:')) {
    return { keyframe, assetsChanged: false };
  }

  // Pure in-memory asset record. Keep the data URL on `uri` so validators / recovery
  // can read bytes without touching IndexedDB until the project is accepted.
  const assetId = createId('asset');
  const storageKey = createProjectAssetStorageKey(projectId, assetId);
  const asset: ProjectAsset = {
    id: assetId,
    type: 'image',
    name: `keyframe-preview-${keyframe.id}`,
    mimeType: uri.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
    uri,
    storageKey,
    createdAt: new Date().toISOString(),
  };
  assets[assetId] = asset;
  const { previewUri: _drop, ...rest } = keyframe;
  return {
    keyframe: {
      ...rest,
      previewAssetId: assetId,
      previewStorageKey: storageKey,
    },
    assetsChanged: true,
  };
}

/** 0.2 → 1.0: formalize release schema; ensure productVersion is stamped. */
export function migrateProject02To10(project: LocationProject): LocationProject {
  return {
    ...project,
    schemaVersion: '1.0',
    productVersion: project.productVersion ?? '0.1.0',
  };
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { from: '0.1', to: '0.2', migrate: migrateProject01To02 },
  { from: '0.2', to: '1.0', migrate: migrateProject02To10 },
];

export function listMigrationPath(
  from: MigratableSchemaVersion,
  to: MigratableSchemaVersion = CURRENT_SCHEMA_VERSION,
): SchemaMigration[] {
  if (from === to) return [];
  const fromIndex = SCHEMA_VERSIONS.indexOf(from);
  const toIndex = SCHEMA_VERSIONS.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
    throw new Error(`No migration path from ${from} to ${to}.`);
  }
  const path: SchemaMigration[] = [];
  for (let i = fromIndex; i < toIndex; i += 1) {
    const step = SCHEMA_MIGRATIONS.find(
      (migration) => migration.from === SCHEMA_VERSIONS[i] && migration.to === SCHEMA_VERSIONS[i + 1],
    );
    if (!step) throw new Error(`Missing migration ${SCHEMA_VERSIONS[i]} → ${SCHEMA_VERSIONS[i + 1]}.`);
    path.push(step);
  }
  return path;
}

/**
 * Collect raster/video assets that still hold inline data URLs (e.g. after pure migration).
 * Callers stage these only after the full project has been validated and accepted.
 */
export function collectPendingInlineProjectAssets(project: LocationProject): PendingProjectAsset[] {
  const pending: PendingProjectAsset[] = [];
  for (const asset of Object.values(project.assets.assets)) {
    if ((asset.type !== 'image' && asset.type !== 'video') || !asset.uri.startsWith('data:')) continue;
    pending.push({ asset, blob: dataUrlToBlob(asset.uri) });
  }
  return pending;
}

/** Run ordered migrations until CURRENT_SCHEMA_VERSION (pure; no local storage writes). */
export function migrateProjectToCurrent(project: LocationProject): LocationProject {
  return migrateProjectToCurrentResult(project).project;
}

/**
 * Same as migrateProjectToCurrent, plus pending binary payloads for transactional staging.
 * `parseProject` / validators should use the project graph only; storage writers stage
 * `pendingAssets` after accept.
 */
export function migrateProjectToCurrentResult(project: LocationProject): ProjectMigrationResult {
  const version = project.schemaVersion;
  if (!isKnownSchemaVersion(version)) {
    throw new Error(`Unsupported project schema version: ${String(version)}`);
  }
  let next = project;
  for (const step of listMigrationPath(version, CURRENT_SCHEMA_VERSION)) {
    next = step.migrate(next);
    if (next.schemaVersion !== step.to) {
      throw new Error(`Migration ${step.from} → ${step.to} did not set schemaVersion.`);
    }
  }
  return {
    project: next,
    pendingAssets: collectPendingInlineProjectAssets(next),
  };
}

/** Strip ephemeral runtime preview fields before serializing to JSON. */
export function stripEphemeralKeyframePreviewUris(project: LocationProject): LocationProject {
  let changed = false;
  const shots = project.shots.map((shot) => {
    const cameraKeyframes = (shot.cameraKeyframes ?? []).map((keyframe) => {
      if (!keyframe.previewUri) return keyframe;
      // Keep only non-data ephemeral URIs out of JSON when asset id exists.
      if (keyframe.previewAssetId || keyframe.previewUri.startsWith('data:')) {
        const { previewUri: _drop, ...rest } = keyframe;
        changed = true;
        return rest;
      }
      return keyframe;
    });
    return cameraKeyframes === shot.cameraKeyframes
      ? shot
      : { ...shot, cameraKeyframes };
  });
  return changed ? { ...project, shots } : project;
}

export function projectManifestHasEmbeddedKeyframeDataUrls(json: string): boolean {
  // Detect data-URL previews inside cameraKeyframes (not other assets).
  return /"cameraKeyframes"\s*:\s*\[[\s\S]*?"previewUri"\s*:\s*"data:/i.test(json);
}
