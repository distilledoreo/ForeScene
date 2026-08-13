/**
 * Visual grader: subject/camera/environment/motion metrics from Agent CLI
 * visual-preflight. Distinct from the technical validator. Never encodes a
 * camera coordinate solution.
 *
 * Required evidence fails closed: a missing check is not_verified, not a pass.
 * An empty missingSubjectIds list is not proof that required subjects are visible.
 */

import { writeFile } from 'node:fs/promises';
import { failureFromInvocation, invokeAgentCli, type AgentCliInvocation } from './agentCli';
import { repoRoot, type BenchmarkRunLayout } from './layout';
import type { BenchmarkFailure, BenchmarkSpecV1, SemanticSubjectBinding } from './types';

export interface VisualMetricCheck {
  id: string;
  layer: 'subject' | 'camera' | 'environment' | 'motion';
  ok: boolean;
  status: 'passed' | 'failed' | 'not_verified';
  message: string;
}

export interface VisualGrade {
  ok: boolean;
  skipped: boolean;
  message: string;
  checks: VisualMetricCheck[];
}

interface PreflightSubject {
  objectId?: string;
  name?: string;
  stagingRole?: string;
}

interface PreflightShot {
  shotId?: string;
  ok?: boolean;
  environmentOnly?: boolean;
  requestedSubjectIds?: string[];
  missingSubjectIds?: string[];
  presentSubjectIds?: string[];
  verifiedSubjectIds?: string[];
  subjects?: PreflightSubject[];
  checks?: Array<{ id?: string; status?: string; message?: string }>;
  samples?: Array<{ timeSeconds?: number; label?: string }>;
}

const REQUIRED_STILL_CHECKS = ['camera_direction', 'subject_visibility', 'framing_coverage'] as const;

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

export function extractSemanticBindings(spec: BenchmarkSpecV1, payload: unknown): SemanticSubjectBinding[] {
  const record = asRecord(payload);
  const nested = record ? asRecord(record.result) : undefined;
  const fromPayload = (nested?.semanticSubjectBindings ?? record?.semanticSubjectBindings) as unknown;
  const extra = Array.isArray(fromPayload) ? fromPayload as SemanticSubjectBinding[] : [];
  const merged = new Map<string, SemanticSubjectBinding>();
  for (const binding of [...(spec.semanticSubjectBindings ?? []), ...extra]) {
    if (binding?.semanticId) merged.set(binding.semanticId, binding);
  }
  return [...merged.values()];
}

function matchPreflight(specShotId: string, shotNumber: string, rows: PreflightShot[]): PreflightShot | undefined {
  return rows.find((row) => {
    const id = String(row.shotId ?? '');
    return id === specShotId || id === shotNumber || id.endsWith(`-${shotNumber}`) || id.includes(shotNumber);
  });
}

function requireCheck(
  shotNumber: string,
  row: PreflightShot,
  checkId: string,
  layer: VisualMetricCheck['layer'],
): VisualMetricCheck {
  const found = row.checks?.find((check) => check.id === checkId);
  if (!found) {
    return {
      id: `visual.${shotNumber}.${checkId}`,
      layer,
      ok: false,
      status: 'not_verified',
      message: `Required ${checkId} evidence is missing for shot ${shotNumber} (not an implicit pass).`,
    };
  }
  if (found.status !== 'passed') {
    return {
      id: `visual.${shotNumber}.${checkId}`,
      layer,
      ok: false,
      status: found.status === 'failed' ? 'failed' : 'not_verified',
      message: found.message ?? `${checkId} did not pass on shot ${shotNumber}.`,
    };
  }
  return {
    id: `visual.${shotNumber}.${checkId}`,
    layer,
    ok: true,
    status: 'passed',
    message: `${checkId} passed on shot ${shotNumber}.`,
  };
}

function presentIds(row: PreflightShot): Set<string> {
  const ids = [
    ...(row.presentSubjectIds ?? []),
    ...(row.verifiedSubjectIds ?? []),
    ...(row.subjects ?? []).map((subject) => subject.objectId).filter((id): id is string => Boolean(id)),
  ];
  return new Set(ids);
}

function resolveBoundObjectId(
  semanticId: string,
  bindings: SemanticSubjectBinding[],
  row: PreflightShot,
): { objectId?: string; reason: string } {
  const binding = bindings.find((item) => item.semanticId === semanticId);
  if (!binding) {
    return { reason: `No semantic binding from "${semanticId}" to a ForeScene object id.` };
  }
  if (binding.objectId) {
    if (binding.objectId === semanticId) {
      return { reason: `Binding for "${semanticId}" reuses the semantic name as objectId; that is not proof.` };
    }
    return { objectId: binding.objectId, reason: `Bound ${semanticId} → ${binding.objectId}` };
  }
  const subjects = row.subjects ?? [];
  const byName = binding.name
    ? subjects.find((subject) => subject.name?.toLowerCase() === binding.name?.toLowerCase())
    : undefined;
  const byRole = binding.stagingRole
    ? subjects.find((subject) => subject.stagingRole === binding.stagingRole)
    : undefined;
  const matched = byName ?? byRole;
  if (!matched?.objectId) {
    return { reason: `Binding for "${semanticId}" did not match a live subject by name/role.` };
  }
  if (matched.objectId === semanticId) {
    return { reason: `Matched object id accidentally equals semantic id "${semanticId}".` };
  }
  return { objectId: matched.objectId, reason: `Bound ${semanticId} → ${matched.objectId}` };
}

function motionSamplesOk(row: PreflightShot): boolean {
  const samples = Array.isArray(row.samples) ? row.samples : [];
  const times = samples
    .map((sample) => sample.timeSeconds)
    .filter((time): time is number => typeof time === 'number' && Number.isFinite(time))
    .sort((a, b) => a - b);
  if (times.length < 3) return false;
  const start = times[0]!;
  const end = times[times.length - 1]!;
  if (end <= start) return false;
  const mid = (start + end) / 2;
  return times.some((time) => Math.abs(time - mid) <= (end - start) * 0.35);
}

export function gradeVisualDiagnostics(spec: BenchmarkSpecV1, payload: unknown): VisualGrade {
  const rows = extractPreflightShots(payload);
  const bindings = extractSemanticBindings(spec, payload);
  const checks: VisualMetricCheck[] = [];

  for (const shot of spec.shots) {
    const row = matchPreflight(shot.id, shot.shotNumber, rows);
    if (!row) {
      checks.push({
        id: `visual.${shot.shotNumber}.present`,
        layer: 'subject',
        ok: false,
        status: 'not_verified',
        message: `No visual-preflight row matched shot ${shot.shotNumber}.`,
      });
      continue;
    }

    const present = presentIds(row);
    const missing = new Set(row.missingSubjectIds ?? []);
    for (const semanticId of shot.requiredSubjects) {
      const bound = resolveBoundObjectId(semanticId, bindings, row);
      if (!bound.objectId) {
        checks.push({
          id: `visual.${shot.shotNumber}.subject.${semanticId}`,
          layer: 'subject',
          ok: false,
          status: 'not_verified',
          message: bound.reason,
        });
        continue;
      }
      const positivelyPresent = present.has(bound.objectId);
      const listedMissing = missing.has(bound.objectId);
      const ok = positivelyPresent && !listedMissing && row.environmentOnly !== true;
      checks.push({
        id: `visual.${shot.shotNumber}.subject.${semanticId}`,
        layer: 'subject',
        ok,
        status: ok ? 'passed' : (listedMissing ? 'failed' : 'not_verified'),
        message: ok
          ? bound.reason
          : listedMissing
            ? `Bound subject ${semanticId} (${bound.objectId}) is missing from the shot.`
            : `Empty missingSubjectIds is not proof. ${semanticId} (${bound.objectId}) was not positively verified.`,
      });
    }

    for (const checkId of REQUIRED_STILL_CHECKS) {
      const layer = checkId === 'camera_direction' ? 'camera' : checkId === 'framing_coverage' ? 'camera' : 'environment';
      checks.push(requireCheck(shot.shotNumber, row, checkId, layer));
    }

    if (shot.intent === 'motion-required') {
      checks.push(requireCheck(shot.shotNumber, row, 'motion_continuity', 'motion'));
      const samplesOk = motionSamplesOk(row);
      checks.push({
        id: `visual.${shot.shotNumber}.motion.samples`,
        layer: 'motion',
        ok: samplesOk,
        status: samplesOk ? 'passed' : 'not_verified',
        message: samplesOk
          ? 'Start/mid/end motion samples are present.'
          : `Motion-required shot ${shot.shotNumber} needs start, mid, and end samples plus continuity.`,
      });
    }
  }

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    skipped: false,
    message: ok
      ? 'Visual grader passed (separate from technical file validation).'
      : 'Visual grader failed closed. Technical file presence is not visual approval.',
    checks,
  };
}

export function skippedVisualGrade(reason: string): VisualGrade {
  return {
    ok: false,
    skipped: true,
    message: reason,
    checks: [{
      id: 'visual.skipped',
      layer: 'subject',
      ok: false,
      status: 'not_verified',
      message: reason,
    }],
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
    const grade = skippedVisualGrade('visual-preflight did not return an envelope.');
    return {
      grade,
      failure: failureFromInvocation(invocation, 'verify.visualPreflight'),
      invocation,
    };
  }
  const payload = invocation.envelope ?? JSON.parse(invocation.stdout.slice(invocation.stdout.indexOf('{')));
  const grade = gradeVisualDiagnostics(input.spec, payload);
  await writeFile(input.layout.visualPath, `${JSON.stringify({ payload, grade }, null, 2)}\n`, 'utf8');
  if (invocation.code !== 0 && (/\btimeout\b/i.test(invocation.stderr + (invocation.envelope?.error?.message ?? '')) || /exceeded \d+ms/i.test(invocation.stderr))) {
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
