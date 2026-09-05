import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrevisAssetDefinition, PrevisCharacterDefinition, PrevisLocationDefinition, PrevisProductionManifestV1, PrevisPropDefinition } from '../../src/engine/previs/manifest';
import type { BenchmarkShotSpec } from './types';
import type { V3LiteContract } from './v3LiteContract';

export interface V3AgentQualityContract {
  hardExecutionFailure: false;
  evidenceFile: string;
  missingEvidence: 'not-graded';
}

export interface V3AgentShotContract extends BenchmarkShotSpec {
  locationId: string;
  subjects: string[];
  durationSeconds?: number;
}

export interface V3AgentContract {
  version: 1;
  id: string;
  benchmarkId: 'music-video-v2-panorama-triad';
  basePackage: string;
  project: PrevisProductionManifestV1['project'];
  locations: PrevisLocationDefinition[];
  cast: PrevisCharacterDefinition[];
  assets: PrevisAssetDefinition[];
  props: PrevisPropDefinition[];
  knownSubjects: string[];
  requiredArtifacts: string[];
  requiredStills: string[];
  requiredMotion: string[];
  shots: V3AgentShotContract[];
  quality: V3AgentQualityContract;
}

export interface V3AgentIntentShot {
  shotNumber: string;
  title: string;
  assignment: string;
  continuity: string[];
  locationNote: string;
  requiredSubjects: string[];
  deliverables: string[];
  durationSeconds?: number;
}

export interface V3AgentIntent {
  version: 1;
  shots: V3AgentIntentShot[];
}

export interface LoadedV3AgentContract {
  contract: V3AgentContract;
  intent: V3AgentIntent;
  contractPath: string;
  intentPath: string;
  taskPath: string;
}

const FORBIDDEN_INTENT_KEYS = new Set([
  'template', 'angle', 'lensclass', 'lens', 'fov', 'fovdegrees',
  'position', 'target', 'transform', 'keyframes', 'blocking',
  'placement', 'slot', 'camera', 'motion', 'motionpath',
  'worldposition', 'cameraposition', 'cameratarget', 'blockingslot',
]);

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  return value as string[];
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

export function resolveV3AgentInputPath(inputRoot: string, relative: string, field: string): string {
  return resolveWithin(inputRoot, relative, field);
}

function normalizeIntentKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function collectIntentSolutionLeaks(value: unknown, trail = '$'): string[] {
  const leaks: string[] = [];
  if (Array.isArray(value)) {
    if (value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      leaks.push(`${trail}: numeric world coordinate triple`);
    }
    value.forEach((item, index) => leaks.push(...collectIntentSolutionLeaks(item, `${trail}[${index}]`)));
    return leaks;
  }
  if (!value || typeof value !== 'object') return leaks;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeIntentKey(key);
    if (FORBIDDEN_INTENT_KEYS.has(normalized)) leaks.push(`${trail}.${key}: forbidden solution field`);
    leaks.push(...collectIntentSolutionLeaks(child, `${trail}.${key}`));
  }
  return leaks;
}

function parseIntent(value: unknown): V3AgentIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('V3-Agent intent must be an object.');
  const record = value as { version?: unknown; shots?: unknown };
  if (record.version !== 1) throw new Error('V3-Agent intent version must be 1.');
  if (!Array.isArray(record.shots) || record.shots.length !== 3) throw new Error('V3-Agent intent requires exactly three shots.');
  const shots = record.shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) throw new Error(`intent.shots[${index}] must be an object.`);
    const item = shot as Record<string, unknown>;
    const parsed: V3AgentIntentShot = {
      shotNumber: asString(item.shotNumber, `intent.shots[${index}].shotNumber`),
      title: asString(item.title, `intent.shots[${index}].title`),
      assignment: asString(item.assignment, `intent.shots[${index}].assignment`),
      continuity: asStringArray(item.continuity, `intent.shots[${index}].continuity`),
      locationNote: asString(item.locationNote, `intent.shots[${index}].locationNote`),
      requiredSubjects: asStringArray(item.requiredSubjects, `intent.shots[${index}].requiredSubjects`),
      deliverables: asStringArray(item.deliverables, `intent.shots[${index}].deliverables`),
      ...(typeof item.durationSeconds === 'number' ? { durationSeconds: item.durationSeconds } : {}),
    };
    return parsed;
  });
  if (shots.map((shot) => shot.shotNumber).join(',') !== '01,02,03') {
    throw new Error('V3-Agent intent shots must be 01, 02, 03.');
  }
  if (shots[1]?.durationSeconds !== 3) throw new Error('V3-Agent intent Shot 02 durationSeconds must be 3.');
  const leaks = collectIntentSolutionLeaks(value);
  if (leaks.length > 0) throw new Error(`V3-Agent intent leaks solution fields: ${leaks.join('; ')}`);
  return { version: 1, shots };
}

function parseContract(value: unknown): V3AgentContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('V3-Agent contract must be an object.');
  const record = value as Partial<V3AgentContract>;
  if (record.version !== 1) throw new Error('V3-Agent contract version must be 1.');
  if (record.benchmarkId !== 'music-video-v2-panorama-triad') {
    throw new Error('V3-Agent contract benchmarkId must be music-video-v2-panorama-triad.');
  }
  if (!Array.isArray(record.requiredArtifacts) || !Array.isArray(record.requiredStills) || !Array.isArray(record.requiredMotion)) {
    throw new Error('V3-Agent contract requires requiredArtifacts, requiredStills, and requiredMotion.');
  }
  if (!Array.isArray(record.shots) || record.shots.length !== 3) throw new Error('V3-Agent contract requires exactly three shots.');
  if (!record.quality || record.quality.hardExecutionFailure !== false) {
    throw new Error('V3-Agent quality.hardExecutionFailure must be false.');
  }
  const shotNumbers = (record.shots as V3AgentShotContract[]).map((shot) => shot.shotNumber).join(',');
  if (shotNumbers !== '01,02,03') throw new Error(`V3-Agent shots must be 01, 02, 03; received ${shotNumbers}.`);
  if ((record.shots as V3AgentShotContract[])[1]?.durationSeconds !== 3) {
    throw new Error('V3-Agent contract Shot 02 durationSeconds must be 3.');
  }
  if (!Array.isArray(record.knownSubjects) || record.knownSubjects.length === 0) {
    throw new Error('V3-Agent contract requires knownSubjects.');
  }
  return {
    version: 1,
    id: asString(record.id, 'id'),
    benchmarkId: 'music-video-v2-panorama-triad',
    basePackage: asString(record.basePackage, 'basePackage'),
    project: record.project as V3AgentContract['project'],
    locations: record.locations as V3AgentContract['locations'],
    cast: record.cast as V3AgentContract['cast'],
    assets: record.assets as V3AgentContract['assets'],
    props: record.props as V3AgentContract['props'],
    knownSubjects: record.knownSubjects as string[],
    requiredArtifacts: record.requiredArtifacts,
    requiredStills: record.requiredStills,
    requiredMotion: record.requiredMotion,
    shots: record.shots as V3AgentShotContract[],
    quality: {
      hardExecutionFailure: false,
      evidenceFile: asString(record.quality.evidenceFile, 'quality.evidenceFile'),
      missingEvidence: 'not-graded',
    },
  };
}

export async function loadV3AgentContract(contractPath: string): Promise<LoadedV3AgentContract> {
  const resolvedContractPath = path.resolve(contractPath);
  const contractDir = path.dirname(resolvedContractPath);
  const contract = parseContract(JSON.parse(await readFile(resolvedContractPath, 'utf8')) as unknown);
  const intentPath = path.join(contractDir, 'intent.json');
  const taskPath = path.join(contractDir, 'task.md');
  const intent = parseIntent(JSON.parse(await readFile(intentPath, 'utf8')) as unknown);
  const missingStill = contract.requiredStills.filter((artifact) => !contract.requiredArtifacts.includes(artifact));
  const missingMotion = contract.requiredMotion.filter((artifact) => !contract.requiredArtifacts.includes(artifact));
  if (missingStill.length > 0 || missingMotion.length > 0) {
    throw new Error(`V3-Agent artifact subsets are not covered by requiredArtifacts: ${[...missingStill, ...missingMotion].join(', ')}.`);
  }
  return { contract, intent, contractPath: resolvedContractPath, intentPath, taskPath };
}

export function v3AgentRequiredFiles(contract: V3AgentContract, inputRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  files.set('base-package', resolveV3AgentInputPath(inputRoot, contract.basePackage, 'basePackage'));
  for (const character of contract.cast) {
    if (character.type !== 'imported_character') continue;
    files.set(`cast.${character.id}.source`, resolveV3AgentInputPath(inputRoot, character.source, `cast.${character.id}.source`));
    if (character.rigPackage) {
      files.set(`cast.${character.id}.rigPackage`, resolveV3AgentInputPath(inputRoot, character.rigPackage, `cast.${character.id}.rigPackage`));
    }
  }
  for (const asset of contract.assets) {
    if (asset.source) files.set(`assets.${asset.id}.source`, resolveV3AgentInputPath(inputRoot, asset.source, `assets.${asset.id}.source`));
    if (asset.rigPackage) files.set(`assets.${asset.id}.rigPackage`, resolveV3AgentInputPath(inputRoot, asset.rigPackage, `assets.${asset.id}.rigPackage`));
  }
  return files;
}

export function resolveV3AgentManifestAssets(
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

/** Present the V3-Agent contract in the shape existing V3-Lite graders already consume. */
export function v3AgentAsLiteContract(contract: V3AgentContract): V3LiteContract {
  return {
    version: 1,
    id: contract.id,
    benchmarkId: 'music-video-v2-panorama-triad',
    manifest: 'candidate-production-manifest.json',
    manifestSha256: '0'.repeat(64),
    basePackage: contract.basePackage,
    requiredArtifacts: contract.requiredArtifacts,
    requiredStills: contract.requiredStills,
    requiredMotion: contract.requiredMotion,
    shots: contract.shots.map((shot) => ({
      id: shot.id,
      shotNumber: shot.shotNumber,
      name: shot.name,
      description: shot.description,
      intent: shot.intent,
      requiredSubjects: shot.requiredSubjects,
      stillArtifacts: shot.stillArtifacts,
      ...(shot.motionArtifacts ? { motionArtifacts: shot.motionArtifacts } : {}),
    })),
    quality: contract.quality,
  };
}
