import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { environmentFailure } from './failures';
import { repoRoot } from './layout';

const execFileAsync = promisify(execFile);

export async function gitIdentity(cwd = repoRoot()) {
  try {
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    return {
      commit: commit.trim(),
      dirty: status.trim().length > 0,
    };
  } catch (error) {
    throw new Error(environmentFailure(
      `Could not read git identity: ${error instanceof Error ? error.message : String(error)}`,
    ).message);
  }
}
