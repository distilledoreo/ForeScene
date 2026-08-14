import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractAgentEnvelope, failureFromInvocation } from './agentCli';
import { defaultRunRoot, repoRoot, type BenchmarkRunLayout, createBenchmarkRunLayout } from './layout';
import { gitIdentity, unauthorizedRepoModifications, type GitIdentityRecord } from './git';
import { buildCandidateBrief } from './brief';
import { isStopTheRun, harnessFailure, modelFailure } from './failures';
import {
  loadV3LiteContract,
  resolveV3LiteInputPath,
  resolveV3LiteManifestAssets,
  v3LiteBenchmarkSpec,
  type LoadedV3LiteContract,
} from './v3LiteContract';
import { runV3LiteDoctor, type V3LiteDoctorReport } from './v3LiteDoctor';
import { addReportArtifactChecks, validateV3LiteTechnical, type V3LiteTechnicalValidation } from './v3LiteValidator';
import { gradeV3LiteQuality, type V3LiteQualityGrade } from './v3LiteQuality';
import type { BenchmarkCandidateBrief, BenchmarkFailure } from './types';

export interface V3LiteCandidateResult {
  code: number;
  stdout: string;
  stderr: string;
  runtimeMs: number;
  timedOut: boolean;
}

export interface V3LitePreparedRun {
  layout: BenchmarkRunLayout;
  loaded: LoadedV3LiteContract;
  git: GitIdentityRecord;
  brief: BenchmarkCandidateBrief;
}

export interface V3LiteRunResult {
  ok: boolean;
  runRoot: string;
  doctor?: V3LiteDoctorReport;
  candidate?: V3LiteCandidateResult & { invocationCount: number };
  technical?: V3LiteTechnicalValidation;
  quality?: V3LiteQualityGrade;
  failure?: BenchmarkFailure;
}

interface CandidateInvocation {
  executable: string;
  args: string[];
}

function npmScriptInvocation(script: string, args: string[]): CandidateInvocation {
  const npmExec = process.env.npm_execpath;
  return npmExec
    ? { executable: process.execPath, args: [npmExec, 'run', script, '--', ...args] }
    : { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', script, '--', ...args] };
}

export function singleProductionCandidateInvocation(): CandidateInvocation {
  // Manifest, profile, URL, output, final project, and the frozen brief are
  // supplied by the benchmark environment. The product CLI resolves them.
  return npmScriptInvocation('agent:production', [
    '--write',
    '--mode', 'delivery',
    '--max-repair-passes', '2',
    '--allow-heavy-character-imports',
  ]);
}

function runInvocation(
  invocation: CandidateInvocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<V3LiteCandidateResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(invocation.executable, invocation.args, { cwd, env, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      stderr += `\nCandidate exceeded ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}\n`, runtimeMs: Date.now() - startedAt, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, runtimeMs: Date.now() - startedAt, timedOut });
    });
  });
}

export async function runV3LiteCandidateOnce(input: {
  candidate: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<V3LiteCandidateResult> {
  const timeoutMs = input.timeoutMs ?? (Number(process.env.FORESCENE_BENCHMARK_CANDIDATE_TIMEOUT_MS) || 60 * 60_000);
  const invocation = input.candidate === 'production'
    ? singleProductionCandidateInvocation()
    : undefined;
  if (invocation) return runInvocation(invocation, input.cwd ?? repoRoot(), input.env, timeoutMs);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(input.candidate, { cwd: input.cwd ?? repoRoot(), env: input.env, shell: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      stderr += `\nCandidate exceeded ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}\n`, runtimeMs: Date.now() - startedAt, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, runtimeMs: Date.now() - startedAt, timedOut });
    });
  });
}

async function ensureFreshRunRoot(runRoot: string): Promise<void> {
  try {
    const info = await stat(runRoot);
    if (!info.isDirectory()) throw new Error(`Benchmark run root is not a directory: ${runRoot}`);
    const entries = await readdir(runRoot);
    if (entries.length > 0) throw new Error(`Benchmark run root must be fresh and empty: ${runRoot}`);
  } catch (error) {
    if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
    throw error;
  }
}

export async function prepareV3LiteRun(input: {
  contractPath: string;
  inputRoot: string;
  runRoot: string;
  url?: string;
}): Promise<V3LitePreparedRun> {
  const runRoot = path.resolve(input.runRoot);
  await ensureFreshRunRoot(runRoot);
  const loaded = await loadV3LiteContract(input.contractPath);
  const layout = await createBenchmarkRunLayout(runRoot);
  const git = await gitIdentity();
  await writeFile(layout.gitPath, `${JSON.stringify(git, null, 2)}\n`, 'utf8');
  const basePackage = resolveV3LiteInputPath(input.inputRoot, loaded.contract.basePackage, 'basePackage');
  const projectPackage = path.join(layout.projectDir, path.basename(basePackage));
  await copyFile(basePackage, projectPackage);
  const spec = v3LiteBenchmarkSpec(loaded.contract);
  await writeFile(layout.specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  const brief = buildCandidateBrief({
    spec,
    layout,
    url: input.url,
    projectPackage,
    productionManifest: path.join(layout.harnessDir, 'production-manifest.json'),
  });
  const enrichedBrief: BenchmarkCandidateBrief = {
    ...brief,
    benchmarkContract: path.resolve(input.contractPath),
    cliDocumentation: path.join(repoRoot(), 'docs', 'agent-capability-matrix.md'),
    finalProjectPath: path.join(layout.runRoot, 'final-project.fsp'),
    qualityEvidence: path.join(layout.artifactDir, loaded.contract.quality.evidenceFile),
  };
  await writeFile(layout.briefPath, `${JSON.stringify(enrichedBrief, null, 2)}\n`, 'utf8');
  return { layout, loaded, git, brief: enrichedBrief };
}

function candidateEnvironment(prepared: V3LitePreparedRun, url: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORESCENE_BENCHMARK: '1',
    FORESCENE_BENCHMARK_BRIEF: prepared.layout.briefPath,
    FORESCENE_BENCHMARK_CONTRACT: prepared.brief.benchmarkContract,
    FORESCENE_BENCHMARK_MANIFEST: prepared.brief.productionManifest,
    FORESCENE_BENCHMARK_PROJECT_PACKAGE: prepared.brief.projectPackage,
    FORESCENE_BENCHMARK_FINAL_PROJECT: prepared.brief.finalProjectPath,
    FORESCENE_BENCHMARK_QUALITY_REPORT: prepared.brief.qualityEvidence,
    FORESCENE_CLI_DOCUMENTATION: prepared.brief.cliDocumentation,
    FORESCENE_REPO_ROOT: repoRoot(),
    FORESCENE_URL: url,
    FORESCENE_PROFILE: prepared.layout.profileDir,
    FORESCENE_OUTPUT: prepared.layout.artifactDir,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeV3LiteReports(input: {
  prepared: V3LitePreparedRun;
  doctor?: V3LiteDoctorReport;
  candidate?: V3LiteCandidateResult & { invocationCount: number };
  technical: V3LiteTechnicalValidation;
  quality: V3LiteQualityGrade;
  failure?: BenchmarkFailure;
}): Promise<V3LiteRunResult> {
  const { prepared } = input;
  await writeJson(prepared.layout.v3ValidationPath, input.technical);
  await writeJson(prepared.layout.qualityPath, input.quality);
  const reportBase = {
    schemaVersion: 1,
    benchmark: 'ForeScene Benchmark V3-Lite',
    contract: prepared.brief.benchmarkContract,
    runRoot: prepared.layout.runRoot,
    doctor: input.doctor,
    candidate: input.candidate
      ? {
          invoked: true,
          invocationCount: input.candidate.invocationCount,
          exitCode: input.candidate.code,
          runtimeMs: input.candidate.runtimeMs,
          timedOut: input.candidate.timedOut,
          stdoutLog: path.join(prepared.layout.logsDir, 'candidate.stdout.log'),
          stderrLog: path.join(prepared.layout.logsDir, 'candidate.stderr.log'),
          envelope: extractAgentEnvelope(input.candidate.stdout),
        }
      : { invoked: false, invocationCount: 0 },
    technical: input.technical,
    artifacts: {
      required: prepared.loaded.contract.requiredArtifacts,
      checks: input.technical.checks,
    },
    quality: input.quality,
    failure: input.failure,
    stopTheRun: input.failure ? isStopTheRun(input.failure) : false,
  };
  await writeJson(prepared.layout.v3ReportPath, { ...reportBase, ok: !input.failure && input.technical.ok });
  // Keep the pre-existing report names as compatibility aliases; the frozen
  // V3-Lite contract uses run-report.json and validation-report.json.
  await writeJson(prepared.layout.reportPath, { ...reportBase, ok: !input.failure && input.technical.ok });
  await writeJson(prepared.layout.validationPath, input.technical);
  return {
    ok: !input.failure && input.technical.ok,
    runRoot: prepared.layout.runRoot,
    ...(input.doctor ? { doctor: input.doctor } : {}),
    ...(input.candidate ? { candidate: input.candidate } : {}),
    technical: input.technical,
    quality: input.quality,
    ...(input.failure ? { failure: input.failure } : {}),
  };
}

export async function runV3Lite(input: {
  contractPath: string;
  inputRoot: string;
  runRoot: string;
  url?: string;
  candidate?: string;
  prepareOnly?: boolean;
  doctorRunner?: typeof runV3LiteDoctor;
  candidateRunner?: typeof runV3LiteCandidateOnce;
}): Promise<V3LiteRunResult> {
  const prepared = await prepareV3LiteRun(input);
  if (input.prepareOnly) {
    const technical = { ok: false, checks: [{ id: 'candidate.skipped', ok: false, message: 'Prepare-only run; candidate was not invoked.' }] };
    const quality = await gradeV3LiteQuality(prepared.loaded.contract, prepared.layout, technical);
    return writeV3LiteReports({ prepared, technical, quality, failure: undefined });
  }
  if (!input.candidate) {
    const failure = harnessFailure('V3-Lite requires exactly one --candidate command unless --prepare-only is used.');
    const technical = { ok: false, checks: [{ id: 'candidate.required', ok: false, message: failure.message }] };
    const quality = await gradeV3LiteQuality(prepared.loaded.contract, prepared.layout, technical);
    return writeV3LiteReports({ prepared, technical, quality, failure });
  }
  const url = input.url?.trim() || process.env.FORESCENE_URL?.trim() || '';
  const doctorResult = await (input.doctorRunner ?? runV3LiteDoctor)({
    contractPath: input.contractPath,
    inputRoot: input.inputRoot,
    url,
    layout: prepared.layout,
    loaded: prepared.loaded,
    git: prepared.git,
  });
  if (doctorResult.failure) {
    await writeFile(path.join(prepared.layout.logsDir, 'candidate.stdout.log'), 'Candidate not invoked: doctor failed.\n', 'utf8');
    await writeFile(path.join(prepared.layout.logsDir, 'candidate.stderr.log'), '', 'utf8');
    const technical = { ok: false, checks: [{ id: 'doctor.blocked-candidate', ok: false, message: doctorResult.failure.message }] };
    const quality = await gradeV3LiteQuality(prepared.loaded.contract, prepared.layout, technical);
    return writeV3LiteReports({ prepared, doctor: doctorResult.report, technical, quality, failure: doctorResult.failure });
  }

  const env = candidateEnvironment(prepared, url);
  const candidateResult = await (input.candidateRunner ?? runV3LiteCandidateOnce)({
    candidate: input.candidate,
    env,
    cwd: repoRoot(),
  });
  const candidate = { ...candidateResult, invocationCount: 1 as const };
  await writeFile(path.join(prepared.layout.logsDir, 'candidate.stdout.log'), candidate.stdout, 'utf8');
  await writeFile(path.join(prepared.layout.logsDir, 'candidate.stderr.log'), candidate.stderr, 'utf8');
  const technical = await validateV3LiteTechnical(prepared.loaded.contract, prepared.layout, candidate.code);
  const after = await gitIdentity();
  const drift = unauthorizedRepoModifications(prepared.git, after);
  let failure: BenchmarkFailure | undefined = drift;
  if (!failure && candidate.code !== 0) {
    failure = failureFromInvocation({
      code: candidate.code,
      stdout: candidate.stdout,
      stderr: candidate.stderr,
      envelope: extractAgentEnvelope(candidate.stdout),
    }, 'candidate');
  }
  if (!failure && !technical.ok) failure = modelFailure('V3-Lite technical artifact validation failed.', 'technical-validation');
  const quality = await gradeV3LiteQuality(prepared.loaded.contract, prepared.layout, technical);
  const withReports = addReportArtifactChecks(technical, prepared.layout);
  return writeV3LiteReports({ prepared, doctor: doctorResult.report, candidate, technical: withReports, quality, failure });
}

function parseArgs(argv: string[]) {
  const args = {
    contractPath: process.env.FORESCENE_BENCHMARK_CONTRACT ?? path.join(repoRoot(), 'benchmarks', 'panorama-triad-v3-lite', 'contract.json'),
    inputRoot: process.env.FORESCENE_BENCHMARK_INPUT_ROOT ?? '',
    runRoot: undefined as string | undefined,
    url: process.env.FORESCENE_URL,
    candidate: undefined as string | undefined,
    prepareOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--contract') args.contractPath = argv[++index]!;
    else if (token === '--input-root') args.inputRoot = argv[++index]!;
    else if (token === '--run-root') args.runRoot = argv[++index];
    else if (token === '--url') args.url = argv[++index];
    else if (token === '--candidate') args.candidate = argv[++index];
    else if (token === '--prepare-only') args.prepareOnly = true;
  }
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!args.inputRoot) throw new Error('Benchmark V3-Lite requires --input-root or FORESCENE_BENCHMARK_INPUT_ROOT.');
  const result = await runV3Lite({
    contractPath: path.resolve(args.contractPath),
    inputRoot: path.resolve(args.inputRoot),
    runRoot: args.runRoot ? path.resolve(args.runRoot) : defaultRunRoot('music-video-v2-panorama-triad-v3-lite'),
    url: args.url,
    candidate: args.candidate,
    prepareOnly: args.prepareOnly,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

export function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && (path.resolve(entry) === fileURLToPath(import.meta.url) || entry.replaceAll('\\', '/').endsWith('scripts/benchmark/v3LiteRun.ts')));
}

if (isDirectRun()) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
