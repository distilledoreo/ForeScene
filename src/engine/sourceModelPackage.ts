import JSZip from 'jszip';
import { BRAND } from '../config/brand';
import type { ImportedModelSourceApplication } from '../domain/types';
import type { SourceModelDescriptor, SourceModelFormat } from '../domain/sourceModelTypes';
import type { ModelImportJob } from './modelImport';
import { IMPORT_BUDGET_POLICY } from './modelImportBudget';

export const SOURCE_MODEL_FORMATS: readonly SourceModelFormat[] = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];
export const MODEL_RESOURCE_EXTENSIONS = ['bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'ktx2', 'dds', 'tga', 'bmp', 'gif'];
const MAX_ENTRIES = 512;
const MAX_COMPRESSION_RATIO = 200;

export interface SourceModelPackage {
  bytes: ArrayBuffer;
  format: SourceModelFormat;
  container: 'raw' | 'zip';
  entry: string;
  files: Map<string, ArrayBuffer>;
  sourceName: string;
  sourceApplication?: ImportedModelSourceApplication;
  sourceSceneName?: string;
}

export function checkSourceImportAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
}

/** Canonical archive paths never escape the package, even with JSZip's path sanitization. */
export function sourceResourcePath(input: string): string {
  const path = input.replace(/\\/g, '/');
  if (!path || /[\x00-\x1f]/.test(path) || path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error(`Invalid source resource path: ${input}`);
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`Source resource escapes its package: ${input}`);
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw new Error(`Invalid source resource path: ${input}`);
  return parts.join('/');
}

function filePath(file: File): string {
  return sourceResourcePath(file.webkitRelativePath || file.name);
}

function sourceFormat(name: string): SourceModelFormat {
  const extension = name.split('.').pop()?.toLowerCase();
  if (!SOURCE_MODEL_FORMATS.includes(extension as SourceModelFormat)) {
    throw new Error(`Unsupported source model format: ${name}`);
  }
  return extension as SourceModelFormat;
}

function assertPackageSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > IMPORT_BUDGET_POLICY.maxSourceFileBytes) {
    throw new Error('Source package is empty or exceeds the model import size limit.');
  }
}

export async function readSourceZip(bytes: ArrayBuffer, signal?: AbortSignal): Promise<Map<string, ArrayBuffer>> {
  assertPackageSize(bytes.byteLength);
  checkSourceImportAbort(signal);
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (!entries.length || entries.length > MAX_ENTRIES) throw new Error(`Source package must contain 1–${MAX_ENTRIES} files.`);
  let declaredBytes = 0;
  for (const entry of entries) {
    const raw = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (sourceResourcePath(raw) !== entry.name) throw new Error(`Unsafe source archive entry: ${raw}`);
    const data = (entry as typeof entry & { _data?: { uncompressedSize: number; compressedSize: number } })._data;
    if (!data || !Number.isSafeInteger(data.uncompressedSize) || data.uncompressedSize < 0) {
      throw new Error(`Cannot verify source archive size: ${entry.name}`);
    }
    if (data.uncompressedSize / Math.max(1, data.compressedSize) > MAX_COMPRESSION_RATIO) {
      throw new Error(`Source archive entry has an unsafe compression ratio: ${entry.name}`);
    }
    declaredBytes += data.uncompressedSize;
  }
  assertPackageSize(declaredBytes);
  const files = new Map<string, ArrayBuffer>();
  let actualBytes = 0;
  for (const entry of entries) {
    checkSourceImportAbort(signal);
    const data = await entry.async('arraybuffer');
    actualBytes += data.byteLength;
    if (actualBytes > declaredBytes) throw new Error('Source archive size does not match its directory.');
    files.set(entry.name, data);
  }
  return files;
}

export async function prepareSourceModelPackage(job: ModelImportJob, signal?: AbortSignal): Promise<SourceModelPackage> {
  checkSourceImportAbort(signal);
  assertPackageSize(job.file.size);
  const original = await job.file.arrayBuffer();
  checkSourceImportAbort(signal);
  if (job.kind === 'bundle') {
    const files = await readSourceZip(original, signal);
    const manifestBytes = files.get(BRAND.sceneManifest) ?? files.get(BRAND.legacySceneManifest);
    if (!manifestBytes || manifestBytes.byteLength > 64 * 1024) throw new Error('Source bundle has no valid scene manifest.');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      schemaVersion?: unknown;
      entry?: unknown;
      source?: { application?: ImportedModelSourceApplication; file?: string };
    };
    if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== '1') throw new Error('Unsupported scene bundle version.');
    if (typeof manifest.entry !== 'string') throw new Error('Source bundle has no entry model.');
    const entry = sourceResourcePath(manifest.entry);
    if (!files.has(entry)) throw new Error(`Source bundle is missing ${entry}.`);
    return {
      bytes: original, format: sourceFormat(entry), container: 'zip', entry, files,
      sourceName: job.file.name, sourceApplication: manifest.source?.application,
      sourceSceneName: manifest.source?.file,
    };
  }
  const entry = filePath(job.file);
  const format = sourceFormat(entry);
  const resources = job.resources ?? [];
  const files = new Map<string, ArrayBuffer>([[entry, original]]);
  let totalBytes = original.byteLength;
  if (resources.length + 1 > MAX_ENTRIES) throw new Error(`Select at most ${MAX_ENTRIES} source and companion files.`);
  for (const resource of resources) {
    checkSourceImportAbort(signal);
    const name = filePath(resource);
    if (files.has(name)) throw new Error(`Duplicate source resource path: ${name}. Select an unambiguous package.`);
    totalBytes += resource.size;
    assertPackageSize(totalBytes);
    files.set(name, await resource.arrayBuffer());
  }
  let bytes = original;
  if (resources.length) {
    const zip = new JSZip();
    // Stable order and timestamps make identical model+resource imports deduplicable.
    for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      zip.file(name, data, { date: new Date('1980-01-01T00:00:00Z'), createFolders: false });
    }
    bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
    assertPackageSize(bytes.byteLength);
  }
  checkSourceImportAbort(signal);
  return {
    bytes, format, container: resources.length ? 'zip' : 'raw', entry, files,
    sourceName: job.file.name, sourceApplication: job.sourceApplication,
    sourceSceneName: job.sourceSceneName,
  };
}

export async function reopenSourceModelPackage(
  bytes: ArrayBuffer,
  descriptor: SourceModelDescriptor,
  signal?: AbortSignal,
): Promise<SourceModelPackage> {
  assertPackageSize(bytes.byteLength);
  checkSourceImportAbort(signal);
  if (descriptor.version !== 1 || !SOURCE_MODEL_FORMATS.includes(descriptor.format)) {
    throw new Error('Unsupported preserved-source model version or format.');
  }
  const entry = sourceResourcePath(descriptor.entry);
  if (descriptor.container !== 'raw' && descriptor.container !== 'zip') throw new Error('Unsupported source container.');
  const files = descriptor.container === 'zip' ? await readSourceZip(bytes, signal) : new Map([[entry, bytes]]);
  if (!files.has(entry)) throw new Error(`Preserved source is missing ${entry}.`);
  return { bytes, format: descriptor.format, container: descriptor.container, entry, files, sourceName: entry };
}
