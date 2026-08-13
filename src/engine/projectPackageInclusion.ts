/**
 * Shared project-package inclusion rules used by inspect/export contracts.
 *
 * These paths match `createProjectPackage` in projectIO.ts. Inspect-time
 * callers can apply the planner without claiming a produced ZIP actually
 * contains the bytes. `includedInPackage: true` requires a proof object
 * produced by `extractProducedPackageManifest` from real ZIP archive bytes
 * (Blob, ArrayBuffer, or Uint8Array) parsed by JSZip. Fabricated
 * `{ files: ... }` objects, JSZip instances, planned-path strings, and
 * lookalike proof records cannot create a verified proof.
 */

import JSZip from 'jszip';
import type { LocationProject, ProjectAsset } from '../domain/types';
import { getModelAssetStorageKey } from './importedMeshConstants';
import { pruneUnreferencedProjectAssets } from './projectAssets';
import { assetStatusIsMissing } from './projectAssetRecovery';
import { PROJECT_ASSET_URI_PREFIX } from './projectAssetStore';

export const PRODUCED_PACKAGE_MANIFEST_KIND = 'produced-zip-manifest' as const;

export interface ProducedPackageManifestProof {
  readonly kind: typeof PRODUCED_PACKAGE_MANIFEST_KIND;
  readonly paths: readonly string[];
}

const verifiedPackageManifests = new WeakSet<object>();

export type ProjectPackageInclusion = true | false | 'not_verified';

function isRasterOrVideoAsset(asset: ProjectAsset): boolean {
  return asset.type === 'image' || asset.type === 'video';
}

function plannedModelPackagePath(projectId: string, asset: ProjectAsset): string | undefined {
  if (asset.type !== 'model') return undefined;
  if (assetStatusIsMissing(asset)) return undefined;
  const key = asset.uri.startsWith('data:')
    ? `legacy/${projectId}/${asset.id}`
    : getModelAssetStorageKey(asset);
  if (!key) return undefined;
  return `model-assets/${encodeURIComponent(key)}.bin`;
}

function plannedProjectAssetPackagePath(projectId: string, asset: ProjectAsset): string | undefined {
  if (!isRasterOrVideoAsset(asset)) return undefined;
  if (assetStatusIsMissing(asset)) return undefined;
  const key = asset.storageKey
    ?? (asset.uri.startsWith('data:') ? `project/${projectId}/asset/${asset.id}` : undefined)
    ?? (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
      ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
      : undefined);
  if (!key) return undefined;
  return `project-assets/${encodeURIComponent(key)}.bin`;
}

/** Planned ZIP path for an asset, or undefined when packaging rules omit it. */
export function plannedProjectPackageAssetPath(
  project: Pick<LocationProject, 'id'>,
  asset: ProjectAsset,
): string | undefined {
  return plannedModelPackagePath(project.id, asset) ?? plannedProjectAssetPackagePath(project.id, asset);
}

/**
 * Decide package inclusion from the real backup/package planner.
 *
 * `true` is only returned when a verified ZIP-derived proof lists the planned
 * path. Planned-path strings, fabricated iterables, artifact ids, and
 * digest-as-path values never prove inclusion.
 */
export function resolveProjectPackageInclusion(
  project: LocationProject,
  assetId: string | undefined,
  producedManifest?: Iterable<string> | ProducedPackageManifestProof,
): { includedInPackage: ProjectPackageInclusion; packagePath?: string } {
  if (!assetId) return { includedInPackage: false };
  const portable = pruneUnreferencedProjectAssets(project);
  const asset = portable.assets.assets[assetId];
  if (!asset) return { includedInPackage: false };
  const packagePath = plannedProjectPackageAssetPath(portable, asset);
  if (!packagePath) return { includedInPackage: false };
  const produced = verifiedProducedPackagePaths(producedManifest);
  if (!produced) return { includedInPackage: 'not_verified', packagePath };
  return { includedInPackage: produced.has(packagePath), packagePath };
}

/**
 * Artifact ids and digest strings are not ZIP paths. They must never make
 * `includedInPackage` true.
 */
export function isProducedPackageManifestPath(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.includes('/')) return false;
  if (/^artifact[_-]/i.test(trimmed)) return false;
  if (/^sha256:/i.test(trimmed)) return false;
  return true;
}

export function isProducedPackageManifestProof(value: unknown): value is ProducedPackageManifestProof {
  if (!value || typeof value !== 'object') return false;
  const record = value as ProducedPackageManifestProof;
  return record.kind === PRODUCED_PACKAGE_MANIFEST_KIND && Array.isArray(record.paths);
}

export function isVerifiedProducedPackageManifest(value: unknown): value is ProducedPackageManifestProof {
  return isProducedPackageManifestProof(value) && verifiedPackageManifests.has(value);
}

function verifiedProducedPackagePaths(
  producedManifest?: Iterable<string> | ProducedPackageManifestProof,
): Set<string> | undefined {
  if (!producedManifest) return undefined;
  if (!isVerifiedProducedPackageManifest(producedManifest)) return undefined;
  return new Set([...producedManifest.paths].filter(isProducedPackageManifestPath));
}

function isArchiveBytes(value: unknown): value is Blob | ArrayBuffer | Uint8Array {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
  if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) return true;
  return false;
}

/**
 * Extract produced ZIP entry paths from a real archive. Only proofs returned
 * here can make `includedInPackage` true. Fabricated path lists, `{ files }`
 * objects, and in-memory JSZip instances cannot.
 */
export async function extractProducedPackageManifest(
  source: Blob | ArrayBuffer | Uint8Array,
): Promise<ProducedPackageManifestProof> {
  if (!isArchiveBytes(source)) {
    throw new Error(
      'Produced package proof requires a real ZIP archive (Blob, ArrayBuffer, or Uint8Array).',
    );
  }
  const zip = await JSZip.loadAsync(
    typeof Blob !== 'undefined' && source instanceof Blob
      ? await source.arrayBuffer()
      : source,
  );
  const paths = Object.keys(zip.files)
    .filter((entry) => !zip.files[entry]?.dir)
    .filter(isProducedPackageManifestPath);
  const proof: ProducedPackageManifestProof = Object.freeze({
    kind: PRODUCED_PACKAGE_MANIFEST_KIND,
    paths: Object.freeze([...paths]),
  });
  verifiedPackageManifests.add(proof);
  return proof;
}
