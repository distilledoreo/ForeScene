import { Shot } from './types';

/** Trim and drop whitespace-only production IDs for backward-compatible loading. */
export function normalizeProductionShotId(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Primary label: production ID when set, otherwise the ForeScene sequence label. */
export function getShotPrimaryLabel(shot: Shot): string {
  return shot.productionShotId ?? `Shot ${shot.shotNumber}`;
}

export function getDefaultShotTitle(shot: Shot): string {
  return `Camera ${shot.shotNumber}`;
}

function isDefaultGeneratedShotTitle(shot: Shot, title: string): boolean {
  const trimmed = title.trim();
  return trimmed === getDefaultShotTitle(shot) || trimmed === `Shot ${shot.shotNumber}`;
}

/** True when the shot has a user-authored title beyond the generated default. */
export function hasCustomShotTitle(shot: Shot): boolean {
  const title = shot.name.trim();
  return title.length > 0 && !isDefaultGeneratedShotTitle(shot, title);
}

/** Human-facing shot label: `42A · Courtyard entrance`, or just `42A` until a custom title exists. */
export function getShotDisplayName(shot: Shot): string {
  const primary = getShotPrimaryLabel(shot);
  if (!hasCustomShotTitle(shot)) return primary;
  return `${primary} · ${shot.name.trim()}`;
}

/** Normalize a user-edited title; empty input reverts to the default camera label. */
export function normalizeShotTitle(shot: Shot, value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : getDefaultShotTitle(shot);
}
