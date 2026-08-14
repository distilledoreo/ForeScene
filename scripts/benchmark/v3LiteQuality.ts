import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkRunLayout } from './layout';
import type { V3LiteContract } from './v3LiteContract';
import type { V3LiteTechnicalValidation } from './v3LiteValidator';
import { evaluateV3LitePixelGate, type V3LitePixelGate } from './v3LitePixelGate';

export type V3LiteQualityStatus = 'passed' | 'low' | 'failed' | 'not-graded';

export interface V3LiteQualityGrade {
  status: V3LiteQualityStatus;
  ok: boolean;
  hardExecutionFailure: false;
  source: 'candidate-evidence' | 'missing-evidence' | 'invalid-evidence' | 'pixel-evidence' | 'candidate+pixel-evidence';
  message: string;
  technicalPass: boolean;
  checks?: unknown[];
  pixel?: V3LitePixelGate;
}

function candidateStatus(raw: unknown): V3LiteQualityStatus {
  return raw === 'pass' || raw === 'passed'
    ? 'passed'
    : raw === 'low' || raw === 'poor'
      ? 'low'
      : raw === 'fail' || raw === 'failed'
        ? 'failed'
        : 'not-graded';
}

export async function gradeV3LiteQuality(
  contract: V3LiteContract,
  layout: BenchmarkRunLayout,
  technical: V3LiteTechnicalValidation,
): Promise<V3LiteQualityGrade> {
  const pixel = await evaluateV3LitePixelGate(contract, layout);
  const evidencePath = path.join(layout.artifactDir, contract.quality.evidenceFile);
  let parsed: unknown;
  let candidateSource: V3LiteQualityGrade['source'] = 'missing-evidence';
  let status: V3LiteQualityStatus = 'not-graded';
  let candidateChecks: unknown[] | undefined;
  let candidateMessage = `No candidate quality evidence was supplied at ${evidencePath}; technical completion remains independently reportable.`;
  try {
    parsed = JSON.parse(await readFile(evidencePath, 'utf8')) as unknown;
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { grade?: unknown; status?: unknown; checks?: unknown[] }
      : {};
    status = candidateStatus(record.grade ?? record.status);
    const valid = status !== 'not-graded';
    candidateSource = valid ? 'candidate-evidence' : 'invalid-evidence';
    candidateMessage = valid
      ? `Candidate quality evidence grades the run ${status}; this is separate from technical execution.`
      : `Candidate quality evidence did not contain a supported grade; technical completion remains independently reportable.`;
    if (Array.isArray(record.checks)) candidateChecks = record.checks;
  } catch {
    parsed = undefined;
  }

  if (!pixel.ok) {
    status = 'failed';
    candidateSource = candidateSource === 'candidate-evidence' || candidateSource === 'invalid-evidence'
      ? 'candidate+pixel-evidence'
      : 'pixel-evidence';
    candidateMessage = pixel.message;
  } else if (status === 'passed' && !pixel.visuallyControlled) {
    status = 'not-graded';
    candidateSource = candidateSource === 'candidate-evidence'
      ? 'candidate+pixel-evidence'
      : candidateSource;
    candidateMessage = `${candidateMessage} ${pixel.message}`;
  }

  return {
    status,
    ok: status === 'passed',
    hardExecutionFailure: false,
    source: candidateSource,
    message: candidateMessage,
    technicalPass: technical.ok,
    checks: [
      ...(candidateChecks ?? []),
      ...pixel.checks,
    ],
    pixel,
  };
}
