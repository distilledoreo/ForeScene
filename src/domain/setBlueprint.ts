import type { Euler, StagingRole, Vec3 } from './types';

/** Blueprint schema version supported by the parser and compiler. */
export const SET_BLUEPRINT_SCHEMA_VERSION = 1 as const;

/**
 * Primitive types an AI may emit in a SetBlueprint.
 * Intentionally excludes `imported_model` — an LLM cannot manufacture mesh assets.
 */
export const SET_BLUEPRINT_OBJECT_TYPES = [
  'floor',
  'wall',
  'box',
  'arch',
  'doorway',
  'column',
  'stairs',
  'tree_blob',
  'terrain_mass',
  'background_card',
  'human_dummy',
  'sun_marker',
] as const;

export type SetBlueprintObjectType = (typeof SET_BLUEPRINT_OBJECT_TYPES)[number];

export const SET_BLUEPRINT_SURFACE_STYLES = ['default', 'solid', 'checkerboard'] as const;
export type SetBlueprintSurfaceStyle = (typeof SET_BLUEPRINT_SURFACE_STYLES)[number];

export const SET_BLUEPRINT_STAGING_ROLES = ['set', 'prop', 'person'] as const;

/** Hard limits enforced by the validator. */
export const SET_BLUEPRINT_LIMITS = {
  maxObjects: 250,
  maxLandmarks: 100,
  /** Absolute position magnitude per axis (meters). */
  maxPositionMeters: 500,
  minDimensionMeters: 0.01,
  maxDimensionMeters: 1000,
  /** Scale components outside this range produce warnings, not hard errors. */
  extremeScaleMin: 0.05,
  extremeScaleMax: 20,
} as const;

/**
 * AI-facing spatial blocking format — intentionally smaller than LocationProject.
 * Excludes native IDs, timestamps, shots, panorama refs, assets, workflow, and
 * product/schema versions that belong to the compiled ForeScene project.
 */
export interface SetBlueprint {
  schemaVersion: typeof SET_BLUEPRINT_SCHEMA_VERSION;
  name: string;
  description?: string;
  units: 'meters';
  panoOrigin?: Vec3;
  panoRotation?: Euler;
  objects: SetBlueprintObject[];
  landmarks?: SetBlueprintLandmark[];
  assumptions?: string[];
}

export interface SetBlueprintObject {
  key: string;
  name: string;
  type: SetBlueprintObjectType;
  position: Vec3;
  rotation?: Euler;
  scale?: Vec3;
  dimensions: Vec3;
  stagingRole?: StagingRole;
  surface?: {
    style: SetBlueprintSurfaceStyle;
    color?: string;
    secondaryColor?: string;
  };
}

export interface SetBlueprintLandmark {
  key: string;
  displayName: string;
  linkedObjectKey?: string;
  position?: Vec3;
  description?: string;
  tags?: string[];
  promptCritical?: boolean;
}

export interface BlueprintDiagnostic {
  code: string;
  message: string;
  /** Dot-path into the blueprint when known (e.g. `objects[2].dimensions`). */
  path?: string;
  /** Blueprint object or landmark key when known. */
  key?: string;
}

export interface SetBlueprintParseResult {
  blueprint?: SetBlueprint;
  errors: BlueprintDiagnostic[];
  warnings: BlueprintDiagnostic[];
}

/** Axis-aligned bounds in meters (min/max corners). */
export interface Box3Like {
  min: Vec3;
  max: Vec3;
}
