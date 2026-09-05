/**
 * One-shot cheap-agent runner for Family C import-idempotency benchmarks.
 * Usage: tsx scripts/benchmark/runCheapAgentImport.ts --run-root <path>
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAgentEnvelope, invokeAgentCli } from './agentCli';
import { loadAgenticControlContract, resolveAgenticControlRunPath } from './agenticControlContract';
import { inspectSnapshotFromEnvelope } from './agenticControlInspect';
import type { AgenticControlImportCandidateReport, AgenticControlInvocationRecord } from './agenticControlScorer';
import { repoRoot } from './layout';

async function main(): Promise<void> {
  const runRoot = path.resolve(process.argv.find((arg, index) => process.argv[index - 1] === '--run-root') ?? '');
  if (!runRoot) throw new Error('--run-root is required.');
  const contractPath = process.argv.find((arg, index) => process.argv[index - 1] === '--contract')
    ?? path.join(repoRoot(), 'benchmarks/agentic-control-v3/contract.json');
  const loaded = await loadAgenticControlContract(contractPath);
  if (loaded.contract.family !== 'import-idempotency') {
    throw new Error('runCheapAgentImport requires an import-idempotency contract.');
  }

  const hosted = JSON.parse(await (await import('node:fs/promises')).readFile(
    path.join(runRoot, 'harness/hosted-app.json'),
    'utf8',
  )) as { url: string };
  const evidence = JSON.parse(await (await import('node:fs/promises')).readFile(
    path.join(runRoot, 'harness/evidence.json'),
    'utf8',
  )) as { runId: string };

  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/home/distilledoreo/.cache/ms-playwright',
    FORESCENE_BENCHMARK: '1',
    FORESCENE_BENCHMARK_FAMILY: loaded.contract.family,
    FORESCENE_BENCHMARK_CONTRACT: path.join(runRoot, 'harness/contract.json'),
    FORESCENE_BENCHMARK_BRIEF: path.join(runRoot, 'harness/BRIEF.md'),
    FORESCENE_REPO_ROOT: repoRoot(),
    FORESCENE_URL: hosted.url,
    FORESCENE_PROFILE: path.join(runRoot, 'profile'),
    FORESCENE_OUTPUT: path.join(runRoot, 'work/artifacts'),
    FORESCENE_EVIDENCE_DIR: path.join(runRoot, 'harness/evidence/cli'),
    FORESCENE_EVIDENCE_RUN_ID: evidence.runId,
  };

  const invocations: AgenticControlInvocationRecord[] = [];
  const common = {
    repoRoot: repoRoot(),
    url: hosted.url,
    profile: path.join(runRoot, 'profile'),
    cwd: repoRoot(),
    env,
  };

  const call = async (step: string, npmScript: string, args: string[]) => {
    const invocation = await invokeAgentCli({ ...common, args: [npmScript, ...args] });
    const envelope = invocation.envelope ?? extractAgentEnvelope(invocation.stdout);
    invocations.push({
      step,
      npmScript,
      exitCode: invocation.code,
      envelopeOk: envelope?.ok === true,
    });
    if (invocation.code !== 0 || envelope?.ok === false) {
      throw new Error(`${step} failed: ${envelope?.error?.message ?? invocation.stderr.slice(-400)}`);
    }
    return envelope!;
  };

  const seedPath = path.join(runRoot, 'project', path.basename(loaded.seedPath));
  const modelPath = resolveAgenticControlRunPath(runRoot, loaded.contract.importModel.runRelativePath);
  const savedProject = resolveAgenticControlRunPath(runRoot, loaded.contract.artifacts.savedProject);

  await call('open-seed', 'open', ['--file', seedPath, '--write']);
  const inspectSeed = inspectSnapshotFromEnvelope(await call('inspect-seed', 'inspect', ['--document']))!;
  await call('import-first', 'import-model', ['--file', modelPath, '--write']);
  const inspectAfterFirst = inspectSnapshotFromEnvelope(await call('inspect-after-first', 'inspect', ['--document']))!;
  await call('import-second', 'import-model', ['--file', modelPath, '--write']);
  const inspectAfterSecond = inspectSnapshotFromEnvelope(await call('inspect-after-second', 'inspect', ['--document']))!;
  await call('save', 'save', ['--output', savedProject, '--write']);

  const report: AgenticControlImportCandidateReport = {
    runner: 'cheap-agent',
    invocations,
    inspectSeed,
    inspectAfterFirst,
    inspectAfterSecond,
  };

  const reportPath = resolveAgenticControlRunPath(runRoot, loaded.contract.artifacts.candidateReport);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${reportPath}\n`);
  process.stdout.write(`counts seed=${inspectSeed.assetCount}/${inspectSeed.importedModelCount} first=${inspectAfterFirst.assetCount}/${inspectAfterFirst.importedModelCount} second=${inspectAfterSecond.assetCount}/${inspectAfterSecond.importedModelCount}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
