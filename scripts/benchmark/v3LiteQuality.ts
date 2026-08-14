import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkRunLayout } from './layout';
import type { V3LiteContract } from './v3LiteContract';
import type { V3LiteTechnicalValidation } from './v3LiteValidator';

export type V3LiteQualityStatus = 'passed' | 'low' | 'failed' | 'not-graded';

export interface V3LiteQualityGrade {
  status: V3LiteQualityStatus;
  ok: boolean;
  hardExecutionFailure: false;
  source: 'candidate-evidence' | 'missing-evidence' | 'invalid-evidence';
  message: string;
  technicalPass: boolean;
  checks?: unknown[];
}

export async function gradeV3LiteQuality(
  contract: V3LiteContract,
  layout: BenchmarkRunLayout,
  technical: V3LiteTechnicalValidation,
): Promise<V3LiteQualityGrade> {
  const evidencePath = path.join(layout.artifactDir, contract.quality.evidenceFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(evidencePath, 'utf8')) as unknown;
  } catch {
    return {
      status: 'not-graded',
      ok: false,
      hardExecutionFailure: false,
      source: 'missing-evidence',
      message: `No candidate quality evidence was supplied at ${evidencePath}; technical completion remains independently reportable.`,
      technicalPass: technical.ok,
    };
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as { grade?: unknown; status?: unknown; checks?: unknown[] }
    : {};
  const raw = record.grade ?? record.status;
  const status: V3LiteQualityStatus = raw === 'pass' || raw === 'passed'
    ? 'passed'
    : raw === 'low' || raw === 'poor'
      ? 'low'
      : raw === 'fail' || raw === 'failed'
        ? 'failed'
        : 'not-graded';
  const valid = status !== 'not-graded';
  return {
    status,
    ok: status === 'passed',
    hardExecutionFailure: false,
    source: valid ? 'candidate-evidence' : 'invalid-evidence',
    message: valid
      ? `Candidate quality evidence grades the run ${status}; this is separate from technical execution.`
      : `Candidate quality evidence did not contain a supported grade; technical completion remains independently reportable.`,
    technicalPass: technical.ok,
    ...(Array.isArray(record.checks) ? { checks: record.checks } : {}),
  };
}
