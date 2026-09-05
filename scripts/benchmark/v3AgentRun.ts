import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractAgentEnvelope, failureFromInvocation } from './agentCli';
import { defaultRunRoot, repoRoot, type BenchmarkRunLayout, createBenchmarkRunLayout } from './layout';
import { gitIdentity, unauthorizedRepoModifications, type GitIdentityRecord } from './git';
import { isStopTheRun, harnessFailure, infrastructureFailure, modelFailure } from './failures';
import { addReportArtifactChecks, validateV3LiteTechnical, type V3LiteTechnicalValidation } from './v3LiteValidator';
import { gradeV3LiteQuality, type V3LiteQualityGrade } from './v3LiteQuality';
import type { BenchmarkFailure } from './types';
import { parsePrevisProductionManifest } from '../../src/engine/previs/manifestValidation';
import { preflightProductionAssets } from '../../src/engine/previs/assetPreflight';
import {
  loadV3AgentContract,
  resolveV3AgentInputPath,
  resolveV3AgentManifestAssets,
  v3AgentAsLiteContract,
  type LoadedV3AgentContract,
} from './v3AgentContract';
import { runV3AgentDoctor, type V3AgentDoctorReport } from './v3AgentDoctor';
import {
  V3_AGENT_PLAN_SCHEMA,
  buildV3AgentProductionManifest,
  validateV3AgentCandidatePlan,
} from './v3AgentPlan';

export interface V3AgentProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  runtimeMs: number;
  timedOut: boolean;
}

export interface V3AgentPreparedRun {
  layout: BenchmarkRunLayout;
  loaded: LoadedV3AgentContract;
  git: GitIdentityRecord;
  candidateDir: string;
  artifactDir: string;
  planPath: string;
  taskPath: string;
  intentPath: string;
  schemaPath: string;
  productionManifestPath: string;
  projectPackage: string;
  finalProjectPath: string;
}

export interface V3AgentRunResult {
  ok: boolean;
  runRoot: string;
  doctor?: V3AgentDoctorReport;
  candidate?: V3AgentProcessResult & { invocationCount: number };
  plan?: string;
  productionManifest?: string;
  technical?: V3LiteTechnicalValidation;
  quality?: V3LiteQualityGrade;
  failure?: BenchmarkFailure;
}

interface Invocation {
  executable: string;
  args: string[];
}

const OS_ENV = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|NUMBER_OF_PROCESSORS|PROCESSOR_|OS|TMPDIR|LANG|LC_|TERM|NODE_|npm_|NVM_)/i;
const MODEL_ENV = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
]);

function npmScriptInvocation(script: string, args: string[]): Invocation {
  const npmExec = process.env.npm_execpath;
  return npmExec
    ? { executable: process.execPath, args: [npmExec, 'run', script, '--', ...args] }
    : { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', script, '--', ...args] };
}

export function v3AgentProductionInvocation(): Invocation {
  return npmScriptInvocation('agent:production', [
    '--write',
    '--mode', 'delivery',
    '--no-auto-repair',
    '--allow-heavy-character-imports',
  ]);
}

function fixturePath(name: 'v3AgentFakeA.mjs' | 'v3AgentFakeB.mjs'): string {
  return path.join(repoRoot(), 'scripts', 'benchmark', 'fixtures', name);
}

export function resolveV3AgentModelInvocation(candidate: string): Invocation | { shell: string } {
  if (candidate === 'fake-a') return { executable: process.execPath, args: [fixturePath('v3AgentFakeA.mjs')] };
  if (candidate === 'fake-b') return { executable: process.execPath, args: [fixturePath('v3AgentFakeB.mjs')] };
  return { shell: candidate };
}

function runInvocation(invocation: Invocation, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<V3AgentProcessResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(invocation.executable, invocation.args, { cwd, env, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      stderr += `\nProcess exceeded ${timeoutMs}ms`;
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

export async function runV3AgentModelOnce(input: {
  candidate: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
}): Promise<V3AgentProcessResult> {
  const timeoutMs = input.timeoutMs ?? (Number(process.env.FORESCENE_BENCHMARK_CANDIDATE_TIMEOUT_MS) || 60 * 60_000);
  const resolved = resolveV3AgentModelInvocation(input.candidate);
  if ('executable' in resolved) return runInvocation(resolved, input.cwd, input.env, timeoutMs);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(resolved.shell, { cwd: input.cwd, env: input.env, shell: true });
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

export async function runV3AgentProductionOnce(input: {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<V3AgentProcessResult> {
  const timeoutMs = input.timeoutMs ?? (Number(process.env.FORESCENE_BENCHMARK_CANDIDATE_TIMEOUT_MS) || 60 * 60_000);
  return runInvocation(v3AgentProductionInvocation(), input.cwd ?? repoRoot(), input.env, timeoutMs);
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isolatedModelEnvironment(prepared: V3AgentPreparedRun): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('FORESCENE_')) continue;
    if (OS_ENV.test(key) || MODEL_ENV.has(key)) env[key] = value;
  }
  env.FORESCENE_AGENT_TASK = prepared.taskPath;
  env.FORESCENE_AGENT_INTENT = prepared.intentPath;
  env.FORESCENE_AGENT_PLAN = prepared.planPath;
  return env;
}

function productionEnvironment(prepared: V3AgentPreparedRun, url: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORESCENE_BENCHMARK: '1',
    FORESCENE_URL: url,
    FORESCENE_PROFILE: prepared.layout.profileDir,
    FORESCENE_OUTPUT: prepared.artifactDir,
    FORESCENE_BENCHMARK_MANIFEST: prepared.productionManifestPath,
    FORESCENE_BENCHMARK_PROJECT_PACKAGE: prepared.projectPackage,
    FORESCENE_BENCHMARK_FINAL_PROJECT: prepared.finalProjectPath,
    FORESCENE_BENCHMARK_QUALITY_REPORT: path.join(prepared.artifactDir, prepared.loaded.contract.quality.evidenceFile),
  };
}

export async function prepareV3AgentRun(input: {
  contractPath: string;
  inputRoot: string;
  runRoot: string;
}): Promise<V3AgentPreparedRun> {
  const runRoot = path.resolve(input.runRoot);
  await ensureFreshRunRoot(runRoot);
  const loaded = await loadV3AgentContract(input.contractPath);
  const layout = await createBenchmarkRunLayout(runRoot);
  const candidateDir = path.join(runRoot, 'candidate');
  const artifactDir = path.join(runRoot, 'artifacts');
  await mkdir(candidateDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  const git = await gitIdentity();
  await writeFile(layout.gitPath, `${JSON.stringify(git, null, 2)}\n`, 'utf8');
  const basePackage = resolveV3AgentInputPath(input.inputRoot, loaded.contract.basePackage, 'basePackage');
  const projectPackage = path.join(layout.projectDir, path.basename(basePackage));
  await copyFile(basePackage, projectPackage);
  const taskPath = path.join(candidateDir, 'task.md');
  const intentPath = path.join(candidateDir, 'intent.json');
  const schemaPath = path.join(candidateDir, 'plan-schema.json');
  const planPath = path.join(candidateDir, 'candidate-plan.json');
  await copyFile(loaded.taskPath, taskPath);
  await copyFile(loaded.intentPath, intentPath);
  await writeJson(schemaPath, V3_AGENT_PLAN_SCHEMA);
  return {
    layout,
    loaded,
    git,
    candidateDir,
    artifactDir,
    planPath,
    taskPath,
    intentPath,
    schemaPath,
    productionManifestPath: path.join(layout.harnessDir, 'candidate-production-manifest.json'),
    projectPackage,
    finalProjectPath: path.join(runRoot, 'final-project.fsp'),
  };
}

function agentLayout(prepared: V3AgentPreparedRun): BenchmarkRunLayout {
  return { ...prepared.layout, artifactDir: prepared.artifactDir };
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  try {
    const info = await stat(source);
    if (!info.isFile() || info.size === 0) return;
    if (path.resolve(source) === path.resolve(target)) return;
    await copyFile(source, target);
  } catch (error) {
    if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
    throw error;
  }
}

export async function materializeV3AgentArtifacts(prepared: V3AgentPreparedRun): Promise<void> {
  for (const shot of prepared.loaded.contract.shots) {
    for (const [index, artifact] of shot.stillArtifacts.entries()) {
      const source = shot.intent === 'motion-required'
        ? path.join(prepared.artifactDir, 'shots', `${shot.shotNumber}-sample-${index}.png`)
        : path.join(prepared.artifactDir, 'shots', `${shot.shotNumber}.png`);
      await copyIfPresent(source, path.join(prepared.artifactDir, artifact));
    }
    for (const artifact of shot.motionArtifacts ?? []) {
      await copyIfPresent(
        path.join(prepared.artifactDir, 'shots', `${shot.shotNumber}.mp4`),
        path.join(prepared.artifactDir, artifact),
      );
    }
  }
}

async function persistAuthorshipHashes(prepared: V3AgentPreparedRun, stills: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const writeHash = async (label: string, filePath: string) => {
    try {
      const bytes = await readFile(filePath);
      const digest = sha256Bytes(bytes);
      hashes[label] = digest;
      return digest;
    } catch {
      return undefined;
    }
  };
  const planHash = await writeHash('candidate-plan', prepared.planPath);
  const manifestHash = await writeHash('candidate-production-manifest', prepared.productionManifestPath);
  if (planHash) await writeFile(path.join(prepared.layout.harnessDir, 'candidate-plan.sha256'), `${planHash}\n`, 'utf8');
  if (manifestHash) await writeFile(path.join(prepared.layout.harnessDir, 'candidate-manifest.sha256'), `${manifestHash}\n`, 'utf8');
  for (const still of stills) {
    await writeHash(still, path.join(prepared.artifactDir, still));
  }
  await writeJson(path.join(prepared.artifactDir, 'frame-hashes.json'), hashes);
  return hashes;
}

async function writeReports(input: {
  prepared: V3AgentPreparedRun;
  doctor?: V3AgentDoctorReport;
  candidate?: V3AgentProcessResult & { invocationCount: number };
  plan?: string;
  productionManifest?: string;
  technical: V3LiteTechnicalValidation;
  quality: V3LiteQualityGrade;
  failure?: BenchmarkFailure;
  hashes?: Record<string, string>;
}): Promise<V3AgentRunResult> {
  const { prepared } = input;
  const layout = agentLayout(prepared);
  await writeJson(layout.v3ValidationPath, input.technical);
  await writeJson(layout.qualityPath, input.quality);
  const report = {
    schemaVersion: 1,
    benchmark: 'ForeScene Benchmark V3-Agent',
    candidateInvocationCount: input.candidate?.invocationCount ?? 0,
    autoRepair: false,
    contract: prepared.loaded.contractPath,
    runRoot: prepared.layout.runRoot,
    plan: input.plan ?? prepared.planPath,
    productionManifest: input.productionManifest ?? prepared.productionManifestPath,
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
    quality: input.quality,
    hashes: input.hashes ?? {},
    failure: input.failure,
    stopTheRun: input.failure ? isStopTheRun(input.failure) : false,
    ok: !input.failure && input.technical.ok,
  };
  await writeJson(layout.v3ReportPath, report);
  await writeJson(layout.reportPath, report);
  await writeJson(layout.validationPath, input.technical);
  return {
    ok: report.ok,
    runRoot: prepared.layout.runRoot,
    ...(input.doctor ? { doctor: input.doctor } : {}),
    ...(input.candidate ? { candidate: input.candidate } : {}),
    plan: report.plan,
    productionManifest: report.productionManifest,
    technical: input.technical,
    quality: input.quality,
    ...(input.failure ? { failure: input.failure } : {}),
  };
}

export async function runV3Agent(input: {
  contractPath: string;
  inputRoot: string;
  runRoot: string;
  url?: string;
  candidate?: string;
  prepareOnly?: boolean;
  doctorRunner?: typeof runV3AgentDoctor;
  modelRunner?: typeof runV3AgentModelOnce;
  productionRunner?: typeof runV3AgentProductionOnce;
}): Promise<V3AgentRunResult> {
  const prepared = await prepareV3AgentRun(input);
  const lite = v3AgentAsLiteContract(prepared.loaded.contract);
  const layout = agentLayout(prepared);
  if (input.prepareOnly) {
    const technical = { ok: false, checks: [{ id: 'candidate.skipped', ok: false, message: 'Prepare-only run; model was not invoked.' }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, technical, quality });
  }
  if (!input.candidate) {
    const failure = harnessFailure('V3-Agent requires exactly one --candidate model command unless --prepare-only is used.');
    const technical = { ok: false, checks: [{ id: 'candidate.required', ok: false, message: failure.message }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, technical, quality, failure });
  }
  const url = input.url?.trim() || process.env.FORESCENE_URL?.trim() || '';
  const doctorResult = await (input.doctorRunner ?? runV3AgentDoctor)({
    contractPath: input.contractPath,
    inputRoot: input.inputRoot,
    url,
    layout: prepared.layout,
    loaded: prepared.loaded,
    git: prepared.git,
  });
  if (doctorResult.failure) {
    await writeFile(path.join(prepared.layout.logsDir, 'candidate.stdout.log'), 'Model not invoked: doctor failed.\n', 'utf8');
    await writeFile(path.join(prepared.layout.logsDir, 'candidate.stderr.log'), '', 'utf8');
    const technical = { ok: false, checks: [{ id: 'doctor.blocked-candidate', ok: false, message: doctorResult.failure.message }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, doctor: doctorResult.report, technical, quality, failure: doctorResult.failure });
  }

  const modelEnv = isolatedModelEnvironment(prepared);
  const modelResult = await (input.modelRunner ?? runV3AgentModelOnce)({
    candidate: input.candidate,
    env: modelEnv,
    cwd: prepared.candidateDir,
  });
  const candidate = { ...modelResult, invocationCount: 1 as const };
  await writeFile(path.join(prepared.layout.logsDir, 'candidate.stdout.log'), candidate.stdout, 'utf8');
  await writeFile(path.join(prepared.layout.logsDir, 'candidate.stderr.log'), candidate.stderr, 'utf8');
  if (candidate.timedOut || candidate.code !== 0) {
    const failure = candidate.timedOut
      ? modelFailure('Candidate exceeded its time limit.', 'candidate')
      : failureFromInvocation({
          code: candidate.code,
          stdout: candidate.stdout,
          stderr: candidate.stderr,
          envelope: extractAgentEnvelope(candidate.stdout),
        }, 'candidate');
    const technical = { ok: false, checks: [{ id: 'model.exit', ok: false, message: failure.message }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, doctor: doctorResult.report, candidate, technical, quality, failure });
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(await readFile(prepared.planPath, 'utf8')) as unknown;
  } catch (error) {
    const failure = modelFailure(`candidate-plan.json is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    const technical = { ok: false, checks: [{ id: 'plan.missing', ok: false, message: failure.message }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, doctor: doctorResult.report, candidate, technical, quality, failure });
  }
  const validated = validateV3AgentCandidatePlan(planRaw, prepared.loaded.contract);
  if (!validated.ok || !validated.plan) {
    const failure = modelFailure(`candidate-plan.json failed validation: ${validated.errors.join(' ')}`);
    const technical = { ok: false, checks: [{ id: 'plan.invalid', ok: false, message: failure.message }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, doctor: doctorResult.report, candidate, technical, quality, failure });
  }

  const manifest = buildV3AgentProductionManifest(prepared.loaded.contract, prepared.loaded.intent, validated.plan);
  const parsed = parsePrevisProductionManifest(manifest);
  if (!parsed.manifest || parsed.errors.length > 0) {
    const failure = harnessFailure(`Harness-built production manifest failed the product parser: ${parsed.errors.map((error) => error.message).join('; ')}`);
    const technical = { ok: false, checks: [{ id: 'manifest.schema', ok: false, message: failure.message }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, doctor: doctorResult.report, candidate, technical, quality, failure });
  }
  const resolved = resolveV3AgentManifestAssets(parsed.manifest, path.resolve(input.inputRoot));
  await writeJson(prepared.productionManifestPath, resolved);
  const preflight = await preflightProductionAssets(resolved, prepared.productionManifestPath);
  if (!preflight.ok) {
    const failure = modelFailure(`Candidate production manifest failed asset preflight: ${preflight.errors.map((error) => error.message).join('; ')}`);
    const technical = { ok: false, checks: [{ id: 'manifest.preflight', ok: false, message: failure.message }] };
    const quality = await gradeV3LiteQuality(lite, layout, technical);
    return writeReports({ prepared, doctor: doctorResult.report, candidate, technical, quality, failure });
  }

  const production = await (input.productionRunner ?? runV3AgentProductionOnce)({
    env: productionEnvironment(prepared, url),
    cwd: repoRoot(),
  });
  await writeFile(path.join(prepared.layout.logsDir, 'production.stdout.log'), production.stdout, 'utf8');
  await writeFile(path.join(prepared.layout.logsDir, 'production.stderr.log'), production.stderr, 'utf8');
  await materializeV3AgentArtifacts(prepared);
  const technical = await validateV3LiteTechnical(lite, layout, production.code);
  const after = await gitIdentity();
  const drift = unauthorizedRepoModifications(prepared.git, after);
  let failure: BenchmarkFailure | undefined = drift;
  if (!failure && (production.timedOut || production.code !== 0)) {
    failure = production.timedOut
      ? infrastructureFailure('production', 'Production exceeded its time limit.')
      : failureFromInvocation({
          code: production.code,
          stdout: production.stdout,
          stderr: production.stderr,
          envelope: extractAgentEnvelope(production.stdout),
        }, 'production');
  }
  if (!failure && !technical.ok) failure = modelFailure('V3-Agent technical artifact validation failed.', 'technical-validation');
  const quality = await gradeV3LiteQuality(lite, layout, technical);
  const withReports = addReportArtifactChecks(technical, layout);
  const hashes = await persistAuthorshipHashes(prepared, lite.requiredStills);
  return writeReports({
    prepared,
    doctor: doctorResult.report,
    candidate,
    plan: prepared.planPath,
    productionManifest: prepared.productionManifestPath,
    technical: withReports,
    quality,
    failure,
    hashes,
  });
}

function parseArgs(argv: string[]) {
  const args = {
    contractPath: process.env.FORESCENE_BENCHMARK_CONTRACT ?? path.join(repoRoot(), 'benchmarks', 'panorama-triad-v3-agent', 'contract.json'),
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
  if (!args.inputRoot) throw new Error('Benchmark V3-Agent requires --input-root or FORESCENE_BENCHMARK_INPUT_ROOT.');
  const result = await runV3Agent({
    contractPath: path.resolve(args.contractPath),
    inputRoot: path.resolve(args.inputRoot),
    runRoot: args.runRoot ? path.resolve(args.runRoot) : defaultRunRoot('music-video-v2-panorama-triad-v3-agent'),
    url: args.url,
    candidate: args.candidate,
    prepareOnly: args.prepareOnly,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

export function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && (path.resolve(entry) === fileURLToPath(import.meta.url) || entry.replaceAll('\\', '/').endsWith('scripts/benchmark/v3AgentRun.ts')));
}

if (isDirectRun()) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
