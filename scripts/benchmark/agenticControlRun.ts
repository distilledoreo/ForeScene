import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentCliEnvelope } from '../agent/cliResult';
import { extractAgentEnvelope, invokeAgentCli } from './agentCli';
import { buildAgenticControlSeed, buildAgenticControlSeedForContract } from './buildAgenticControlSeed';
import {
  loadAgenticControlContract,
  isFreshProfileRecoveryContract,
  isImportIdempotencyContract,
  resolveAgenticControlRunPath,
  type LoadedAgenticControlContract,
} from './agenticControlContract';
import {
  capabilitiesExportPackage,
  inspectSnapshotFromEnvelope,
  type InspectSnapshot,
} from './agenticControlInspect';
import {
  scoreAgenticControlRun,
  type AgenticControlCandidateReport,
  type AgenticControlFreshProfileCandidateReport,
  type AgenticControlImportCandidateReport,
  type AgenticControlInvocationRecord,
  type AgenticControlLifecycleCandidateReport,
} from './agenticControlScorer';
import { createBenchmarkRunLayout, repoRoot } from './layout';
import { gitIdentity, type GitIdentityRecord } from './git';

const DEFAULT_BENCHMARK_BASE = '/home/distilledoreo/forescene-benchmarks';
const HOSTED_PORTS = [3047, 3048, 3045] as const;
const PLAYWRIGHT_BROWSERS_PATH = '/home/distilledoreo/.cache/ms-playwright';
const FORESCENE_APP_ROOT = '/home/distilledoreo/forescene-app';

export interface AgenticControlPreparedRun {
  layout: Awaited<ReturnType<typeof createBenchmarkRunLayout>>;
  loaded: LoadedAgenticControlContract;
  git: GitIdentityRecord;
  url: string;
  seedPackage: string;
  evidenceRunId: string;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function ensureRepoMounted(): Promise<void> {
  try {
    await stat(repoRoot());
  } catch {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('udisksctl', ['mount', '-b', '/dev/sda1'], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`udisksctl exited ${code}`))));
    });
  }
}

async function hostedAppResponsive(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes('ForeScene') || body.includes('id="root"') || body.includes("id='root'");
  } catch {
    return false;
  }
}

async function findHostedAppUrl(): Promise<{ url: string; child?: ReturnType<typeof spawn> }> {
  for (const port of HOSTED_PORTS) {
    const url = `http://127.0.0.1:${port}`;
    if (await hostedAppResponsive(url)) return { url };
  }

  let port = 3050;
  while (port < 3099) {
    const url = `http://127.0.0.1:${port}`;
    if (await hostedAppResponsive(url)) return { url };
    port += 1;
  }

  const launchPort = port;
  const url = `http://127.0.0.1:${launchPort}`;
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(launchPort), '--host', '127.0.0.1'], {
    cwd: FORESCENE_APP_ROOT,
    env: { ...process.env, DISABLE_HMR: 'true' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await hostedAppResponsive(url)) return { url, child };
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Hosted ForeScene did not become responsive at ${url} within 90s.`);
}

async function nextRunRoot(contractId: string, base = DEFAULT_BENCHMARK_BASE): Promise<string> {
  await mkdir(base, { recursive: true });
  const entries = await readdir(base).catch(() => [] as string[]);
  const escaped = contractId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d+)$`);
  let max = 0;
  for (const entry of entries) {
    const match = entry.match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return path.join(base, `${contractId}-${String(max + 1).padStart(2, '0')}`);
}

async function ensureFreshRunRoot(runRoot: string): Promise<void> {
  try {
    const info = await stat(runRoot);
    if (!info.isDirectory()) throw new Error(`Run root is not a directory: ${runRoot}`);
    const entries = await readdir(runRoot);
    if (entries.length > 0) throw new Error(`Run root must be fresh and empty: ${runRoot}`);
  } catch (error) {
    if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
    throw error;
  }
}

async function ensureSeedPackage(loaded: LoadedAgenticControlContract): Promise<void> {
  try {
    const info = await stat(loaded.seedPath);
    if (info.isFile() && info.size > 1024) return;
  } catch {
    // build below
  }
  await buildAgenticControlSeedForContract(loaded.contract.id, path.dirname(loaded.seedPath));
}

function agentEnv(prepared: AgenticControlPreparedRun): NodeJS.ProcessEnv {
  const outputDir = isImportIdempotencyContract(prepared.loaded.contract)
    || isFreshProfileRecoveryContract(prepared.loaded.contract)
    ? path.join(prepared.layout.runRoot, 'work', 'artifacts')
    : path.dirname(resolveAgenticControlRunPath(
      prepared.layout.runRoot,
      prepared.loaded.contract.render.artifact,
    ));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH,
    FORESCENE_BENCHMARK: '1',
    FORESCENE_BENCHMARK_FAMILY: prepared.loaded.contract.family,
    FORESCENE_BENCHMARK_CONTRACT: path.join(prepared.layout.harnessDir, 'contract.json'),
    FORESCENE_BENCHMARK_BRIEF: path.join(prepared.layout.harnessDir, 'BRIEF.md'),
    FORESCENE_REPO_ROOT: repoRoot(),
    FORESCENE_URL: prepared.url,
    FORESCENE_PROFILE: prepared.layout.profileDir,
    FORESCENE_OUTPUT: outputDir,
    FORESCENE_EVIDENCE_DIR: prepared.layout.evidenceDir,
    FORESCENE_EVIDENCE_RUN_ID: prepared.evidenceRunId,
  };
  if (isFreshProfileRecoveryContract(prepared.loaded.contract)) {
    env.FORESCENE_PROFILE_FRESH = prepared.layout.freshProfileDir;
  }
  return env;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function prepareAgenticControlRun(input: {
  contractPath: string;
  runRoot: string;
  url?: string;
}): Promise<AgenticControlPreparedRun> {
  await ensureRepoMounted();
  const runRoot = path.resolve(input.runRoot);
  await ensureFreshRunRoot(runRoot);
  const loaded = await loadAgenticControlContract(input.contractPath);
  await ensureSeedPackage(loaded);

  const layout = await createBenchmarkRunLayout(runRoot);
  const git = await gitIdentity();
  await writeFile(layout.gitPath, `${JSON.stringify(git, null, 2)}\n`, 'utf8');

  const seedPackage = path.join(layout.projectDir, path.basename(loaded.seedPath));
  await copyFile(loaded.seedPath, seedPackage);
  if (isImportIdempotencyContract(loaded.contract)) {
    if (!loaded.importFixturePath) throw new Error('Import fixture path is missing for v3 contract.');
    const modelTarget = path.join(runRoot, loaded.contract.importModel.runRelativePath);
    await copyFile(loaded.importFixturePath, modelTarget);
    await mkdir(path.join(layout.workDir, 'artifacts'), { recursive: true });
  }
  if (isFreshProfileRecoveryContract(loaded.contract)) {
    await mkdir(path.join(layout.workDir, 'artifacts'), { recursive: true });
  }
  await copyFile(loaded.contractPath, path.join(layout.harnessDir, 'contract.json'));
  await copyFile(
    path.join(path.dirname(loaded.contractPath), 'BRIEF.md'),
    path.join(layout.harnessDir, 'BRIEF.md'),
  );

  const hosted = input.url
    ? { url: input.url }
    : await findHostedAppUrl();
  await writeFile(path.join(layout.harnessDir, 'hosted-app.json'), `${JSON.stringify({
    url: hosted.url,
    preparedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  const evidenceRunId = randomUUID();
  const [contractBytes, seedBytes] = await Promise.all([
    readFile(loaded.contractPath),
    readFile(seedPackage),
  ]);
  await writeFile(layout.evidenceManifestPath, `${JSON.stringify({
    version: 1,
    runId: evidenceRunId,
    preparedAt: new Date().toISOString(),
    benchmark: {
      id: loaded.contract.id,
      family: loaded.contract.family,
      contractSha256: sha256(contractBytes),
    },
    repository: { commit: git.commit, porcelain: git.porcelain },
    seed: {
      path: path.relative(runRoot, seedPackage),
      bytes: seedBytes.byteLength,
      sha256: sha256(seedBytes),
    },
  }, null, 2)}\n`, 'utf8');
  const baseBrief = await readFile(path.join(path.dirname(loaded.contractPath), 'BRIEF.md'), 'utf8');
  const freshProfileLine = isFreshProfileRecoveryContract(loaded.contract)
    ? `\n- Fresh profile: \`${layout.freshProfileDir}\` (\`FORESCENE_PROFILE_FRESH\`)`
    : '';
  await writeFile(path.join(layout.harnessDir, 'BRIEF.md'), `${baseBrief.trimEnd()}

## Harness-provided run values

- Repository: \`${repoRoot()}\`
- URL: \`${hosted.url}\`
- Profile: \`${layout.profileDir}\` (\`FORESCENE_PROFILE\`)${freshProfileLine}
- Seed package: \`${seedPackage}\`
- Run root: \`${runRoot}\`
- Evidence directory: \`${layout.evidenceDir}\`
- Evidence run id: \`${evidenceRunId}\`

Set \`FORESCENE_EVIDENCE_DIR\` and \`FORESCENE_EVIDENCE_RUN_ID\` to the values above for every Agent CLI invocation. These enable passive harness capture and do not alter command behavior.
`, 'utf8');

  return {
    layout,
    loaded,
    git,
    url: hosted.url,
    seedPackage,
    evidenceRunId,
  };
}

export function printAgenticControlBrief(prepared: AgenticControlPreparedRun): void {
  const briefPath = path.join(prepared.layout.harnessDir, 'BRIEF.md');
  const contractPath = path.join(prepared.layout.harnessDir, 'contract.json');
  process.stdout.write(`# Agentic control brief\n\n`);
  process.stdout.write(`Run root: ${prepared.layout.runRoot}\n`);
  process.stdout.write(`URL: ${prepared.url}\n`);
  process.stdout.write(`Profile: ${prepared.layout.profileDir}\n`);
  process.stdout.write(`Seed: ${prepared.seedPackage}\n`);
  process.stdout.write(`Brief: ${briefPath}\n`);
  process.stdout.write(`Contract: ${contractPath}\n`);
  process.stdout.write(`Evidence: ${prepared.layout.evidenceDir}\n`);
  process.stdout.write(`Evidence run id: ${prepared.evidenceRunId}\n`);
}

function recordInvocation(
  records: AgenticControlInvocationRecord[],
  step: string,
  npmScript: string,
  code: number,
  envelopeOk?: boolean,
): void {
  records.push({ step, npmScript, exitCode: code, envelopeOk });
}

function snapshotOrThrow(envelope: AgentCliEnvelope, label: string): InspectSnapshot {
  const snapshot = inspectSnapshotFromEnvelope(envelope);
  if (!snapshot) throw new Error(`Could not parse inspect snapshot for ${label}.`);
  return snapshot;
}

export async function runAgenticControlOracle(prepared: AgenticControlPreparedRun): Promise<AgenticControlCandidateReport> {
  if (isImportIdempotencyContract(prepared.loaded.contract)) {
    return runAgenticControlImportOracle(prepared);
  }
  if (isFreshProfileRecoveryContract(prepared.loaded.contract)) {
    return runAgenticControlFreshProfileOracle(prepared);
  }
  return runAgenticControlLifecycleOracle(prepared);
}

export async function runAgenticControlLifecycleOracle(
  prepared: AgenticControlPreparedRun,
): Promise<AgenticControlLifecycleCandidateReport> {
  const contract = prepared.loaded.contract;
  if (isImportIdempotencyContract(contract) || isFreshProfileRecoveryContract(contract)) {
    throw new Error('Lifecycle oracle requires a lifecycle-control or operator-intent contract.');
  }
  const env = agentEnv(prepared);
  const cwd = repoRoot();
  const invocations: AgenticControlInvocationRecord[] = [];
  const common = {
    repoRoot: cwd,
    url: prepared.url,
    profile: prepared.layout.profileDir,
    cwd,
  };

  const call = async (step: string, npmScript: string, args: string[]) => {
    const invocation = await invokeAgentCli({ ...common, env, args: [npmScript, ...args] });
    const envelope = invocation.envelope ?? extractAgentEnvelope(invocation.stdout);
    recordInvocation(invocations, step, npmScript, invocation.code, envelope?.ok);
    if (invocation.code !== 0 || envelope?.ok === false) {
      throw new Error(`${step} failed: ${envelope?.error?.message ?? invocation.stderr.slice(-400)}`);
    }
    return envelope!;
  };

  const capabilitiesEnvelope = await call('capabilities', 'capabilities', []);
  const exportPackage = capabilitiesExportPackage(capabilitiesEnvelope.result);

  const seedPath = prepared.seedPackage;
  await call('open-seed', 'open', ['--file', seedPath, '--write']);

  const inspectBeforeEnvelope = await call('inspect-before', 'inspect', ['--document']);
  const inspectBefore = snapshotOrThrow(inspectBeforeEnvelope, 'inspect-before');

  const clayOutput = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    contract.render.artifact,
  );
  await mkdir(path.dirname(clayOutput), { recursive: true });
  const renderShotId = inspectBefore.shotIds[0];
  if (!renderShotId) throw new Error('Seed project has no shots to render.');
  await call('render-clay', 'frame', [
    '--shot', renderShotId,
    '--mode', contract.render.mode,
    '--output', clayOutput,
    '--write',
  ]);

  const savedProject = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    prepared.loaded.contract.artifacts.savedProject,
  );
  await call('save', 'save', ['--output', savedProject, '--write']);

  await call('reopen', 'open', ['--file', savedProject, '--write']);

  const inspectAfterEnvelope = await call('inspect-after', 'inspect', ['--document']);
  const inspectAfter = snapshotOrThrow(inspectAfterEnvelope, 'inspect-after');

  let packageRecord: AgenticControlLifecycleCandidateReport['package'];
  if (exportPackage && contract.artifacts.packageExport) {
    const packageOutput = resolveAgenticControlRunPath(
      prepared.layout.runRoot,
      contract.artifacts.packageExport,
    );
    await mkdir(path.dirname(packageOutput), { recursive: true });
    await call('package', 'package', ['--output', packageOutput, '--write']);
    packageRecord = { status: 'completed' };
  } else {
    packageRecord = {
      status: 'skipped',
      reason: 'export.package capability is false in agent:capabilities',
    };
  }

  const report: AgenticControlLifecycleCandidateReport = {
    runner: 'oracle',
    invocations,
    capabilities: { exportPackage },
    inspectBefore,
    inspectAfter,
    package: packageRecord,
  };

  const reportPath = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    prepared.loaded.contract.artifacts.candidateReport,
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function runAgenticControlImportOracle(
  prepared: AgenticControlPreparedRun,
): Promise<AgenticControlImportCandidateReport> {
  const contract = prepared.loaded.contract;
  if (!isImportIdempotencyContract(contract)) {
    throw new Error('Import oracle requires an import-idempotency contract.');
  }
  const env = agentEnv(prepared);
  const cwd = repoRoot();
  const invocations: AgenticControlInvocationRecord[] = [];
  const common = {
    repoRoot: cwd,
    url: prepared.url,
    profile: prepared.layout.profileDir,
    cwd,
  };

  const call = async (step: string, npmScript: string, args: string[]) => {
    const invocation = await invokeAgentCli({ ...common, env, args: [npmScript, ...args] });
    const envelope = invocation.envelope ?? extractAgentEnvelope(invocation.stdout);
    recordInvocation(invocations, step, npmScript, invocation.code, envelope?.ok);
    if (invocation.code !== 0 || envelope?.ok === false) {
      throw new Error(`${step} failed: ${envelope?.error?.message ?? invocation.stderr.slice(-400)}`);
    }
    return envelope!;
  };

  const seedPath = prepared.seedPackage;
  await call('open-seed', 'open', ['--file', seedPath, '--write']);

  const inspectSeedEnvelope = await call('inspect-seed', 'inspect', ['--document']);
  const inspectSeed = snapshotOrThrow(inspectSeedEnvelope, 'inspect-seed');

  const modelPath = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    contract.importModel.runRelativePath,
  );
  await call('import-first', 'import-model', ['--file', modelPath, '--write']);

  const inspectAfterFirstEnvelope = await call('inspect-after-first', 'inspect', ['--document']);
  const inspectAfterFirst = snapshotOrThrow(inspectAfterFirstEnvelope, 'inspect-after-first');

  await call('import-second', 'import-model', ['--file', modelPath, '--write']);

  const inspectAfterSecondEnvelope = await call('inspect-after-second', 'inspect', ['--document']);
  const inspectAfterSecond = snapshotOrThrow(inspectAfterSecondEnvelope, 'inspect-after-second');

  const savedProject = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    prepared.loaded.contract.artifacts.savedProject,
  );
  await call('save', 'save', ['--output', savedProject, '--write']);

  const report: AgenticControlImportCandidateReport = {
    runner: 'oracle',
    invocations,
    inspectSeed,
    inspectAfterFirst,
    inspectAfterSecond,
  };

  const reportPath = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    prepared.loaded.contract.artifacts.candidateReport,
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function runAgenticControlFreshProfileOracle(
  prepared: AgenticControlPreparedRun,
): Promise<AgenticControlFreshProfileCandidateReport> {
  const contract = prepared.loaded.contract;
  if (!isFreshProfileRecoveryContract(contract)) {
    throw new Error('Fresh-profile oracle requires a fresh-profile-recovery contract.');
  }
  const env = agentEnv(prepared);
  const cwd = repoRoot();
  const invocations: AgenticControlInvocationRecord[] = [];
  const primaryProfile = prepared.layout.profileDir;
  const freshProfile = prepared.layout.freshProfileDir;

  const call = async (
    step: string,
    npmScript: string,
    args: string[],
    profile: string,
  ) => {
    const invocation = await invokeAgentCli({
      repoRoot: cwd,
      url: prepared.url,
      profile,
      cwd,
      env,
      args: [npmScript, ...args],
    });
    const envelope = invocation.envelope ?? extractAgentEnvelope(invocation.stdout);
    recordInvocation(invocations, step, npmScript, invocation.code, envelope?.ok);
    if (invocation.code !== 0 || envelope?.ok === false) {
      throw new Error(`${step} failed: ${envelope?.error?.message ?? invocation.stderr.slice(-400)}`);
    }
    const record = invocations[invocations.length - 1]!;
    record.profile = profile;
    return envelope!;
  };

  const seedPath = prepared.seedPackage;
  await call('open-seed', 'open', ['--file', seedPath, '--write'], primaryProfile);

  const inspectBeforeEnvelope = await call('inspect-before', 'inspect', ['--document'], primaryProfile);
  const inspectBefore = snapshotOrThrow(inspectBeforeEnvelope, 'inspect-before');

  const savedProject = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    contract.artifacts.savedProject,
  );
  await call('save', 'save', ['--output', savedProject, '--write'], primaryProfile);

  await call('reopen-fresh', 'open', ['--file', savedProject, '--write'], freshProfile);

  const inspectAfterEnvelope = await call('inspect-after', 'inspect', ['--document'], freshProfile);
  const inspectAfter = snapshotOrThrow(inspectAfterEnvelope, 'inspect-after');

  const report: AgenticControlFreshProfileCandidateReport = {
    runner: 'oracle',
    profiles: {
      primary: primaryProfile,
      fresh: freshProfile,
    },
    invocations,
    inspectBefore,
    inspectAfter,
    clayFrame: { status: 'skipped', reason: 'optional proof omitted in oracle' },
  };

  const reportPath = resolveAgenticControlRunPath(
    prepared.layout.runRoot,
    contract.artifacts.candidateReport,
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const contractPath = String(
    args.contract
    ?? path.join(repoRoot(), 'benchmarks/agentic-control-v1/contract.json'),
  );

  if (args['build-seed']) {
    const loaded = await loadAgenticControlContract(contractPath);
    const target = await buildAgenticControlSeedForContract(
      loaded.contract.id,
      path.dirname(loaded.seedPath),
    );
    process.stdout.write(`${target}\n`);
    return 0;
  }

  if (args.score) {
    const runRoot = String(args['run-root'] ?? '');
    if (!runRoot) throw new Error('--score requires --run-root <path>');
    const gitBeforePath = path.join(runRoot, 'harness', 'git.json');
    let gitBefore: GitIdentityRecord | undefined;
    try {
      gitBefore = JSON.parse(await readFile(gitBeforePath, 'utf8')) as GitIdentityRecord;
    } catch {
      gitBefore = undefined;
    }
    const gitAfter = await gitIdentity();
    const report = await scoreAgenticControlRun({
      contractPath,
      runRoot,
      gitBefore,
      gitAfter,
    });
    const reportPath = path.join(runRoot, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${reportPath}\n`);
    process.stdout.write(`technicalPass=${report.technicalPass}\n`);
    return report.technicalPass ? 0 : 1;
  }

  const loadedContract = await loadAgenticControlContract(contractPath);
  const runRoot = String(args['run-root'] ?? await nextRunRoot(loadedContract.contract.id));
  const prepared = await prepareAgenticControlRun({
    contractPath,
    runRoot,
    url: typeof args.url === 'string' ? args.url : undefined,
  });

  if (args['print-brief']) {
    printAgenticControlBrief(prepared);
    return 0;
  }

  if (args.prepare || (!args.oracle && !args.score)) {
    printAgenticControlBrief(prepared);
    if (!args.oracle) {
      process.stdout.write('\nRun prepared. Candidate should read harness/BRIEF.md and write work/candidate-report.json.\n');
      process.stdout.write(`Score with: npm run benchmark:agentic-control -- --score --run-root ${prepared.layout.runRoot}\n`);
    }
    return 0;
  }

  if (args.oracle) {
    await runAgenticControlOracle(prepared);
    const scored = await scoreAgenticControlRun({
      contractPath,
      runRoot: prepared.layout.runRoot,
      gitBefore: prepared.git,
      gitAfter: await gitIdentity(),
    });
    await writeFile(prepared.layout.reportPath, `${JSON.stringify(scored, null, 2)}\n`, 'utf8');
    process.stdout.write(`Oracle technicalPass=${scored.technicalPass}\n`);
    return scored.technicalPass ? 0 : 1;
  }

  printAgenticControlBrief(prepared);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
