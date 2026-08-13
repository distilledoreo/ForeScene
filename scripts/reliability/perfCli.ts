/**
 * Summarize soak timings. Measure first; do not optimize by retrying.
 *
 *   npm run reliability:perf
 *   npm run reliability:perf -- --report artifacts/reliability/soak.json
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeSoakTiming } from './perf';
import { runReliabilitySoak } from './soak';
import type { SoakReport } from './types';

function parseArgs(argv: string[]) {
  const args = { report: undefined as string | undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--report') args.report = argv[++index];
  }
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const report: SoakReport = args.report
    ? JSON.parse(await readFile(path.resolve(args.report), 'utf8')) as SoakReport
    : await runReliabilitySoak({});
  const timing = summarizeSoakTiming(report);
  process.stdout.write(`${JSON.stringify(timing, null, 2)}\n`);
  if (!timing.ok) {
    process.stderr.write('Soak timings include retries. Do not treat a retried pass as a performance win.\n');
    return 1;
  }
  return report.ok ? 0 : 1;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url)
    || entry.replaceAll('\\', '/').endsWith('scripts/reliability/perfCli.ts');
}

if (isDirectRun()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
