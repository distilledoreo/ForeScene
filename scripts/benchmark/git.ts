import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { environmentFailure } from './failures';
import { repoRoot } from './layout';
import type { BenchmarkFailure } from './types';

const execFileAsync = promisify(execFile);

export interface GitIdentityRecord {
  commit: string;
  dirty: boolean;
  porcelain: string;
  expectedCommit: string;
  allowDirty: boolean;
}

export function allowDirtyWorkingTree(): boolean {
  return process.env.FORESCENE_BENCHMARK_ALLOW_DIRTY === '1';
}

export async function gitIdentity(cwd = repoRoot()): Promise<GitIdentityRecord> {
  try {
    const { stdout: commitRaw } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    const commit = commitRaw.trim();
    const porcelain = status.trim();
    return {
      commit,
      dirty: porcelain.length > 0,
      porcelain,
      expectedCommit: (process.env.FORESCENE_BENCHMARK_EXPECTED_COMMIT ?? commit).trim(),
      allowDirty: allowDirtyWorkingTree(),
    };
  } catch (error) {
    throw new Error(environmentFailure(
      `Could not read git identity: ${error instanceof Error ? error.message : String(error)}`,
    ).message);
  }
}

export function enforceGitIdentity(record: GitIdentityRecord): BenchmarkFailure | undefined {
  if (record.expectedCommit && record.commit !== record.expectedCommit) {
    return environmentFailure(
      `ForeScene HEAD ${record.commit} does not match expected commit ${record.expectedCommit}.`,
    );
  }
  if (record.dirty && !record.allowDirty) {
    return environmentFailure(
      `ForeScene working tree is dirty; refuse to run the benchmark.\n${record.porcelain}`,
    );
  }
  return undefined;
}

export function unauthorizedRepoModifications(
  before: GitIdentityRecord,
  after: GitIdentityRecord,
): BenchmarkFailure | undefined {
  if (after.commit !== before.commit) {
    return environmentFailure(
      `ForeScene HEAD changed during the run (${before.commit} → ${after.commit}).`,
    );
  }
  if (after.porcelain === before.porcelain) return undefined;
  const beforeLines = new Set(before.porcelain.split('\n').filter(Boolean));
  const added = after.porcelain.split('\n').filter((line) => line && !beforeLines.has(line));
  if (added.length === 0) return undefined;
  return environmentFailure(
    `Unauthorized ForeScene source/harness modifications after the candidate:\n${added.join('\n')}`,
  );
}
