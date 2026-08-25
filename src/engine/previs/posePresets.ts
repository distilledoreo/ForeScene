/**
 * Pose preset aliases for autonomous previs.
 * Maps semantic MVP names onto ForeScene human pose presets.
 */

import {
  applyHumanPosePreset,
  getHumanPosePreset,
  HUMAN_POSE_PRESETS,
} from '../humanPosePresets';
import type { HumanPose } from '../../domain/types';

/** Semantic MVP pose ids accepted in production manifests. */
export const PREVIS_POSE_PRESETS = [
  'standing-neutral',
  'standing-alert',
  'standing-defensive',
  'walking',
  'running',
  'kneeling',
  'seated',
  'reaching',
  'holding-object',
  'shield-ready',
  'sword-ready',
  'injured',
] as const;

export type PrevisPosePreset = (typeof PREVIS_POSE_PRESETS)[number];

/**
 * Map semantic previs pose names → existing ForeScene preset ids.
 * Approximate silhouettes are enough for graybox first frames.
 */
export const PREVIS_POSE_ALIASES: Record<string, string> = {
  'standing-neutral': 'neutral',
  'standing-alert': 'standing-relaxed',
  'standing-defensive': 'elbows-bent',
  walking: 'walking',
  running: 'walk-contact-left',
  kneeling: 'crouching',
  seated: 'sitting',
  reaching: 'reaching-right',
  'holding-object': 'holding-waist',
  'shield-ready': 'elbows-bent',
  'sword-ready': 'pointing',
  injured: 'crouching',
  // Passthrough of native preset ids.
  ...Object.fromEntries(HUMAN_POSE_PRESETS.map((preset) => [preset.id, preset.id])),
};

/**
 * Semantic names whose native mapping preserves the complete authored intent.
 * More expressive aliases (running, defensive, holding, and so on) remain
 * approximate and require an explicit production substitution approval.
 */
export const EXACT_PREVIS_POSE_ALIASES = new Set([
  'standing-neutral',
  'standing-alert',
]);

export function isExactPrevisPoseAlias(pose: string): boolean {
  return EXACT_PREVIS_POSE_ALIASES.has(pose);
}

export function isSupportedPrevisPosePreset(pose: string): boolean {
  return Boolean(PREVIS_POSE_ALIASES[pose] || getHumanPosePreset(pose));
}

export function resolvePrevisPosePresetId(pose: string): string | undefined {
  if (PREVIS_POSE_ALIASES[pose]) return PREVIS_POSE_ALIASES[pose];
  if (getHumanPosePreset(pose)) return pose;
  return undefined;
}

export function applyPrevisPosePreset(pose: string): HumanPose | undefined {
  const resolved = resolvePrevisPosePresetId(pose);
  if (!resolved) return undefined;
  return applyHumanPosePreset(resolved);
}
