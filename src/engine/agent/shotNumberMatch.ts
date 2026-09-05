/**
 * Shot-number matching shared by the engine target resolver and the Agent CLI.
 *
 * Kept as a leaf module (no store or browser imports) so Node-side CLI scripts
 * reuse the exact same normalization semantics as in-page API resolution.
 * One selector contract: exact shotNumber wins, then leading-zero-stripped
 * comparison, so "010", "10", and "0010" address the same shot.
 */

export interface ShotNumberCarrier {
  shotNumber: string;
}

export function normalizeShotNumber(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, '');
}

export function matchShotsByShotNumber<T extends ShotNumberCarrier>(
  shots: readonly T[],
  shotNumber: string,
): T[] {
  const exact = shots.filter((shot) => shot.shotNumber === shotNumber);
  if (exact.length > 0) return [...exact];
  const normalized = normalizeShotNumber(shotNumber);
  return shots.filter((shot) => normalizeShotNumber(shot.shotNumber) === normalized);
}
