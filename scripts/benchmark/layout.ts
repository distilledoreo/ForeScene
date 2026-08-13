import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRootFromHere = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function repoRoot(): string {
  return process.env.FORESCENE_REPO_ROOT
    ? path.resolve(process.env.FORESCENE_REPO_ROOT)
    : repoRootFromHere;
}

export interface BenchmarkRunLayout {
  runRoot: string;
  harnessDir: string;
  profileDir: string;
  projectDir: string;
  workDir: string;
  artifactDir: string;
  lifecycleDir: string;
  logsDir: string;
  specPath: string;
  briefPath: string;
  gitPath: string;
  hashesPath: string;
  timingPath: string;
  validationPath: string;
  reportPath: string;
}

export async function createBenchmarkRunLayout(runRoot: string): Promise<BenchmarkRunLayout> {
  const layout: BenchmarkRunLayout = {
    runRoot,
    harnessDir: path.join(runRoot, 'harness'),
    profileDir: path.join(runRoot, 'profile'),
    projectDir: path.join(runRoot, 'project'),
    workDir: path.join(runRoot, 'work'),
    artifactDir: path.join(runRoot, 'work', 'artifacts'),
    lifecycleDir: path.join(runRoot, 'lifecycle'),
    logsDir: path.join(runRoot, 'logs'),
    specPath: path.join(runRoot, 'harness', 'spec.json'),
    briefPath: path.join(runRoot, 'harness', 'brief.json'),
    gitPath: path.join(runRoot, 'harness', 'git.json'),
    hashesPath: path.join(runRoot, 'hashes.json'),
    timingPath: path.join(runRoot, 'timing.json'),
    validationPath: path.join(runRoot, 'validation.json'),
    reportPath: path.join(runRoot, 'report.json'),
  };
  await mkdir(layout.harnessDir, { recursive: true });
  await mkdir(layout.profileDir, { recursive: true });
  await mkdir(layout.projectDir, { recursive: true });
  await mkdir(layout.artifactDir, { recursive: true });
  await mkdir(layout.lifecycleDir, { recursive: true });
  await mkdir(layout.logsDir, { recursive: true });
  return layout;
}

export function defaultRunRoot(specId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(repoRoot(), 'artifacts', 'benchmark', `${specId}-${stamp}`);
}
