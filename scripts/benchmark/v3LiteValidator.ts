import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkRunLayout } from './layout';
import type { V3LiteContract } from './v3LiteContract';

export interface V3LiteTechnicalCheck {
  id: string;
  ok: boolean;
  message: string;
  byteLength?: number;
}

export interface V3LiteTechnicalValidation {
  ok: boolean;
  checks: V3LiteTechnicalCheck[];
  candidateExitCode?: number;
}

async function fileCheck(filePath: string, id: string, label: string): Promise<V3LiteTechnicalCheck> {
  try {
    const info = await stat(filePath);
    const ok = info.isFile() && info.size > 0;
    return {
      id,
      ok,
      byteLength: info.size,
      message: ok ? `${label} exists with ${info.size} bytes.` : `${label} is missing or empty: ${filePath}`,
    };
  } catch {
    return { id, ok: false, message: `${label} is missing: ${filePath}` };
  }
}

async function mp4Check(filePath: string, id: string, label: string): Promise<V3LiteTechnicalCheck> {
  const basic = await fileCheck(filePath, id, label);
  if (!basic.ok) return basic;
  const bytes = await readFile(filePath);
  const encoded = bytes.byteLength >= 12
    && (bytes.subarray(4, 8).toString('ascii') === 'ftyp' || bytes.includes(Buffer.from('ftyp')));
  return {
    ...basic,
    ok: encoded,
    message: encoded ? `${label} is non-empty and contains an MP4 ftyp box.` : `${label} is non-empty but does not look like an encoded MP4.`,
  };
}

function targetForArtifact(layout: BenchmarkRunLayout, artifact: string): string {
  if (path.isAbsolute(artifact) || artifact.includes('..') || artifact.includes('/') || artifact.includes('\\')) {
    throw new Error(`V3-Lite artifact names must be flat relative file names: ${artifact}`);
  }
  if (artifact === 'final-project.fsp' || artifact === 'run-report.json' || artifact === 'validation-report.json') {
    return path.join(layout.runRoot, artifact);
  }
  return path.join(layout.artifactDir, artifact);
}

export async function validateV3LiteTechnical(
  contract: V3LiteContract,
  layout: BenchmarkRunLayout,
  candidateExitCode?: number,
): Promise<V3LiteTechnicalValidation> {
  const checks: V3LiteTechnicalCheck[] = [];
  const accounted = new Set([
    ...contract.requiredStills,
    ...contract.requiredMotion,
    'final-project.fsp',
    'run-report.json',
    'validation-report.json',
  ]);
  const unaccounted = contract.requiredArtifacts.filter((artifact) => !accounted.has(artifact));
  checks.push({
    id: 'contract.artifact-accounting',
    ok: unaccounted.length === 0,
    message: unaccounted.length === 0
      ? 'Every frozen required artifact has a structural validation owner.'
      : `Frozen required artifacts lack a structural validation owner: ${unaccounted.join(', ')}.`,
  });
  for (const artifact of contract.requiredStills) {
    checks.push(await fileCheck(targetForArtifact(layout, artifact), `still.${artifact}`, `Required still ${artifact}`));
  }
  for (const artifact of contract.requiredMotion) {
    checks.push(await mp4Check(targetForArtifact(layout, artifact), `motion.${artifact}`, `Required motion ${artifact}`));
  }
  checks.push(await fileCheck(targetForArtifact(layout, 'final-project.fsp'), 'project.final', 'Final project backup'));
  return {
    ok: checks.every((check) => check.ok),
    checks,
    ...(candidateExitCode === undefined ? {} : { candidateExitCode }),
  };
}

export function addReportArtifactChecks(
  validation: V3LiteTechnicalValidation,
  layout: BenchmarkRunLayout,
): V3LiteTechnicalValidation {
  const checks = [
    ...validation.checks,
    {
      id: 'report.run',
      ok: true,
      message: `Run report is written at ${layout.v3ReportPath}.`,
    },
    {
      id: 'report.validation',
      ok: true,
      message: `Validation report is written at ${layout.v3ValidationPath}.`,
    },
  ];
  return { ...validation, checks, ok: checks.every((check) => check.ok) };
}
