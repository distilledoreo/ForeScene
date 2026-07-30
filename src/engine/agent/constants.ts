/**
 * Agent plan limits and shared constants.
 * Hand-written validation — no schema library (matches SetBlueprint style).
 */

export const AGENT_PLAN_SCHEMA_VERSION = 1 as const;

export const AGENT_PLAN_LIMITS = {
  maxCommands: 200,
  maxRefLength: 64,
  maxNameLength: 120,
  maxDescriptionLength: 4000,
  maxPositionMeters: 500,
  minDimensionMeters: 0.01,
  maxDimensionMeters: 1000,
  minScale: 0.001,
  maxScale: 1000,
} as const;

/** Primitive types an agent may create. Excludes imported_model (needs assets). */
export const AGENT_CREATABLE_OBJECT_TYPES = [
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

export type AgentCreatableObjectType = (typeof AGENT_CREATABLE_OBJECT_TYPES)[number];

export const AGENT_STAGING_ROLES = ['set', 'prop', 'person'] as const;

export const AGENT_WORKSPACES = ['build', 'reference', 'shots', 'export'] as const;

/** Commands executable by the pure plan compiler in this milestone. */
export const AGENT_EXECUTABLE_OPS = [
  'project.updateInfo',
  'object.create',
  'object.update',
  'object.delete',
  'object.duplicate',
  'shot.create',
  'shot.updateCamera',
  'shot.stageObject',
  'shot.clearStaging',
  'workspace.open',
  'selection.set',
] as const;

export type AgentExecutableOp = (typeof AGENT_EXECUTABLE_OPS)[number];

/**
 * Types that rest upright on the floor when an agent supplies a floor-contact position.
 * Matches SetBlueprint compiler conventions.
 */
export const AGENT_UPRIGHT_OBJECT_TYPES = new Set<string>([
  'wall',
  'arch',
  'doorway',
  'column',
  'stairs',
  'background_card',
  'human_dummy',
  'tree_blob',
]);
