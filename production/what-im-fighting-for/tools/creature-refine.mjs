/**
 * Compatibility entry point for the retired creature-specific refinement helper.
 *
 * The guarded existing-project workflow now lives in `npm run agent:refine`.
 * Keep this small wrapper for production runbooks that still reference this path;
 * all importing, proxy replacement, review rendering, and package verification is
 * performed by the supported agent command and its supplied refinement plan.
 *
 * Usage:
 *   node production/what-im-fighting-for/tools/creature-refine.mjs \
 *     --plan production/refinement-plan.json \
 *     --batch batch-01 --write --output artifacts/refinement
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const USAGE = `Usage:
  node production/what-im-fighting-for/tools/creature-refine.mjs \\
    --plan <refinement-plan.json> \\
    (--batch <batch-id> | --approve <batch-id> | --finalize) \\
    --output <evidence-directory> [--write] [--persist-write] [--url <url>] \\
    [--profile <directory>] [--headless] [--allow-heavy-character-imports] \\
    [--allow-heavy-imports] [--dry-run]

This compatibility wrapper forwards to: npm run agent:refine -- ...
It no longer contains creature-specific asset paths or project mutation logic.`;

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(argv) {
  const forwarded = [];
  let plan;
  let output;
  let actionCount = 0;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '--plan' || token === '--output' || token === '--batch' || token === '--approve'
      || token === '--url' || token === '--profile') {
      const value = requireValue(argv, index, token);
      forwarded.push(token, value);
      if (token === '--plan') plan = value;
      if (token === '--output') output = value;
      if (token === '--batch' || token === '--approve') actionCount += 1;
      index += 1;
      continue;
    }
    if (token === '--finalize') {
      forwarded.push(token);
      actionCount += 1;
      continue;
    }
    if (token === '--write' || token === '--persist-write' || token === '--headless'
      || token === '--allow-heavy-character-imports' || token === '--allow-heavy-imports') {
      forwarded.push(token);
      continue;
    }
    throw new Error(`Unknown flag: ${token}`);
  }

  if (!plan) throw new Error('--plan is required.');
  if (!output) throw new Error('--output is required.');
  if (actionCount !== 1) throw new Error('Provide exactly one of --batch, --approve, or --finalize.');
  return { forwarded, dryRun };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['run', 'agent:refine', '--', ...parsed.forwarded];
  if (parsed.dryRun) {
    console.log(JSON.stringify({ executable, args, cwd: REPO_ROOT }, null, 2));
    return;
  }

  const child = spawn(executable, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
