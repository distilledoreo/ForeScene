import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunRoot, repoRoot } from './layout';
import { prepareV3LiteRun } from './v3LiteRun';
import { runV3LiteDoctor } from './v3LiteDoctor';

function parseArgs(argv: string[]) {
  const args = {
    contractPath: process.env.FORESCENE_BENCHMARK_CONTRACT ?? path.join(repoRoot(), 'benchmarks', 'panorama-triad-v3-lite', 'contract.json'),
    inputRoot: process.env.FORESCENE_BENCHMARK_INPUT_ROOT ?? '',
    runRoot: undefined as string | undefined,
    url: process.env.FORESCENE_URL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--contract') args.contractPath = argv[++index]!;
    else if (token === '--input-root') args.inputRoot = argv[++index]!;
    else if (token === '--run-root') args.runRoot = argv[++index];
    else if (token === '--url') args.url = argv[++index];
  }
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!args.inputRoot) throw new Error('Benchmark V3-Lite doctor requires --input-root or FORESCENE_BENCHMARK_INPUT_ROOT.');
  const prepared = await prepareV3LiteRun({
    contractPath: path.resolve(args.contractPath),
    inputRoot: path.resolve(args.inputRoot),
    runRoot: args.runRoot ? path.resolve(args.runRoot) : defaultRunRoot('music-video-v2-panorama-triad-v3-lite-doctor'),
    url: args.url,
  });
  const result = await runV3LiteDoctor({
    contractPath: args.contractPath,
    inputRoot: args.inputRoot,
    url: args.url,
    layout: prepared.layout,
    loaded: prepared.loaded,
    git: prepared.git,
  });
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  return result.failure ? 1 : 0;
}

const entry = process.argv[1];
if (entry && (path.resolve(entry) === fileURLToPath(import.meta.url) || entry.replaceAll('\\', '/').endsWith('scripts/benchmark/doctor.ts'))) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
