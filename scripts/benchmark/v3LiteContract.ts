import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePrevisProductionManifest } from '../../src/engine/previs/manifestValidation';
import type { PrevisProductionManifestV1 } from '../../src/engine/previs/manifest';
import type { BenchmarkShotSpec, BenchmarkSpecV1 } from './types';

export interface V3LiteQualityContract {
  hardExecutionFailure: false;
  evidenceFile: string;
  missingEvidence: 'not-graded';
}

export interface V3LiteContract {
  version: 1;
  id: string;
  benchmarkId: 'music-video-v2-panorama-triad';
  manifest: string;
  manifestSha256: string;
  basePackage: string;
  requiredArtifacts: string[];
  requiredStills: string[];
  requiredMotion: string[];
  shots: BenchmarkShotSpec[];
  quality: V3LiteQualityContract;
}

export interface LoadedV3LiteContract {
  contract: V3LiteContract;
  contractPath: string;
  manifestPath: string;
  manifest: PrevisProductionManifestV1;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Frozen production manifest contains a non-JSON value.');
}

/**
 * Hash the parsed manifest semantics, rather than its checkout-dependent bytes.
 * Object key order and LF/CRLF representation therefore do not change identity;
 * any parsed value or array ordering change still changes the hash.
 */
export function v3LiteManifestSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function parseContract(value: unknown): V3LiteContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('V3-Lite contract must be an object.');
  const record = value as Partial<V3LiteContract>;
  if (record.version !== 1) throw new Error('V3-Lite contract version must be 1.');
  if (record.benchmarkId !== 'music-video-v2-panorama-triad') {
    throw new Error('V3-Lite contract benchmarkId must be music-video-v2-panorama-triad.');
  }
  if (!Array.isArray(record.requiredArtifacts) || record.requiredArtifacts.length === 0) {
    throw new Error('V3-Lite contract requires requiredArtifacts.');
  }
  if (!Array.isArray(record.requiredStills) || !Array.isArray(record.requiredMotion)) {
    throw new Error('V3-Lite contract requires requiredStills and requiredMotion.');
  }
  if (!Array.isArray(record.shots) || record.shots.length !== 3) {
    throw new Error('V3-Lite contract requires exactly three frozen shots.');
  }
  if (!record.quality || record.quality.hardExecutionFailure !== false) {
    throw new Error('V3-Lite quality.hardExecutionFailure must be false.');
  }
  if (!/^[^/\\]+$/.test(String(record.quality.evidenceFile ?? ''))) {
    throw new Error('quality.evidenceFile must be a flat relative file name.');
  }
  const shots = record.shots as BenchmarkShotSpec[];
  const shotNumbers = shots.map((shot) => shot.shotNumber).join(',');
  if (shotNumbers !== '01,02,03') throw new Error(`V3-Lite shots must be 01, 02, 03; received ${shotNumbers}.`);
  const requiredArtifacts = record.requiredArtifacts as string[];
  if (!/^[0-9a-f]{64}$/i.test(String(record.manifestSha256 ?? ''))) {
    throw new Error('manifestSha256 must be a 64-character SHA-256 hex string.');
  }
  const invalidArtifactNames = [...requiredArtifacts, ...(record.requiredStills as string[]), ...(record.requiredMotion as string[])]
    .filter((item) => typeof item !== 'string' || item.length === 0 || item.includes('/') || item.includes('\\') || item === '.' || item === '..');
  if (invalidArtifactNames.length > 0) throw new Error(`V3-Lite artifact names must be flat relative names: ${invalidArtifactNames.join(', ')}.`);
  const duplicates = requiredArtifacts.filter((item, index) => requiredArtifacts.indexOf(item) !== index);
  if (duplicates.length > 0) throw new Error(`V3-Lite requiredArtifacts contains duplicates: ${duplicates.join(', ')}.`);
  return {
    version: 1,
    id: asString(record.id, 'id'),
    benchmarkId: 'music-video-v2-panorama-triad',
    manifest: asString(record.manifest, 'manifest'),
    manifestSha256: asString(record.manifestSha256, 'manifestSha256').toLowerCase(),
    basePackage: asString(record.basePackage, 'basePackage'),
    requiredArtifacts,
    requiredStills: record.requiredStills as string[],
    requiredMotion: record.requiredMotion as string[],
    shots,
    quality: {
      hardExecutionFailure: false,
      evidenceFile: asString(record.quality.evidenceFile, 'quality.evidenceFile'),
      missingEvidence: 'not-graded',
    },
  };
}

function resolveWithin(root: string, relative: string, field: string): string {
  if (path.isAbsolute(relative)) throw new Error(`${field} must be relative to the frozen input root.`);
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, relative);
  const relativeTarget = path.relative(rootPath, target);
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new Error(`${field} escapes the frozen input root: ${relative}.`);
  }
  return target;
}

export function resolveV3LiteInputPath(inputRoot: string, relative: string, field: string): string {
  return resolveWithin(inputRoot, relative, field);
}

export async function loadV3LiteContract(contractPath: string): Promise<LoadedV3LiteContract> {
  const resolvedContractPath = path.resolve(contractPath);
  const raw = JSON.parse(await readFile(resolvedContractPath, 'utf8')) as unknown;
  const contract = parseContract(raw);
  const manifestPath = path.resolve(path.dirname(resolvedContractPath), contract.manifest);
  const manifestBytes = await readFile(manifestPath);
  const manifestRaw = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  const manifestHash = v3LiteManifestSha256(manifestRaw);
  if (manifestHash !== contract.manifestSha256) {
    throw new Error(`Checked-in production manifest hash ${manifestHash} does not match frozen contract ${contract.manifestSha256}.`);
  }
  const parsed = parsePrevisProductionManifest(manifestRaw);
  if (!parsed.manifest || parsed.errors.length > 0) {
    throw new Error(`Frozen production manifest is invalid: ${parsed.errors.map((error) => error.message).join('; ')}`);
  }
  const manifestShotNumbers = parsed.manifest.shots.map((shot) => shot.shotNumber).join(',');
  if (manifestShotNumbers !== '01,02,03') {
    throw new Error(`Frozen production manifest shot numbers must be 01, 02, 03; received ${manifestShotNumbers}.`);
  }
  const manifestShotIds = parsed.manifest.shots.map((shot) => shot.id);
  const contractShotIds = contract.shots.map((shot) => shot.id);
  if (manifestShotIds.join(',') !== contractShotIds.join(',')) {
    throw new Error('Frozen production manifest shot ids do not match the V3-Lite contract.');
  }
  const missingStill = contract.requiredStills.filter((artifact) => !contract.requiredArtifacts.includes(artifact));
  const missingMotion = contract.requiredMotion.filter((artifact) => !contract.requiredArtifacts.includes(artifact));
  if (missingStill.length > 0 || missingMotion.length > 0) {
    throw new Error(`V3-Lite artifact subsets are not covered by requiredArtifacts: ${[...missingStill, ...missingMotion].join(', ')}.`);
  }
  return { contract, contractPath: resolvedContractPath, manifestPath, manifest: parsed.manifest };
}

export function resolveV3LiteManifestAssets(
  manifest: PrevisProductionManifestV1,
  inputRoot: string,
): PrevisProductionManifestV1 {
  const resolve = (value: string, field: string) => resolveWithin(inputRoot, value, field);
  return {
    ...structuredClone(manifest),
    cast: manifest.cast.map((character) => {
      if (character.type !== 'imported_character') return character;
      return {
        ...character,
        source: resolve(character.source, `cast.${character.id}.source`),
        ...(character.rigPackage ? { rigPackage: resolve(character.rigPackage, `cast.${character.id}.rigPackage`) } : {}),
      };
    }),
    ...(manifest.assets
      ? {
          assets: manifest.assets.map((asset) => ({
            ...asset,
            ...(asset.source ? { source: resolve(asset.source, `assets.${asset.id}.source`) } : {}),
            ...(asset.rigPackage ? { rigPackage: resolve(asset.rigPackage, `assets.${asset.id}.rigPackage`) } : {}),
          })),
        }
      : {}),
  };
}

export function v3LiteBenchmarkSpec(contract: V3LiteContract): BenchmarkSpecV1 {
  return {
    version: 1,
    id: contract.id,
    name: 'ForeScene music-video panorama-triad V3-Lite',
    description: 'Frozen V3-Lite panorama-triad contract. The candidate owns previs; the harness owns setup and structural bookkeeping.',
    qualityMode: 'production-integrity',
    operatingMode: 'existing-project-refinement',
    writeAuthorized: true,
    resetAuthorized: false,
    repairBudget: 2,
    requiredCliCapabilities: [
      'project.inspect',
      'project.open',
      'project.save',
      'project.applyPlan',
      'render.frame.clay',
      'render.frame.projected',
      'render.video.clay',
      'character.importSavedRig',
      'model.import',
      'shot.panorama',
    ],
    shots: contract.shots,
    requiredArtifacts: contract.requiredArtifacts,
  };
}
