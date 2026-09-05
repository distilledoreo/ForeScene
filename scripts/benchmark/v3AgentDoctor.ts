import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitIdentity, type GitIdentityRecord } from './git';
import type { BenchmarkFailure } from './types';
import type { BenchmarkRunLayout } from './layout';
import {
  doctorCheck,
  doctorFailure,
  runDoctorCore,
  verifyNonMutatingInspect,
  type DoctorCheck,
  type DoctorInspectCli,
} from './doctorCore';
import {
  collectIntentSolutionLeaks,
  loadV3AgentContract,
  v3AgentRequiredFiles,
  type LoadedV3AgentContract,
} from './v3AgentContract';

export interface V3AgentDoctorReport {
  ok: boolean;
  checkedAt: string;
  contractPath: string;
  inputRoot: string;
  url: string;
  profileDir: string;
  checks: DoctorCheck[];
  cli?: DoctorInspectCli;
}

export interface V3AgentDoctorInput {
  contractPath: string;
  inputRoot: string;
  url?: string;
  layout: BenchmarkRunLayout;
  loaded?: LoadedV3AgentContract;
  git?: GitIdentityRecord;
  fetchImpl?: typeof fetch;
  runCli?: Parameters<typeof runDoctorCore>[0]['runCli'];
}

function verifyIntentAndContract(loaded: LoadedV3AgentContract): DoctorCheck[] {
  const leaks = collectIntentSolutionLeaks(loaded.intent);
  const shot02 = loaded.contract.shots.find((shot) => shot.shotNumber === '02');
  const intent02 = loaded.intent.shots.find((shot) => shot.shotNumber === '02');
  return [
    doctorCheck(
      'contract.valid',
      loaded.contract.shots.map((shot) => shot.shotNumber).join(',') === '01,02,03'
        && shot02?.durationSeconds === 3
        && loaded.contract.knownSubjects.length > 0,
      'V3-Agent contract preserves shot identities, locations, assets, and the 3-second Shot 02 duration.',
    ),
    doctorCheck(
      'intent.valid',
      loaded.intent.shots.map((shot) => shot.shotNumber).join(',') === '01,02,03'
        && intent02?.durationSeconds === 3,
      'V3-Agent intent contains the three creative assignments and Shot 02 duration.',
    ),
    doctorCheck(
      'intent.no-solution-leak',
      leaks.length === 0,
      leaks.length === 0
        ? 'Candidate-facing intent contains no solution-like camera, blocking, or transform fields.'
        : `Candidate-facing intent leaks solution fields: ${leaks.join('; ')}`,
    ),
  ];
}

export async function runV3AgentDoctor(input: V3AgentDoctorInput): Promise<{
  report: V3AgentDoctorReport;
  failure?: BenchmarkFailure;
}> {
  const loaded = input.loaded ?? await loadV3AgentContract(input.contractPath);
  const inputRoot = path.resolve(input.inputRoot);
  const url = input.url?.trim() ?? '';
  const git = input.git ?? await gitIdentity();
  const requiredFiles = v3AgentRequiredFiles(loaded.contract, inputRoot);
  const core = await runDoctorCore({
    inputRoot,
    url: url || undefined,
    layout: input.layout,
    git,
    basePackagePath: requiredFiles.get('base-package') ?? '',
    requiredFiles,
    skipInspect: true,
    hostedMissingMessage: 'FORESCENE_URL or --url is required for Benchmark V3-Agent.',
    fetchImpl: input.fetchImpl,
    runCli: input.runCli,
  });
  const checks: DoctorCheck[] = [...core.checks, ...verifyIntentAndContract(loaded)];
  const inspect = await verifyNonMutatingInspect({
    url,
    layout: input.layout,
    setupOk: checks.every((item) => item.ok),
    runCli: input.runCli,
  });
  checks.push(inspect.check);

  const report: V3AgentDoctorReport = {
    ok: checks.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    contractPath: path.resolve(input.contractPath),
    inputRoot,
    url,
    profileDir: input.layout.profileDir,
    checks,
    ...(inspect.cli ? { cli: inspect.cli } : {}),
  };
  await writeFile(input.layout.doctorPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report.ok
    ? { report }
    : { report, failure: doctorFailure('Benchmark V3-Agent', checks) };
}
