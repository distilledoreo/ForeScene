import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface FileHashRecord {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(absolute));
    else files.push(absolute);
  }
  return files;
}

export async function hashDirectory(root: string): Promise<FileHashRecord[]> {
  const files = (await walkFiles(root)).sort();
  const records: FileHashRecord[] = [];
  for (const absolute of files) {
    const bytes = await readFile(absolute);
    records.push({
      relativePath: path.relative(root, absolute).replaceAll('\\', '/'),
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.byteLength,
    });
  }
  return records;
}

export function unchangedHashes(before: FileHashRecord[], after: FileHashRecord[]): string[] {
  const afterByPath = new Map(after.map((record) => [record.relativePath, record.sha256]));
  return before
    .filter((record) => afterByPath.get(record.relativePath) === record.sha256)
    .map((record) => record.relativePath);
}

export async function fileByteLength(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}
