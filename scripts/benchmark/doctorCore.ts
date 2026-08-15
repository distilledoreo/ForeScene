import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDefaultAgentProfilePath } from '../agent/agentProfile';
import { invokeAgentCli, type AgentCliInvocation } from './agentCli';
import { environmentFailure } from './failures';
import type { GitIdentityRecord } from './git';
import type { BenchmarkFailure } from './types';
import type { BenchmarkRunLayout } from './layout';
import { repoRoot } from './layout';

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface DoctorInspectCli {
  command: 'inspect';
  code: number;
  durationMs?: number;
  operation?: string;
}

export interface DoctorCoreInput {
  inputRoot: string;
  url?: string;
  layout: BenchmarkRunLayout;
  git: GitIdentityRecord;
  basePackagePath: string;
  requiredFiles: Map<string, string>;
  skipInspect?: boolean;
  hostedMissingMessage?: string;
  fetchImpl?: typeof fetch;
  runCli?: (input: {
    repoRoot: string;
    args: string[];
    url: string;
    profile: string;
    timeoutMs?: number;
  }) => Promise<AgentCliInvocation>;
}

export function doctorCheck(id: string, ok: boolean, message: string): DoctorCheck {
  return { id, ok, message };
}

export async function nonemptyFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function verifyHostedApp(url: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    const recognizable = body.includes('ForeScene') || body.includes('id="root"') || body.includes("id='root'");
    return doctorCheck('hosted-app.responsive', response.ok && recognizable,
      response.ok && recognizable
        ? `Hosted ForeScene responded with HTTP ${response.status}.`
        : `Hosted URL responded with HTTP ${response.status}, but not recognizable ForeScene HTML.`);
  } catch (error) {
    return doctorCheck('hosted-app.responsive', false, `Hosted ForeScene was not responsive: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function verifyIsolatedProfile(layout: BenchmarkRunLayout): Promise<DoctorCheck> {
  const profile = path.resolve(layout.profileDir);
  const runRoot = path.resolve(layout.runRoot);
  const relative = path.relative(runRoot, profile);
  const insideRun = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!insideRun || isDefaultAgentProfilePath(profile, repoRoot())) {
    return doctorCheck('profile.isolated', false, `Profile is not an isolated run profile: ${profile}`);
  }
  const probe = path.join(profile, '.doctor-write-probe');
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(probe, 'doctor');
    await rm(probe, { force: true });
    return doctorCheck('profile.usable', true, `Isolated profile is writable: ${profile}`);
  } catch (error) {
    return doctorCheck('profile.usable', false, `Isolated profile is not usable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function verifyRepository(git: GitIdentityRecord): Promise<DoctorCheck> {
  const expected = git.expectedCommit ? ` expected ${git.expectedCommit}` : '';
  const ok = !git.dirty && Boolean(git.expectedCommitIsAncestor);
  return doctorCheck('repository.clean', ok,
    ok
      ? `ForeScene repository is clean at ${git.commit}${expected}.`
      : `Refusing benchmark from dirty or unexpected ForeScene workspace (commit ${git.commit}).${git.dirty ? `\n${git.porcelain}` : ''}`);
}

export async function verifyInputRoot(inputRoot: string, basePackagePath: string): Promise<DoctorCheck> {
  return doctorCheck(
    'input-root.present',
    await nonemptyFile(basePackagePath),
    `Frozen input root is available: ${inputRoot}`,
  );
}

export async function verifyRequiredFiles(files: Map<string, string>): Promise<DoctorCheck[]> {
  return Promise.all([...files.entries()].map(async ([id, filePath]) => {
    const ok = await nonemptyFile(filePath);
    return doctorCheck(`asset.${id}`, ok, ok ? `${id} is present (${filePath}).` : `Required ${id} is missing or empty: ${filePath}`);
  }));
}

export async function verifyNonMutatingInspect(input: {
  url: string;
  layout: BenchmarkRunLayout;
  setupOk: boolean;
  runCli?: DoctorCoreInput['runCli'];
}): Promise<{ check: DoctorCheck; cli?: DoctorInspectCli }> {
  if (!input.setupOk || !input.url) {
    return {
      check: doctorCheck('cli.non-mutating-inspect', false, 'Skipped because deterministic doctor setup checks already failed.'),
    };
  }
  const invocation = await (input.runCli ?? ((cliInput) => invokeAgentCli(cliInput)))({
    repoRoot: repoRoot(),
    args: ['inspect'],
    url: input.url,
    profile: input.layout.profileDir,
    timeoutMs: 180_000,
  });
  const ok = invocation.code === 0 && Boolean(invocation.envelope);
  return {
    cli: {
      command: 'inspect',
      code: invocation.code,
      durationMs: invocation.durationMs,
      operation: invocation.envelope?.operation,
    },
    check: doctorCheck(
      'cli.non-mutating-inspect',
      ok,
      ok ? 'Non-mutating Agent CLI inspect completed.' : `Non-mutating Agent CLI inspect failed with exit code ${invocation.code}.`,
    ),
  };
}

export async function runDoctorCore(input: DoctorCoreInput): Promise<{
  checks: DoctorCheck[];
  cli?: DoctorInspectCli;
}> {
  const url = input.url?.trim() ?? '';
  const checks: DoctorCheck[] = [
    await verifyRepository(input.git),
    await verifyInputRoot(input.inputRoot, input.basePackagePath),
    url
      ? await verifyHostedApp(url, input.fetchImpl ?? fetch)
      : doctorCheck('hosted-app.responsive', false, input.hostedMissingMessage ?? 'FORESCENE_URL or --url is required for this benchmark.'),
    ...await verifyRequiredFiles(input.requiredFiles),
    await verifyIsolatedProfile(input.layout),
  ];
  if (input.skipInspect) return { checks };
  const setupOk = checks.every((item) => item.ok);
  const inspect = await verifyNonMutatingInspect({
    url,
    layout: input.layout,
    setupOk,
    runCli: input.runCli,
  });
  checks.push(inspect.check);
  return { checks, ...(inspect.cli ? { cli: inspect.cli } : {}) };
}

export function doctorFailure(label: string, checks: DoctorCheck[]): BenchmarkFailure {
  return environmentFailure(
    `${label} doctor failed; candidate launch is blocked. ${checks.filter((item) => !item.ok).map((item) => item.message).join(' ')}`,
  );
}
