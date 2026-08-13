/**
 * Technical validator: structural project/output validity, not visual quality.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathIsNonemptyFile } from './forbidden';
import type { BenchmarkRunLayout } from './layout';
import type { BenchmarkSpecV1 } from './types';

export interface TechnicalCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface TechnicalValidation {
  ok: boolean;
  checks: TechnicalCheck[];
}

async function looksLikeMp4(filePath: string): Promise<boolean> {
  const bytes = await readFile(filePath).catch(() => Buffer.alloc(0));
  if (bytes.byteLength < 12) return false;
  return bytes.subarray(4, 8).toString('ascii') === 'ftyp' || bytes.includes(Buffer.from('ftyp'));
}

export async function validateTechnicalBenchmark(
  spec: BenchmarkSpecV1,
  layout: BenchmarkRunLayout,
): Promise<TechnicalValidation> {
  const checks: TechnicalCheck[] = [];

  const briefOk = await pathIsNonemptyFile(layout.briefPath);
  checks.push({
    id: 'brief.present',
    ok: briefOk,
    message: briefOk ? 'Candidate brief is present.' : 'Candidate brief is missing.',
  });

  const shotNumbers = spec.shots.map((shot) => shot.shotNumber);
  checks.push({
    id: 'shots.specified',
    ok: shotNumbers.length > 0,
    message: `Spec declares shots ${shotNumbers.join(', ')}.`,
  });

  for (const shot of spec.shots) {
    for (const relative of shot.stillArtifacts) {
      const target = path.join(layout.artifactDir, relative);
      const ok = await pathIsNonemptyFile(target);
      checks.push({
        id: `artifact.still.${shot.shotNumber}.${relative}`,
        ok,
        message: ok ? `Still ${relative} is present.` : `Missing still artifact ${relative} for shot ${shot.shotNumber}.`,
      });
    }
    if (shot.intent === 'motion-required') {
      for (const relative of shot.motionArtifacts ?? []) {
        const target = path.join(layout.artifactDir, relative);
        const exists = await pathIsNonemptyFile(target);
        const encoded = exists ? await looksLikeMp4(target) : false;
        checks.push({
          id: `artifact.motion.${shot.shotNumber}.${relative}`,
          ok: exists && encoded,
          message: encoded
            ? `Motion ${relative} looks like a valid MP4.`
            : `Missing or invalid motion artifact ${relative} for shot ${shot.shotNumber}.`,
        });
      }
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}
