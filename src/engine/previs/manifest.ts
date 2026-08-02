/**
 * Previs Production Manifest V1 — semantic input for autonomous graybox previs.
 * Grok makes semantic decisions; ForeScene compiles geometry.
 */

import type { Vec3 } from '../../domain/types';

export const PREVIS_MANIFEST_VERSION = 1 as const;

export const PREVIS_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '2.39:1'] as const;
export type PrevisAspectRatio = (typeof PREVIS_ASPECT_RATIOS)[number];

export const PREVIS_LOCATION_TEMPLATES = [
  'empty_stage',
  'interior_room',
  'corridor',
  'ruins',
  'armory',
  'exterior_courtyard',
  'custom_blueprint',
] as const;
export type PrevisLocationTemplate = (typeof PREVIS_LOCATION_TEMPLATES)[number];

export const PREVIS_LOCATION_FEATURE_TYPES = [
  'wall',
  'doorway',
  'arch',
  'column',
  'stairs',
  'platform',
  'table',
  'crate',
  'background_card',
] as const;
export type PrevisLocationFeatureType = (typeof PREVIS_LOCATION_FEATURE_TYPES)[number];

export const PREVIS_PROP_PRIMITIVES = [
  'box',
  'sphere',
  'cylinder',
  'disc',
  'shield',
  'sword',
  'table',
  'custom_simple',
] as const;
export type PrevisPropPrimitive = (typeof PREVIS_PROP_PRIMITIVES)[number];

export const PREVIS_IMPORTED_CHARACTER_RIG_MODES = [
  'preserve-existing',
  'auto',
  'autorig',
] as const;
export type PrevisImportedCharacterRigMode = (typeof PREVIS_IMPORTED_CHARACTER_RIG_MODES)[number];

export const PREVIS_CAMERA_TEMPLATES = [
  'establishing',
  'wide',
  'full',
  'medium',
  'medium_close_up',
  'close_up',
  'extreme_close_up',
  'two_shot',
  'over_the_shoulder',
  'insert',
  'profile',
  'low_angle',
  'high_angle',
  'overhead',
] as const;
export type PrevisCameraTemplate = (typeof PREVIS_CAMERA_TEMPLATES)[number];

export const PREVIS_CAMERA_ANGLES = ['front', 'three_quarter', 'profile', 'rear'] as const;
export type PrevisCameraAngle = (typeof PREVIS_CAMERA_ANGLES)[number];

export const PREVIS_LENS_CLASSES = ['wide', 'normal', 'long'] as const;
export type PrevisLensClass = (typeof PREVIS_LENS_CLASSES)[number];

export const PREVIS_LOCATION_SLOTS = [
  'center',
  'left',
  'right',
  'foreground',
  'background',
  'entrance',
  'exit',
] as const;
export type PrevisLocationSlot = (typeof PREVIS_LOCATION_SLOTS)[number];

export const PREVIS_RELATIVE_RELATIONS = [
  'left_of',
  'right_of',
  'in_front_of',
  'behind',
  'beside',
  'across_from',
  'near',
  'far_from',
  'between',
  'just_inside',
  'just_outside',
] as const;
export type PrevisRelativeRelation = (typeof PREVIS_RELATIVE_RELATIONS)[number];

/** Hard limits for scene safety and CLI batching. */
export const PREVIS_MANIFEST_LIMITS = {
  maxLocations: 12,
  maxCast: 24,
  maxProps: 48,
  maxShots: 120,
  maxBlockingPerShot: 24,
  maxFeaturesPerLocation: 40,
  maxNameLength: 120,
  maxDescriptionLength: 4000,
  maxIdLength: 64,
  maxDimensionMeters: 100,
  minDimensionMeters: 0.05,
  maxHeightMeters: 3.5,
  minHeightMeters: 0.8,
  locationZoneSpacingMeters: 100,
  maxSceneExtentMeters: 1500,
} as const;

export interface PrevisProductionManifestV1 {
  version: typeof PREVIS_MANIFEST_VERSION;
  project: {
    name: string;
    description?: string;
    aspectRatio: PrevisAspectRatio;
    frameRate?: number;
  };
  locations: PrevisLocationDefinition[];
  cast: PrevisCharacterDefinition[];
  props?: PrevisPropDefinition[];
  shots: PrevisShotDefinition[];
}

export interface PrevisLocationDefinition {
  id: string;
  name: string;
  description?: string;
  template: PrevisLocationTemplate;
  dimensions?: {
    width?: number;
    depth?: number;
    height?: number;
  };
  features?: Array<{
    type: PrevisLocationFeatureType;
    name: string;
    placement?: string;
  }>;
}

export type PrevisCharacterDefinition =
  | PrevisHumanDummyCharacterDefinition
  | PrevisImportedCharacterDefinition;

export interface PrevisHumanDummyCharacterDefinition {
  id: string;
  name: string;
  type: 'human_dummy';
  height?: number;
  color?: string;
  defaultPose?: string;
}

export interface PrevisImportedCharacterDefinition {
  id: string;
  name: string;
  type: 'imported_character';
  /** Local GLB, embedded glTF, or FBX path, resolved relative to the manifest. */
  source: string;
  rigMode: PrevisImportedCharacterRigMode;
  height?: number;
  defaultPose?: string;
}

export interface PrevisPropDefinition {
  id: string;
  name: string;
  primitive: PrevisPropPrimitive;
  dimensions?: [number, number, number];
  color?: string;
}

export interface PrevisShotDefinition {
  id: string;
  shotNumber: string;
  name: string;
  description: string;
  locationId: string;
  subjects: string[];
  blocking?: PrevisBlockingInstruction[];
  camera: {
    template: PrevisCameraTemplate;
    subjects: string[];
    foregroundSubject?: string;
    angle?: PrevisCameraAngle;
    lensClass?: PrevisLensClass;
  };
  requirements?: {
    visibleSubjects?: string[];
    visibleProps?: string[];
    notes?: string[];
  };
  /** Optional temporal authoring compiled through the public Agent timeline API. */
  motion?: PrevisShotMotion;
}

export interface PrevisShotMotion {
  durationSeconds: number;
  renderControlVideo?: boolean;
  keyframes: PrevisShotMotionKeyframe[];
}

export interface PrevisShotMotionKeyframe {
  timeSeconds: number;
  camera?: {
    position?: Vec3;
    target?: Vec3;
    fovDegrees?: number;
  };
  staging?: Array<{
    subject: string;
    visible?: boolean;
    transform?: {
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
    };
    posePreset?: string;
  }>;
}

export type PrevisBlockingPlacement =
  | {
      type: 'location_slot';
      slot: PrevisLocationSlot;
    }
  | {
      type: 'relative';
      anchor: string;
      relation: PrevisRelativeRelation;
      /** Optional secondary anchor for `between`. */
      secondaryAnchor?: string;
    };

export interface PrevisBlockingInstruction {
  subject: string;
  placement: PrevisBlockingPlacement;
  face?: string;
  pose?: string;
}

/** Numeric aspect ratio derived from the manifest token. */
export function aspectRatioValue(aspect: PrevisAspectRatio): number {
  switch (aspect) {
    case '16:9':
      return 16 / 9;
    case '9:16':
      return 9 / 16;
    case '1:1':
      return 1;
    case '2.39:1':
      return 2.39;
    default:
      return 16 / 9;
  }
}
