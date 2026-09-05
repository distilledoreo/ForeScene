import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { InspectSnapshot } from './agenticControlInspect';

export type BenchmarkArtifactKind = 'png' | 'fsp' | 'package-zip';

export interface BenchmarkArtifactEvidence {
  path: string;
  kind: BenchmarkArtifactKind;
  bytes: number;
  sha256: string;
  valid: boolean;
  message: string;
  width?: number;
  height?: number;
  entries?: string[];
  projectSnapshot?: InspectSnapshot;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0 || !bytes.includes(Buffer.from('IEND'))) return undefined;
  return { width, height };
}

function snapshotFromProjectDocument(value: unknown): InspectSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const project = value as Record<string, unknown>;
  if (typeof project.id !== 'string') return undefined;
  const scene = project.scene && typeof project.scene === 'object'
    ? project.scene as Record<string, unknown>
    : undefined;
  const objects = Array.isArray(scene?.objects) ? scene.objects : [];
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const assetsContainer = project.assets && typeof project.assets === 'object'
    ? project.assets as Record<string, unknown>
    : undefined;
  const assets = assetsContainer?.assets && typeof assetsContainer.assets === 'object'
    ? Object.keys(assetsContainer.assets as Record<string, unknown>)
    : [];
  return {
    projectId: project.id,
    shotIds: shots.flatMap((shot) => (
      shot && typeof shot === 'object' && typeof (shot as Record<string, unknown>).id === 'string'
        ? [(shot as Record<string, unknown>).id as string]
        : []
    )).sort(),
    castCount: objects.filter((object) => {
      if (!object || typeof object !== 'object') return false;
      const type = (object as Record<string, unknown>).type;
      return type === 'human_dummy' || type === 'poseable_character';
    }).length,
    assetCount: assets.length,
    importedModelCount: objects.filter((object) => (
      object && typeof object === 'object' && (object as Record<string, unknown>).type === 'imported_model'
    )).length,
  };
}

export async function inspectBenchmarkArtifact(input: {
  runRoot: string;
  filePath: string;
  kind: BenchmarkArtifactKind;
  minBytes: number;
}): Promise<BenchmarkArtifactEvidence> {
  const runRoot = await realpath(input.runRoot);
  const info = await lstat(input.filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Artifact is not a regular non-symlink file: ${input.filePath}`);
  }
  const resolved = await realpath(input.filePath);
  if (!contained(runRoot, resolved)) throw new Error(`Artifact escapes the run root: ${input.filePath}`);
  const bytes = await readFile(resolved);
  const base = {
    path: resolved,
    kind: input.kind,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (bytes.byteLength <= input.minBytes) {
    return { ...base, valid: false, message: `Artifact is ${bytes.byteLength} bytes; need > ${input.minBytes}.` };
  }

  if (input.kind === 'png') {
    const dimensions = pngDimensions(bytes);
    return dimensions
      ? { ...base, ...dimensions, valid: true, message: `Valid ${dimensions.width}×${dimensions.height} PNG.` }
      : { ...base, valid: false, message: 'Artifact is not a structurally valid PNG.' };
  }

  try {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const entries = Object.keys(zip.files).sort();
    if (input.kind === 'fsp') {
      const projectEntry = zip.file('project.json');
      if (!projectEntry || !zip.file('integrity.json')) {
        return { ...base, entries, valid: false, message: 'FSP is missing project.json or integrity.json.' };
      }
      const projectSnapshot = snapshotFromProjectDocument(JSON.parse(await projectEntry.async('string')));
      return projectSnapshot
        ? { ...base, entries, projectSnapshot, valid: true, message: `Valid FSP with ${entries.length} entries.` }
        : { ...base, entries, valid: false, message: 'FSP project.json has an invalid project document.' };
    }
    const hasManifest = entries.some((entry) => entry.endsWith('/manifest.json'));
    const hasViewport = entries.some((entry) => entry.endsWith('/inputs/viewport_clay.png'));
    return hasManifest && hasViewport
      ? { ...base, entries, valid: true, message: `Valid package ZIP with ${entries.length} entries.` }
      : { ...base, entries, valid: false, message: 'Package ZIP is missing a shot manifest or clay viewport.' };
  } catch (error) {
    return {
      ...base,
      valid: false,
      message: `Artifact ZIP validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
