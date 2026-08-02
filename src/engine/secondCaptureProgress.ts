/** Lightweight progress copy and timing helpers for the second-capture planner UI. */

/** Typical wall-clock for coverage on mid-size scenes; used before real progress arrives. */
export const SUGGESTED_CAPTURE_ANALYSIS_ETA_SECONDS = 35;
/** Typical projected equirect bake time after origin is set. */
export const SUGGESTED_CAPTURE_RENDER_ETA_SECONDS = 12;

export function estimateRemainingSeconds(params: {
  elapsedMs: number;
  progress: number;
  phaseDefaultSeconds: number;
}): number {
  const { elapsedMs, progress, phaseDefaultSeconds } = params;
  if (progress >= 0.97) return 0;
  if (progress > 0.06) {
    const totalMs = elapsedMs / progress;
    return Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
  }
  const remaining = phaseDefaultSeconds - elapsedMs / 1000;
  return Math.max(1, Math.ceil(remaining));
}

export function formatDurationSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `~${s}s`;
  const minutes = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `~${minutes}m` : `~${minutes}m ${rem}s`;
}
