/**
 * ForeScene Benchmark Harness V3 — shared types.
 *
 * The harness owns mechanical bookkeeping. The candidate owns creative previs.
 */

export const BENCHMARK_SPEC_VERSION = 1 as const;

export type BenchmarkFailureClass =
  | 'MODEL_FAILURE'
  | 'INFRASTRUCTURE_FAILURE'
  | 'HARNESS_FAILURE'
  | 'ENVIRONMENT_FAILURE';

export type BenchmarkShotIntent = 'still' | 'motion-required' | 'motion-optional';

export interface BenchmarkShotSpec {
  id: string;
  shotNumber: string;
  name: string;
  description: string;
  intent: BenchmarkShotIntent;
  /** Semantic subject ids required to be readable. Never encode camera coordinates. */
  requiredSubjects: string[];
  framing?: string;
  stillArtifacts: string[];
  motionArtifacts?: string[];
}

export interface SemanticSubjectBinding {
  semanticId: string;
  objectId?: string;
  name?: string;
  stagingRole?: string;
}

export interface BenchmarkSpecV1 {
  version: typeof BENCHMARK_SPEC_VERSION;
  id: string;
  name: string;
  description: string;
  qualityMode: 'rapid-previs' | 'production-integrity';
  operatingMode: 'greenfield' | 'existing-project-refinement' | 'export-only';
  writeAuthorized: boolean;
  resetAuthorized: boolean;
  repairBudget: number;
  shots: BenchmarkShotSpec[];
  semanticSubjectBindings?: SemanticSubjectBinding[];
  requiredCliCapabilities: string[];
  basePackage?: string;
  assets?: Array<{ id: string; path: string; kind: 'glb' | 'fsrig' | 'panorama' | 'other' }>;
}

export interface BenchmarkCandidateBrief {
  mode: 'benchmark';
  specId: string;
  writeAuthorized: boolean;
  resetAuthorized: boolean;
  repairBudget: number;
  cliOnly: true;
  forbidWindowForeScene: true;
  forbidSourceInspection: true;
  forbidHarnessScripts: true;
  url?: string;
  repoRoot: string;
  profileDir: string;
  outputDir: string;
  projectPackage?: string;
  shots: BenchmarkShotSpec[];
}

export interface BenchmarkFailure {
  class: BenchmarkFailureClass;
  /** Distinguishes application defects from transient infra inside INFRASTRUCTURE_FAILURE. */
  code?: string;
  operation?: string;
  message: string;
  details?: unknown;
}

export type BenchmarkTimingOwner = 'harness' | 'candidate' | 'forescene';

export type BenchmarkTimingKind = 'span' | 'operation';

export interface BenchmarkTimingPhase {
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  retries?: number;
  owner: BenchmarkTimingOwner;
  kind?: BenchmarkTimingKind;
  parentId?: string;
  operation?: string;
  command?: string;
  appearance?: 'clay' | 'projected' | 'depth';
  chromiumLaunches?: number;
  cacheHits?: number;
  cacheMisses?: number;
  encodeMs?: number;
  notes?: string;
}

export interface BenchmarkCacheTiming {
  present: boolean;
  hits: number;
  misses: number;
}

export interface BenchmarkTimingSummary {
  wallMs: number;
  harnessWallMs: number;
  candidateWallMs: number;
  foresceneToolMs: number;
  candidateMinusToolMs: number;
  operationCount: number;
  chromiumLaunches: number;
  chromiumLaunchSource: 'logged' | 'inferred-cli-ops' | 'none';
  retries: number;
  cache: BenchmarkCacheTiming;
  byPhaseId: Record<string, { count: number; durationMs: number }>;
  phases: BenchmarkTimingPhase[];
  policy: {
    measureBeforeOptimize: true;
    retriesMustRemainZero: true;
    soakGateTotalsAreNotE2EPhases: true;
  };
}

export const FORBIDDEN_CANDIDATE_FILENAMES = [
  'run-benchmark.ts',
  'open-package.ts',
  'render-stills.ts',
] as const;
