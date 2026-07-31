/**
 * Framing ranges and FOV helpers for semantic camera templates.
 * Configurable — not hard-coded throughout solvers.
 */

import type { PrevisCameraTemplate, PrevisLensClass } from './manifest';
import { focalLengthToVerticalFov } from '../focalLength';

/** Approximate vertical subject coverage of the frame (fraction of frame height). */
export interface FramingCoverageRange {
  min: number;
  max: number;
  /** Preferred mid target. */
  target: number;
}

export const FRAMING_COVERAGE: Record<PrevisCameraTemplate, FramingCoverageRange> = {
  establishing: { min: 0.10, max: 0.30, target: 0.20 },
  wide: { min: 0.30, max: 0.55, target: 0.42 },
  full: { min: 0.65, max: 0.90, target: 0.78 },
  medium: { min: 0.45, max: 0.70, target: 0.58 },
  medium_close_up: { min: 0.55, max: 0.80, target: 0.68 },
  close_up: { min: 0.70, max: 0.95, target: 0.82 },
  extreme_close_up: { min: 0.90, max: 1.20, target: 1.00 },
  two_shot: { min: 0.45, max: 0.75, target: 0.60 },
  over_the_shoulder: { min: 0.45, max: 0.75, target: 0.60 },
  insert: { min: 0.70, max: 1.10, target: 0.90 },
  profile: { min: 0.50, max: 0.80, target: 0.65 },
  low_angle: { min: 0.50, max: 0.85, target: 0.68 },
  high_angle: { min: 0.45, max: 0.80, target: 0.62 },
  overhead: { min: 0.40, max: 0.80, target: 0.55 },
};

/** Full-frame equivalent focal lengths by lens class. */
export const LENS_CLASS_FOCAL_MM: Record<PrevisLensClass, number> = {
  wide: 24,
  normal: 35,
  long: 85,
};

export function defaultLensClassForTemplate(template: PrevisCameraTemplate): PrevisLensClass {
  switch (template) {
    case 'establishing':
    case 'wide':
    case 'overhead':
      return 'wide';
    case 'close_up':
    case 'extreme_close_up':
    case 'insert':
      return 'long';
    default:
      return 'normal';
  }
}

export function verticalFovForLens(
  lensClass: PrevisLensClass,
  aspectRatio: number,
): number {
  return focalLengthToVerticalFov(LENS_CLASS_FOCAL_MM[lensClass], aspectRatio);
}

/**
 * Aim height relative to subject bounds depending on shot size.
 * 0 = feet, 1 = head top.
 */
export function aimHeightFraction(template: PrevisCameraTemplate): number {
  switch (template) {
    case 'establishing':
    case 'wide':
    case 'full':
    case 'two_shot':
    case 'overhead':
      return 0.55;
    case 'medium':
    case 'low_angle':
    case 'high_angle':
    case 'profile':
    case 'over_the_shoulder':
      return 0.72;
    case 'medium_close_up':
      return 0.82;
    case 'close_up':
    case 'extreme_close_up':
      return 0.90;
    case 'insert':
      return 0.50;
    default:
      return 0.65;
  }
}

export function scoreCoverage(
  measured: number,
  range: FramingCoverageRange,
): number {
  if (!Number.isFinite(measured) || measured <= 0) return -1000;
  if (measured >= range.min && measured <= range.max) {
    return 100 - Math.abs(measured - range.target) * 80;
  }
  if (measured < range.min) {
    return 40 - (range.min - measured) * 120;
  }
  return 40 - (measured - range.max) * 100;
}
