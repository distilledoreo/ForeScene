import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { FORBIDDEN_CANDIDATE_FILENAMES } from './types';

export interface ForbiddenFileHit {
  relativePath: string;
  reason: string;
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

export async function findForbiddenCandidateFiles(workDir: string): Promise<ForbiddenFileHit[]> {
  const files = await walkFiles(workDir);
  const hits: ForbiddenFileHit[] = [];
  for (const absolute of files) {
    const relativePath = path.relative(workDir, absolute).replaceAll('\\', '/');
    const base = path.basename(absolute);
    if ((FORBIDDEN_CANDIDATE_FILENAMES as readonly string[]).includes(base)) {
      hits.push({
        relativePath,
        reason: `Candidate must not create harness glue (${base}). Use documented npm run agent:* commands.`,
      });
      continue;
    }
    if (!/\.(ts|js|mjs|cjs)$/.test(base)) continue;
    const source = await readFile(absolute, 'utf8').catch(() => '');
    if (source.includes('window.foreScene') || source.includes('from \'../../src/engine/agent') || source.includes('from "../../src/engine/agent')) {
      hits.push({
        relativePath,
        reason: 'Candidate scripts must not call window.foreScene or import ForeScene source modules.',
      });
    }
  }
  return hits;
}

export async function pathIsNonemptyFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
