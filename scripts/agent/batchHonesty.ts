/**
 * Honest aggregate results for batch CLI commands.
 *
 * "Six frames rendered" must never mean five rendered and one stayed stale.
 * These pure helpers decide batch `ok` as a conjunction and produce per-shot
 * reports; the runners inject the filesystem so the decision is unit-testable.
 */

import { createHash } from 'node:crypto';
import type { PrevisShotRunState } from '../../src/engine/previs/runState';

export interface ContactSheetFrameEntry {
  shotNumber: string;
  framePath: string;
  /** Run-state render status; absent when entries came from a directory listing. */
  renderStatus?: string;
}

export interface ContactSheetFrameIssue {
  shotNumber: string;
  kind: 'missing' | 'empty' | 'not_rendered';
  message: string;
}

export interface ContactSheetFrameReport {
  ok: boolean;
  /** Per-shot frame facts for the result envelope. */
  frames: Array<{
    shotNumber: string;
    framePath: string;
    exists: boolean;
    byteLength?: number;
    sha256?: string;
    renderStatus?: string;
  }>;
  issues: ContactSheetFrameIssue[];
}

/**
 * Fail-closed contact-sheet input contract: every entry must have an existing,
 * non-empty PNG, and every run-state-backed entry must have finished rendering.
 */
export async function evaluateContactSheetFrames(params: {
  entries: readonly ContactSheetFrameEntry[];
  pathExists: (filePath: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<Buffer>;
}): Promise<ContactSheetFrameReport> {
  const frames: ContactSheetFrameReport['frames'] = [];
  const issues: ContactSheetFrameIssue[] = [];
  for (const entry of params.entries) {
    const exists = await params.pathExists(entry.framePath);
    let byteLength: number | undefined;
    let sha256: string | undefined;
    if (exists) {
      const bytes = await params.readFile(entry.framePath);
      byteLength = bytes.byteLength;
      sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    }
    frames.push({
      shotNumber: entry.shotNumber,
      framePath: entry.framePath,
      exists,
      ...(byteLength !== undefined ? { byteLength } : {}),
      ...(sha256 !== undefined ? { sha256 } : {}),
      ...(entry.renderStatus !== undefined ? { renderStatus: entry.renderStatus } : {}),
    });
    if (!exists) {
      issues.push({
        shotNumber: entry.shotNumber,
        kind: 'missing',
        message: `Frame file is missing: ${entry.framePath}`,
      });
      continue;
    }
    if (byteLength === 0) {
      issues.push({
        shotNumber: entry.shotNumber,
        kind: 'empty',
        message: `Frame file is empty: ${entry.framePath}`,
      });
      continue;
    }
    if (entry.renderStatus !== undefined && entry.renderStatus !== 'complete') {
      issues.push({
        shotNumber: entry.shotNumber,
        kind: 'not_rendered',
        message: `Run state reports render "${entry.renderStatus}" for shot ${entry.shotNumber}; the frame is not current.`,
      });
    }
  }
  return { ok: issues.length === 0, frames, issues };
}

export interface RenderStillsOutcome {
  /** Conjunction: false when any tracked shot failed or is still unrendered. */
  ok: boolean;
  shotsConsidered: number;
  rendered: number;
  failedShotNumbers: string[];
  pendingShotNumbers: string[];
}

/**
 * Derive render-stills success from run state. Shots whose compile failed are
 * pending (never silently skipped): a batch claiming ok:true must have a
 * current frame for every shot previs tracked.
 */
export function deriveRenderStillsOutcome(
  shots: Readonly<Record<string, Pick<PrevisShotRunState, 'compile' | 'render'>>>,
): RenderStillsOutcome {
  const failedShotNumbers: string[] = [];
  const pendingShotNumbers: string[] = [];
  let rendered = 0;
  let shotsConsidered = 0;
  for (const [shotNumber, shot] of Object.entries(shots)) {
    shotsConsidered += 1;
    if (shot.render === 'complete') {
      rendered += 1;
      continue;
    }
    if (shot.render === 'failed') {
      failedShotNumbers.push(shotNumber);
      continue;
    }
    pendingShotNumbers.push(shotNumber);
  }
  return {
    ok: failedShotNumbers.length === 0 && pendingShotNumbers.length === 0,
    shotsConsidered,
    rendered,
    failedShotNumbers,
    pendingShotNumbers,
  };
}
