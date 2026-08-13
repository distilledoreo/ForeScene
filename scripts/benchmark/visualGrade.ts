/**
 * Visual grader: subject/camera/environment/motion metrics from Agent CLI
 * visual-preflight. Distinct from the technical validator. Never encodes a
 * camera coordinate solution.
 */

import { writeFile } from 'node:fs/promises';
import { failureFromInvocation, invokeAgentCli, type AgentCliInvocation } from './agentCli';
import { repoRoot, type BenchmarkRunLayout } from './layout';
import type { BenchmarkFailure, BenchmarkSpecV1 } from './types';

export interface VisualMetricCheck {
  id: string;
  layer: 'subject' | 'camera' | 'environment' | 'motion';
  ok: boolean;
  message: string;
}

export interface VisualGrade {
  ok: boolean;
  skipped: boolean;
  message: string;
  checks: VisualMetricCheck[];
}

interface PreflightShot {
  shotId?: string;
  ok?: boolean;
  environmentOnly?: boolean;
  requestedSubjectIds?: string[];
  missingSubjectIds?: string[];
  checks?: Array<{ id?: string; status?: string; message?: string }>;
  samples?: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function extractPreflightShots(payload: unknown): PreflightShot[] {
  const record = asRecord(payload);
  const nested = record ? asRecord(record.result) : undefined;
  const list = (nested?.visualPreflight ?? record?.visualPreflight) as unknown;
  return Array.isArray(list) ? list as PreflightShot[] : [];
}

function matchPreflight(specShotId: string, shotNumber: string, rows: PreflightShot[]): PreflightShot | undefined {
  return rows.find((row) => {
    const id = String(row.shotId ?? '');
    return id === specShotId || id === shotNumber || id.endsWith(`-${shotNumber}`) || id.includes(shotNumber);
  });
}

export function gradeVisualDiagnostics(spec: BenchmarkSpecV1, payload: unknown): VisualGrade {
  const rows = extractPreflightShots(payload);
  const checks: VisualMetricCheck[] = [];

  for (const shot of spec.shots) {
    const row = matchPreflight(shot.id, shot.shotNumber, rows);
    if (!row) {
      checks.push({
        id: `visual.${shot.shotNumber}.present`,
        layer: 'subject',
        ok: false,
        message: `No visual-preflight row matched shot ${shot.shotNumber}.`,
      });
      continue;
    }

    const required = shot.requiredSubjects;
    const missing = new Set(row.missingSubjectIds ?? []);
    const requested = new Set(row.requestedSubjectIds ?? []);
    const subjectOk = required.every((id) => !missing.has(id))
      && !(row.environmentOnly === true && required.length > 0);
    checks.push({
      id: `visual.${shot.shotNumber}.subjects`,
      layer: 'subject',
      ok: subjectOk,
      message: subjectOk
        ? `Required subjects readable: ${required.join(', ') || 'none'}.`
        : row.environmentOnly && required.length > 0
          ? `Shot ${shot.shotNumber} is environment-only but spec requires ${required.join(', ')}.`
          : `Missing required subjects on ${shot.shotNumber}: ${required.filter((id) => missing.has(id) || (requested.size > 0 && !requested.has(id))).join(', ') || required.join(', ')}.`,
    });

    const cameraCheck = row.checks?.find((check) => check.id === 'camera_direction');
    const cameraOk = cameraCheck?.status !== 'failed';
    checks.push({
      id: `visual.${shot.shotNumber}.camera`,
      layer: 'camera',
      ok: cameraOk,
      message: cameraOk
        ? 'Camera direction check did not fail (no hard-coded camera coordinates).'
        : cameraCheck?.message ?? `Camera direction failed on shot ${shot.shotNumber}.`,
    });

    const envCheck = row.checks?.find((check) => check.id === 'subject_visibility' || check.id === 'framing_coverage');
    const envOk = envCheck?.status !== 'failed';
    checks.push({
      id: `visual.${shot.shotNumber}.environment`,
      layer: 'environment',
      ok: envOk,
      message: envOk
        ? 'Environment/subject visibility did not fail.'
        : envCheck?.message ?? `Environment visibility failed on shot ${shot.shotNumber}.`,
    });

    if (shot.intent === 'motion-required') {
      const motionCheck = row.checks?.find((check) => check.id === 'motion_continuity');
      const sampleCount = Array.isArray(row.samples) ? row.samples.length : 0;
      const motionOk = motionCheck?.status !== 'failed' && (sampleCount >= 2 || motionCheck?.status === 'passed');
      checks.push({
        id: `visual.${shot.shotNumber}.motion`,
        layer: 'motion',
        ok: motionOk,
        message: motionOk
          ? 'Motion continuity/samples are present.'
          : `Motion-required shot ${shot.shotNumber} needs motion_continuity and start/mid/end samples.`,
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    skipped: false,
    message: checks.every((check) => check.ok)
      ? 'Visual grader passed (separate from technical file validation).'
      : 'Visual grader failed. Technical file presence is not visual approval.',
    checks,
  };
}

export function skippedVisualGrade(reason: string): VisualGrade {
  return {
    ok: true,
    skipped: true,
    message: reason,
    checks: [],
  };
}

export async function runLiveVisualGrade(input: {
  spec: BenchmarkSpecV1;
  layout: BenchmarkRunLayout;
  url: string;
}): Promise<{ grade: VisualGrade; failure?: BenchmarkFailure; invocation?: AgentCliInvocation }> {
  const invocation = await invokeAgentCli({
    repoRoot: repoRoot(),
    args: ['visual-preflight'],
    url: input.url,
    profile: input.layout.profileDir,
  });
  if (invocation.code !== 0 && !invocation.envelope) {
    return {
      grade: skippedVisualGrade('visual-preflight did not return an envelope.'),
      failure: failureFromInvocation(invocation, 'verify.visualPreflight'),
      invocation,
    };
  }
  const payload = invocation.envelope ?? JSON.parse(invocation.stdout.slice(invocation.stdout.indexOf('{')));
  const grade = gradeVisualDiagnostics(input.spec, payload);
  await writeFile(input.layout.visualPath, `${JSON.stringify({ payload, grade }, null, 2)}\n`, 'utf8');
  if (invocation.code !== 0 && /\btimeout\b/i.test(invocation.stderr + (invocation.envelope?.error?.message ?? ''))) {
    return {
      grade,
      failure: failureFromInvocation(invocation, 'verify.visualPreflight'),
      invocation,
    };
  }
  if (!grade.ok) {
    return {
      grade,
      failure: {
        class: 'MODEL_FAILURE',
        operation: 'visual.grade',
        message: grade.message,
        details: grade.checks.filter((check) => !check.ok),
      },
      invocation,
    };
  }
  return { grade, invocation };
}
