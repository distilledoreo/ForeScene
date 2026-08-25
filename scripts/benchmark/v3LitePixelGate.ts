/**
 * Pixel-aware visual-control gate for V3-Lite.
 *
 * Technical file presence can pass while a still is mostly gray or missing a
 * required subject. This gate samples the written PNGs and any adjacent
 * composition/validation evidence, then reports quality findings. It never
 * rewrites technical validation or converts a visual miss into a harness
 * infrastructure failure.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { computeRenderPixelStats } from '../../src/engine/previs/renderPixelStats';
import type { BenchmarkRunLayout } from './layout';
import { decodePngRgba, looksLikePng } from './pngRgba';
import type { V3LiteContract } from './v3LiteContract';

export type V3LitePixelCheckSeverity = 'passed' | 'failed' | 'warning' | 'not_verified';

export interface V3LitePixelCheck {
  id: string;
  artifact: string;
  ok: boolean;
  status: V3LitePixelCheckSeverity;
  code: string;
  message: string;
  measured?: Record<string, number | string | boolean | undefined>;
}

export interface V3LitePixelGate {
  ok: boolean;
  visuallyControlled: boolean;
  message: string;
  checks: V3LitePixelCheck[];
}

const SAMPLE_STRIDE = 8;
const GRAY_CHROMA_MAX = 18;
const MOSTLY_GRAY_RATIO = 0.9;
const MOSTLY_GRAY_UNIQUE_COLORS = 18;
const MOSTLY_GRAY_VARIANCE = 0.012;
// This is deliberately a catastrophic-crop threshold, not a general close-up
// rule. Ordinary close framing may crop accessories; an assembly several times
// larger than the frame cannot still count as verified subject readability.
const SEVERE_UNCLIPPED_WIDTH = 1.25;
const SEVERE_UNCLIPPED_HEIGHT = 1.5;
const SEVERE_UNCLIPPED_AREA = 1.5;
const SUBJECT_FAILURE_CODES = new Set([
  'required_subject_missing',
  'required_subject_hidden',
  'subject_out_of_frame',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function check(partial: Omit<V3LitePixelCheck, 'ok'>): V3LitePixelCheck {
  return { ...partial, ok: partial.status === 'passed' };
}

export function analyzeRgbaFrame(data: Uint8Array, width: number, height: number): {
  stats: ReturnType<typeof computeRenderPixelStats>;
  grayPixelRatio: number;
  mostlyGray: boolean;
} {
  const stats = computeRenderPixelStats(data, width, height);
  let sampled = 0;
  let gray = 0;
  for (let y = 0; y < height; y += SAMPLE_STRIDE) {
    for (let x = 0; x < width; x += SAMPLE_STRIDE) {
      const i = (y * width + x) * 4;
      if (i + 3 >= data.length) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      sampled += 1;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma <= GRAY_CHROMA_MAX) gray += 1;
    }
  }
  const grayPixelRatio = sampled > 0 ? gray / sampled : 1;
  const mostlyGray = grayPixelRatio >= MOSTLY_GRAY_RATIO
    && stats.sampledUniqueColorCount <= MOSTLY_GRAY_UNIQUE_COLORS
    && stats.luminanceVariance < MOSTLY_GRAY_VARIANCE;
  return { stats, grayPixelRatio, mostlyGray };
}

function shotForArtifact(contract: V3LiteContract, artifact: string) {
  return contract.shots.find((shot) => shot.stillArtifacts.includes(artifact));
}

async function readJsonIfPresent(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function subjectVisibleFromComposition(
  composition: unknown,
  subjectId: string,
): boolean | undefined {
  const subjects = asRecord(asRecord(composition)?.subjects);
  if (!subjects) return undefined;
  const direct = asRecord(subjects[subjectId]);
  const matched = direct ?? Object.entries(subjects).find(([key]) => (
    key.toLowerCase() === subjectId.toLowerCase()
    || key.toLowerCase().includes(subjectId.toLowerCase())
  ))?.[1];
  const record = asRecord(matched);
  if (!record || typeof record.visible !== 'boolean') return undefined;
  return record.visible;
}

function matchedSubjectFromComposition(
  composition: unknown,
  subjectId: string,
): Record<string, unknown> | undefined {
  const subjects = asRecord(asRecord(composition)?.subjects);
  if (!subjects) return undefined;
  const direct = asRecord(subjects[subjectId]);
  return direct ?? asRecord(Object.entries(subjects).find(([key]) => (
    key.toLowerCase() === subjectId.toLowerCase()
    || key.toLowerCase().includes(subjectId.toLowerCase())
  ))?.[1]);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface CompositionFramingFailure {
  code: 'required_subject_behind_camera' | 'required_subject_severely_out_of_frame' | 'required_subject_incomplete_framing';
  message: string;
  measured: Record<string, number | string | boolean | undefined>;
}

/**
 * Convert composition telemetry into deterministic evidence only when it proves
 * a framing contradiction. Missing/partial telemetry stays unverified elsewhere;
 * it never invents a pass or failure.
 */
export function requiredSubjectFramingFailure(
  composition: unknown,
  subjectId: string,
): CompositionFramingFailure | undefined {
  const subject = matchedSubjectFromComposition(composition, subjectId);
  if (!subject) return undefined;
  const bounds = asRecord(subject.bounds);
  const bodyBounds = asRecord(subject.bodyBounds) ?? bounds;
  const assemblyBounds = asRecord(subject.assemblyBounds) ?? bounds;
  const unclipped = asRecord(assemblyBounds?.unclipped);
  const widthCoverage = finiteNumber(unclipped?.widthCoverage);
  const heightCoverage = finiteNumber(unclipped?.heightCoverage);
  const areaCoverage = finiteNumber(unclipped?.areaCoverage);
  const bodyClipped = bodyBounds?.clipped === true;
  const assemblyClipped = assemblyBounds?.clipped === true;
  const completeAssemblyInFrame = typeof subject.completeAssemblyInFrame === 'boolean'
    ? subject.completeAssemblyInFrame
    : undefined;
  const compositionRecord = asRecord(composition);
  const blockers = Array.isArray(compositionRecord?.blockers) ? compositionRecord.blockers : [];
  const dominantBlockerArea = blockers.reduce((largest, blocker) => (
    Math.max(largest, finiteNumber(asRecord(blocker)?.projectedArea) ?? 0)
  ), 0);
  const measured = {
    subject: subjectId,
    bodyClipped,
    assemblyClipped,
    completeAssemblyInFrame,
    unclippedWidthCoverage: widthCoverage,
    unclippedHeightCoverage: heightCoverage,
    unclippedAreaCoverage: areaCoverage,
    blockerCount: blockers.length,
    dominantBlockerArea,
  };

  if (bounds?.behindCamera === true || bodyBounds?.behindCamera === true || assemblyBounds?.behindCamera === true) {
    return {
      code: 'required_subject_behind_camera',
      message: `Required subject "${subjectId}" is behind the camera according to composition telemetry.`,
      measured,
    };
  }

  const severelyOutOfFrame = (widthCoverage !== undefined && widthCoverage > SEVERE_UNCLIPPED_WIDTH)
    || (heightCoverage !== undefined && heightCoverage > SEVERE_UNCLIPPED_HEIGHT)
    || (areaCoverage !== undefined && areaCoverage > SEVERE_UNCLIPPED_AREA);
  if (severelyOutOfFrame) {
    return {
      code: 'required_subject_severely_out_of_frame',
      message: `Required subject "${subjectId}" extends catastrophically beyond the frame; presence alone does not prove readable composition.`,
      measured,
    };
  }

  if (completeAssemblyInFrame === false && bodyClipped) {
    return {
      code: 'required_subject_incomplete_framing',
      message: `Required subject "${subjectId}" has a clipped body and incomplete assembly in composition telemetry.`,
      measured,
    };
  }
  return undefined;
}

function validationIssuesForShot(validation: unknown, shotNumber: string): Array<{ code?: string; subject?: string }> {
  const record = asRecord(validation);
  const results = Array.isArray(record?.results) ? record.results : [];
  const row = results.find((item) => asRecord(item)?.shotNumber === shotNumber);
  const issues = asRecord(row)?.issues;
  return Array.isArray(issues) ? issues as Array<{ code?: string; subject?: string }> : [];
}

export async function evaluateV3LitePixelGate(
  contract: V3LiteContract,
  layout: BenchmarkRunLayout,
): Promise<V3LitePixelGate> {
  const checks: V3LitePixelCheck[] = [];
  const validation = await readJsonIfPresent(path.join(layout.artifactDir, 'validation.json'));

  for (const artifact of contract.requiredStills) {
    const filePath = path.join(layout.artifactDir, artifact);
    const shot = shotForArtifact(contract, artifact);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      checks.push(check({
        id: `pixel.${artifact}.present`,
        artifact,
        status: 'not_verified',
        code: 'still_not_sampled',
        message: `Required still ${artifact} was not sampled; technical file presence remains a separate check.`,
      }));
      continue;
    }

    if (!looksLikePng(bytes)) {
      checks.push(check({
        id: `pixel.${artifact}.png`,
        artifact,
        status: 'not_verified',
        code: 'still_not_png',
        message: `${artifact} is non-empty but is not a decodable PNG; the pixel gate does not invent a visual pass or an infrastructure failure.`,
      }));
      continue;
    }

    let decoded: ReturnType<typeof decodePngRgba>;
    try {
      decoded = decodePngRgba(bytes);
    } catch (error) {
      checks.push(check({
        id: `pixel.${artifact}.decode`,
        artifact,
        status: 'not_verified',
        code: 'still_decode_failed',
        message: `${artifact} PNG decode failed (${error instanceof Error ? error.message : String(error)}); visual control stays unverified.`,
      }));
      continue;
    }

    const analysis = analyzeRgbaFrame(decoded.data, decoded.width, decoded.height);
    if (analysis.stats.opaquePixelRatio < 0.02 || analysis.stats.luminanceVariance < 1e-6 || analysis.stats.sampledUniqueColorCount < 3) {
      checks.push(check({
        id: `pixel.${artifact}.flat`,
        artifact,
        status: 'failed',
        code: 'frame_flat',
        message: `${artifact} is a flat or empty frame (var=${analysis.stats.luminanceVariance.toExponential(2)}, unique=${analysis.stats.sampledUniqueColorCount}).`,
        measured: {
          luminanceMean: analysis.stats.luminanceMean,
          luminanceVariance: analysis.stats.luminanceVariance,
          sampledUniqueColorCount: analysis.stats.sampledUniqueColorCount,
          opaquePixelRatio: analysis.stats.opaquePixelRatio,
          grayPixelRatio: analysis.grayPixelRatio,
        },
      }));
    } else if (analysis.mostlyGray) {
      checks.push(check({
        id: `pixel.${artifact}.gray`,
        artifact,
        status: 'failed',
        code: 'frame_mostly_gray',
        message: `${artifact} is mostly gray and lacks subject contrast (gray=${analysis.grayPixelRatio.toFixed(3)}, unique=${analysis.stats.sampledUniqueColorCount}).`,
        measured: {
          luminanceMean: analysis.stats.luminanceMean,
          luminanceVariance: analysis.stats.luminanceVariance,
          sampledUniqueColorCount: analysis.stats.sampledUniqueColorCount,
          grayPixelRatio: analysis.grayPixelRatio,
        },
      }));
    } else {
      checks.push(check({
        id: `pixel.${artifact}.content`,
        artifact,
        status: 'passed',
        code: 'frame_has_content',
        message: `${artifact} has non-flat pixel content.`,
        measured: {
          luminanceMean: analysis.stats.luminanceMean,
          luminanceVariance: analysis.stats.luminanceVariance,
          sampledUniqueColorCount: analysis.stats.sampledUniqueColorCount,
          grayPixelRatio: analysis.grayPixelRatio,
        },
      }));
    }

    if (!shot) continue;
    const composition = await readJsonIfPresent(path.join(layout.artifactDir, 'shots', `${shot.shotNumber}.composition.json`));
    const validationIssues = validationIssuesForShot(validation, shot.shotNumber);
    for (const subjectId of shot.requiredSubjects) {
      const validationHit = validationIssues.find((issue) => (
        typeof issue.code === 'string'
        && SUBJECT_FAILURE_CODES.has(issue.code)
        && (issue.subject === subjectId || issue.subject === undefined)
      ));
      const visible = subjectVisibleFromComposition(composition, subjectId);
      const framingFailure = requiredSubjectFramingFailure(composition, subjectId);
      if (validationHit || visible === false || framingFailure) {
        checks.push(check({
          id: `pixel.${artifact}.subject.${subjectId}`,
          artifact,
          status: 'failed',
          code: validationHit?.code ?? framingFailure?.code ?? 'required_subject_not_visible',
          message: framingFailure?.message ?? `${artifact} does not show required subject "${subjectId}".`,
          measured: framingFailure?.measured ?? {
              shotNumber: shot.shotNumber,
              subject: subjectId,
              compositionVisible: visible,
            },
        }));
      } else if (visible === true) {
        checks.push(check({
          id: `pixel.${artifact}.subject.${subjectId}`,
          artifact,
          status: 'passed',
          code: 'required_subject_visible',
          message: `Composition evidence lists "${subjectId}" as visible on ${artifact}.`,
          measured: { shotNumber: shot.shotNumber, subject: subjectId },
        }));
      } else {
        checks.push(check({
          id: `pixel.${artifact}.subject.${subjectId}`,
          artifact,
          status: 'not_verified',
          code: 'required_subject_unverified',
          message: `No composition evidence verified required subject "${subjectId}" on ${artifact}. Occupancy telemetry is not treated as a visual pass.`,
          measured: { shotNumber: shot.shotNumber, subject: subjectId },
        }));
      }
    }
  }

  const failed = checks.filter((item) => item.status === 'failed');
  const unverified = checks.filter((item) => item.status === 'not_verified');
  const ok = failed.length === 0;
  return {
    ok,
    visuallyControlled: ok && unverified.length === 0 && checks.length > 0,
    message: failed.length > 0
      ? `Pixel gate found ${failed.length} visual-control failure(s); this is quality evidence, not a technical infrastructure failure.`
      : unverified.length > 0
        ? `Pixel gate did not verify every required still/subject (${unverified.length} unverified); the run is not treated as visually controlled.`
        : 'Pixel gate found non-flat required stills and no missing required-subject evidence.',
    checks,
  };
}
