/**
 * Landmark-based crop profiles for camera solve and composition validation.
 * Distance is solved against the selected crop segment, not total human height.
 */

import type { PrevisCameraTemplate } from './manifest';

export type HumanLandmark =
  | 'feet'
  | 'knees'
  | 'waist'
  | 'chest'
  | 'shoulders'
  | 'chin'
  | 'eyes'
  | 'headTop';

/** Normalized height fractions from feet (0) to head top (1). */
export const HUMAN_LANDMARK_HEIGHT: Record<HumanLandmark, number> = {
  feet: 0.0,
  knees: 0.28,
  waist: 0.55,
  chest: 0.70,
  shoulders: 0.82,
  chin: 0.88,
  eyes: 0.94,
  headTop: 1.0,
};

export interface FramingProfile {
  topLandmark: HumanLandmark;
  bottomLandmark: HumanLandmark;
  /** Desired NDC/screen Y of top landmark (0 = top of frame, 1 = bottom). */
  targetScreenTop: number;
  /** Desired screen Y of bottom landmark. */
  targetScreenBottom: number;
  preferredHeadroom: number;
}

export const HUMAN_FRAMING_PROFILES: Record<string, FramingProfile> = {
  full: {
    topLandmark: 'headTop',
    bottomLandmark: 'feet',
    targetScreenTop: 0.08,
    targetScreenBottom: 0.95,
    preferredHeadroom: 0.08,
  },
  medium: {
    topLandmark: 'headTop',
    bottomLandmark: 'waist',
    targetScreenTop: 0.10,
    targetScreenBottom: 0.92,
    preferredHeadroom: 0.10,
  },
  medium_close_up: {
    topLandmark: 'headTop',
    bottomLandmark: 'chest',
    targetScreenTop: 0.10,
    targetScreenBottom: 0.92,
    preferredHeadroom: 0.10,
  },
  close_up: {
    topLandmark: 'headTop',
    bottomLandmark: 'shoulders',
    targetScreenTop: 0.10,
    targetScreenBottom: 0.90,
    preferredHeadroom: 0.10,
  },
  extreme_close_up: {
    topLandmark: 'headTop',
    bottomLandmark: 'chin',
    targetScreenTop: 0.12,
    targetScreenBottom: 0.88,
    preferredHeadroom: 0.12,
  },
  two_shot: {
    topLandmark: 'headTop',
    bottomLandmark: 'feet',
    targetScreenTop: 0.08,
    targetScreenBottom: 0.95,
    preferredHeadroom: 0.08,
  },
  over_the_shoulder: {
    topLandmark: 'headTop',
    bottomLandmark: 'waist',
    targetScreenTop: 0.10,
    targetScreenBottom: 0.90,
    preferredHeadroom: 0.10,
  },
  wide: {
    topLandmark: 'headTop',
    bottomLandmark: 'feet',
    targetScreenTop: 0.12,
    targetScreenBottom: 0.88,
    preferredHeadroom: 0.12,
  },
  establishing: {
    topLandmark: 'headTop',
    bottomLandmark: 'feet',
    targetScreenTop: 0.20,
    targetScreenBottom: 0.80,
    preferredHeadroom: 0.20,
  },
  insert: {
    topLandmark: 'headTop',
    bottomLandmark: 'feet',
    targetScreenTop: 0.15,
    targetScreenBottom: 0.85,
    preferredHeadroom: 0.15,
  },
  profile: {
    topLandmark: 'headTop',
    bottomLandmark: 'waist',
    targetScreenTop: 0.10,
    targetScreenBottom: 0.92,
    preferredHeadroom: 0.10,
  },
  low_angle: {
    topLandmark: 'headTop',
    bottomLandmark: 'waist',
    targetScreenTop: 0.08,
    targetScreenBottom: 0.95,
    preferredHeadroom: 0.08,
  },
  high_angle: {
    topLandmark: 'headTop',
    bottomLandmark: 'feet',
    targetScreenTop: 0.12,
    targetScreenBottom: 0.90,
    preferredHeadroom: 0.12,
  },
  overhead: {
    topLandmark: 'headTop',
    bottomLandmark: 'feet',
    targetScreenTop: 0.15,
    targetScreenBottom: 0.85,
    preferredHeadroom: 0.15,
  },
};

export function framingProfileForTemplate(template: PrevisCameraTemplate): FramingProfile {
  return HUMAN_FRAMING_PROFILES[template] ?? HUMAN_FRAMING_PROFILES.medium!;
}

/** Vertical span of the crop segment as a fraction of full body height. */
export function cropHeightFraction(profile: FramingProfile): number {
  const top = HUMAN_LANDMARK_HEIGHT[profile.topLandmark];
  const bottom = HUMAN_LANDMARK_HEIGHT[profile.bottomLandmark];
  return Math.max(0.08, top - bottom);
}

/** World Y for a landmark given floor-contact position and body height. */
export function landmarkWorldY(
  floorY: number,
  bodyHeight: number,
  landmark: HumanLandmark,
): number {
  return floorY + bodyHeight * HUMAN_LANDMARK_HEIGHT[landmark];
}

/**
 * Template-specific screen-space validation bands (Y: 0 = top, 1 = bottom).
 * Used by the strict composition validator.
 */
export interface TemplateFramingBands {
  headTopY?: [number, number];
  shoulderY?: [number, number];
  chestY?: [number, number];
  waistY?: [number, number];
  /** When set, feet should be outside frame or near/below bottom. */
  feetOutside?: boolean;
  kneesOutside?: boolean;
  waistOutside?: boolean;
  /** Primary subject min height coverage of frame. */
  minHeightCoverage?: number;
  maxHeightCoverage?: number;
  /** Secondary max area relative to primary (unless declared foreground). */
  maxSecondaryAreaRatio?: number;
}

export function templateFramingBands(template: PrevisCameraTemplate): TemplateFramingBands {
  switch (template) {
    case 'medium':
      return {
        headTopY: [0.05, 0.25],
        waistY: [0.75, 1.05],
        feetOutside: true,
        minHeightCoverage: 0.40,
        maxHeightCoverage: 0.85,
        maxSecondaryAreaRatio: 0.35,
      };
    case 'medium_close_up':
      return {
        headTopY: [0.05, 0.22],
        chestY: [0.75, 1.05],
        feetOutside: true,
        kneesOutside: true,
        minHeightCoverage: 0.45,
        maxHeightCoverage: 0.90,
        maxSecondaryAreaRatio: 0.35,
      };
    case 'close_up':
    case 'extreme_close_up':
      return {
        headTopY: [0.05, 0.18],
        shoulderY: [0.75, 1.05],
        feetOutside: true,
        kneesOutside: true,
        waistOutside: true,
        minHeightCoverage: 0.55,
        maxHeightCoverage: 1.15,
        maxSecondaryAreaRatio: 0.30,
      };
    case 'two_shot':
      return {
        headTopY: [0.04, 0.28],
        minHeightCoverage: 0.30,
        maxHeightCoverage: 0.90,
      };
    case 'over_the_shoulder':
      // OTS primary size uses head-to-waist / upper-body metrics, not full-body AABB.
      return {
        headTopY: [0.08, 0.24],
        // min/max heightCoverage intentionally unused for OTS full-body AABB.
      };
    case 'wide':
    case 'full':
      return {
        headTopY: [0.04, 0.30],
        minHeightCoverage: 0.25,
        maxHeightCoverage: 0.95,
      };
    case 'insert':
      return {
        minHeightCoverage: 0.45,
        maxHeightCoverage: 1.20,
      };
    default:
      return {
        headTopY: [0.04, 0.30],
        minHeightCoverage: 0.20,
        maxHeightCoverage: 1.0,
      };
  }
}
