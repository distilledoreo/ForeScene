import type { BenchmarkCandidateBrief, BenchmarkSpecV1 } from './types';
import type { BenchmarkRunLayout } from './layout';
import { repoRoot } from './layout';

export function buildCandidateBrief(input: {
  spec: BenchmarkSpecV1;
  layout: BenchmarkRunLayout;
  url?: string;
  projectPackage?: string;
  productionManifest?: string;
}): BenchmarkCandidateBrief {
  return {
    mode: 'benchmark',
    specId: input.spec.id,
    writeAuthorized: input.spec.writeAuthorized,
    resetAuthorized: input.spec.resetAuthorized,
    repairBudget: input.spec.repairBudget,
    cliOnly: true,
    forbidWindowForeScene: true,
    forbidSourceInspection: true,
    forbidHarnessScripts: true,
    url: input.url,
    repoRoot: repoRoot(),
    profileDir: input.layout.profileDir,
    outputDir: input.layout.artifactDir,
    projectPackage: input.projectPackage,
    productionManifest: input.productionManifest,
    shots: input.spec.shots,
  };
}
