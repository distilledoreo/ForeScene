import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveForeSceneRepoRoot } from '../agent/repoRoot';

export function repoRoot(): string {
  return resolveForeSceneRepoRoot();
}

export interface BenchmarkRunLayout {
  runRoot: string;
  harnessDir: string;
  profileDir: string;
  freshProfileDir: string;
  recoveryProfileDir: string;
  projectDir: string;
  workDir: string;
  artifactDir: string;
  lifecycleDir: string;
  logsDir: string;
  evidenceDir: string;
  evidenceManifestPath: string;
  specPath: string;
  briefPath: string;
  doctorPath: string;
  qualityPath: string;
  gitPath: string;
  hashesPath: string;
  timingPath: string;
  validationPath: string;
  v3ValidationPath: string;
  visualPath: string;
  reportPath: string;
  v3ReportPath: string;
}

export async function createBenchmarkRunLayout(runRoot: string): Promise<BenchmarkRunLayout> {
  const resolvedRoot = path.resolve(runRoot);
  const layout: BenchmarkRunLayout = {
    runRoot: resolvedRoot,
    harnessDir: path.join(resolvedRoot, 'harness'),
    profileDir: path.join(resolvedRoot, 'profile'),
    freshProfileDir: path.join(resolvedRoot, 'profile-fresh'),
    recoveryProfileDir: path.join(resolvedRoot, 'profile-recovery'),
    projectDir: path.join(resolvedRoot, 'project'),
    workDir: path.join(resolvedRoot, 'work'),
    artifactDir: path.join(resolvedRoot, 'work', 'artifacts'),
    lifecycleDir: path.join(resolvedRoot, 'lifecycle'),
    logsDir: path.join(resolvedRoot, 'logs'),
    evidenceDir: path.join(resolvedRoot, 'harness', 'evidence', 'cli'),
    evidenceManifestPath: path.join(resolvedRoot, 'harness', 'evidence.json'),
    specPath: path.join(resolvedRoot, 'harness', 'spec.json'),
    briefPath: path.join(resolvedRoot, 'harness', 'brief.json'),
    doctorPath: path.join(resolvedRoot, 'harness', 'doctor.json'),
    qualityPath: path.join(resolvedRoot, 'harness', 'quality.json'),
    gitPath: path.join(resolvedRoot, 'harness', 'git.json'),
    hashesPath: path.join(resolvedRoot, 'hashes.json'),
    timingPath: path.join(resolvedRoot, 'timing.json'),
    validationPath: path.join(resolvedRoot, 'validation.json'),
    v3ValidationPath: path.join(resolvedRoot, 'validation-report.json'),
    visualPath: path.join(resolvedRoot, 'harness', 'visual.json'),
    reportPath: path.join(resolvedRoot, 'report.json'),
    v3ReportPath: path.join(resolvedRoot, 'run-report.json'),
  };
  await mkdir(layout.harnessDir, { recursive: true });
  await mkdir(layout.profileDir, { recursive: true });
  await mkdir(layout.freshProfileDir, { recursive: true });
  await mkdir(layout.recoveryProfileDir, { recursive: true });
  await mkdir(layout.projectDir, { recursive: true });
  await mkdir(layout.artifactDir, { recursive: true });
  await mkdir(layout.lifecycleDir, { recursive: true });
  await mkdir(layout.logsDir, { recursive: true });
  await mkdir(layout.evidenceDir, { recursive: true });
  return layout;
}

export function defaultRunRoot(specId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const configured = process.env.FORESCENE_BENCHMARK_RUN_ROOT;
  const base = configured ? path.resolve(configured) : path.join(repoRoot(), 'artifacts', 'benchmark');
  return path.join(base, `${specId}-${stamp}`);
}
