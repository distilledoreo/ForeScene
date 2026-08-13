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
  operation?: string;
  message: string;
  details?: unknown;
}

export interface BenchmarkTimingPhase {
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  retries?: number;
  owner: 'harness' | 'candidate' | 'forescene';
}

export const FORBIDDEN_CANDIDATE_FILENAMES = [
  'run-benchmark.ts',
  'open-package.ts',
  'render-stills.ts',
] as const;
