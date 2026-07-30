/**
 * Versioned ForeScene Agent plan parser.
 * Pure engine code — independent of React and Zustand.
 * Builds a fresh normalized plan only when there are no errors.
 */

import type { CameraData, HumanPose, SceneObjectType, StagingRole, Transform, Workspace } from '../../domain/types';
import { HUMAN_POSE_PRESETS } from '../humanPosePresets';
import {
  AGENT_CREATABLE_OBJECT_TYPES,
  AGENT_EXECUTABLE_OPS,
  AGENT_PLAN_LIMITS,
  AGENT_PLAN_SCHEMA_VERSION,
  AGENT_STAGING_ROLES,
  AGENT_WORKSPACES,
  type AgentExecutableOp,
} from './constants';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  agentWarning,
  type AgentDiagnostic,
} from './diagnostics';
import type {
  AgentEntityTarget,
  ForeSceneAgentCommand,
  ForeSceneAgentPlan,
} from './protocol';

export interface AgentPlanParseResult {
  plan?: ForeSceneAgentPlan;
  errors: AgentDiagnostic[];
  warnings: AgentDiagnostic[];
}

const ALLOWED_TYPES = new Set<string>(AGENT_CREATABLE_OBJECT_TYPES);
const ALLOWED_ROLES = new Set<string>(AGENT_STAGING_ROLES);
const ALLOWED_WORKSPACES = new Set<string>(AGENT_WORKSPACES);
const ALLOWED_OPS = new Set<string>(AGENT_EXECUTABLE_OPS);
const ALLOWED_PRESETS = new Set(HUMAN_POSE_PRESETS.map((preset) => preset.id));

/** Accept architecture-doc alias for the neutral standing pose. */
const POSE_PRESET_ALIASES: Record<string, string> = {
  'standing-neutral': 'neutral',
};

export function parseForeSceneAgentPlan(input: unknown): AgentPlanParseResult {
  const errors: AgentDiagnostic[] = [];
  const warnings: AgentDiagnostic[] = [];

  const root = coerceJsonRoot(input, errors, warnings);
  if (!root) return { errors, warnings };

  if (root.version !== AGENT_PLAN_SCHEMA_VERSION) {
    errors.push(agentError(
      'schema_version',
      `version must be ${AGENT_PLAN_SCHEMA_VERSION}.`,
      { path: 'version' },
    ));
  }

  const planId = readOptionalString(root.planId, 'planId', errors, warnings);
  const description = readOptionalString(root.description, 'description', errors, warnings);
  if (description && description.length > AGENT_PLAN_LIMITS.maxDescriptionLength) {
    errors.push(agentError(
      'description_limit',
      `description exceeds ${AGENT_PLAN_LIMITS.maxDescriptionLength} characters.`,
      { path: 'description' },
    ));
  }

  let expectedRevision: number | undefined;
  if (root.expectedRevision !== undefined) {
    if (typeof root.expectedRevision !== 'number' || !Number.isFinite(root.expectedRevision)) {
      errors.push(agentError(
        'expected_revision',
        'expectedRevision must be a finite number when provided.',
        { path: 'expectedRevision' },
      ));
    } else {
      expectedRevision = root.expectedRevision;
      warnings.push(agentWarning(
        'expected_revision_unused',
        'expectedRevision is reserved; prefer expectedFingerprint for stale-project checks.',
        { path: 'expectedRevision' },
      ));
    }
  }

  const expectedFingerprint = readOptionalString(
    root.expectedFingerprint,
    'expectedFingerprint',
    errors,
    warnings,
  );

  if (!Array.isArray(root.commands)) {
    errors.push(agentError(
      'commands_missing',
      'commands must be an array.',
      { path: 'commands' },
    ));
  } else if (root.commands.length === 0) {
    errors.push(agentError(
      'commands_empty',
      'commands must contain at least one command.',
      { path: 'commands' },
    ));
  } else if (root.commands.length > AGENT_PLAN_LIMITS.maxCommands) {
    errors.push(agentError(
      'commands_limit',
      `commands exceeds the maximum of ${AGENT_PLAN_LIMITS.maxCommands}.`,
      { path: 'commands' },
    ));
  }

  const refNames = new Set<string>();
  const commands: ForeSceneAgentCommand[] = [];
  if (Array.isArray(root.commands)) {
    root.commands.forEach((raw, index) => {
      const parsed = parseCommand(raw, index, refNames, errors, warnings);
      if (parsed) commands.push(parsed);
    });
  }

  if (errors.length > 0) return { errors, warnings };
  if (root.version !== AGENT_PLAN_SCHEMA_VERSION || commands.length === 0) {
    return { errors, warnings };
  }

  const plan: ForeSceneAgentPlan = {
    version: AGENT_PLAN_SCHEMA_VERSION,
    commands,
  };
  if (planId !== undefined) plan.planId = planId;
  if (description !== undefined) plan.description = description;
  if (expectedRevision !== undefined) plan.expectedRevision = expectedRevision;
  if (expectedFingerprint !== undefined) {
    plan.expectedFingerprint = expectedFingerprint;
  }

  return { plan, errors, warnings };
}

function coerceJsonRoot(
  input: unknown,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): Record<string, unknown> | undefined {
  if (input === null || input === undefined) {
    errors.push(agentError('empty', 'Plan input is empty.', { path: '' }));
    return undefined;
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== 'string') {
    errors.push(agentError('type', 'Plan input must be an object or JSON string.', { path: '' }));
    return undefined;
  }

  let text = input.trim();
  if (!text) {
    errors.push(agentError('empty', 'Plan input is empty.', { path: '' }));
    return undefined;
  }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    warnings.push(agentWarning('markdown_fence', 'Stripped Markdown code fence from plan input.'));
    text = fence[1].trim();
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(agentError('type', 'Plan JSON root must be an object.', { path: '' }));
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    errors.push(agentError(
      'json',
      error instanceof Error ? `Invalid JSON: ${error.message}` : 'Invalid JSON.',
      { path: '' },
    ));
    return undefined;
  }
}

function parseCommand(
  raw: unknown,
  index: number,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const path = `commands[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError('command_type', 'Command must be an object.', { path }));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const op = record.op;
  if (typeof op !== 'string') {
    errors.push(agentError('op_missing', 'Command op must be a string.', { path: `${path}.op` }));
    return undefined;
  }
  if (!ALLOWED_OPS.has(op)) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.notImplemented,
      `Command op "${op}" is not supported by the plan compiler.`,
      { path: `${path}.op` },
    ));
    return undefined;
  }

  switch (op as AgentExecutableOp) {
    case 'project.updateInfo':
      return parseProjectUpdateInfo(record, path, errors, warnings);
    case 'object.create':
      return parseObjectCreate(record, path, refNames, errors, warnings);
    case 'object.update':
      return parseObjectUpdate(record, path, errors, warnings);
    case 'object.delete':
      return parseObjectDelete(record, path, errors, warnings);
    case 'object.duplicate':
      return parseObjectDuplicate(record, path, refNames, errors, warnings);
    case 'shot.create':
      return parseShotCreate(record, path, refNames, errors, warnings);
    case 'shot.updateCamera':
      return parseShotUpdateCamera(record, path, errors, warnings);
    case 'shot.stageObject':
      return parseShotStageObject(record, path, errors, warnings);
    case 'shot.clearStaging':
      return parseShotClearStaging(record, path, errors, warnings);
    case 'workspace.open':
      return parseWorkspaceOpen(record, path, errors);
    case 'selection.set':
      return parseSelectionSet(record, path, errors, warnings);
    default:
      errors.push(agentError(
        AGENT_DIAGNOSTIC_CODES.notImplemented,
        `Command op "${op}" is not supported.`,
        { path: `${path}.op` },
      ));
      return undefined;
  }
}

function parseProjectUpdateInfo(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const name = readOptionalString(record.name, `${path}.name`, errors, warnings);
  const description = readOptionalString(record.description, `${path}.description`, errors, warnings);
  if (name === undefined && description === undefined) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'project.updateInfo requires name and/or description.',
      { path },
    ));
    return undefined;
  }
  const command: ForeSceneAgentCommand = { op: 'project.updateInfo' };
  if (name !== undefined) command.name = name;
  if (description !== undefined) command.description = description;
  return command;
}

function parseObjectCreate(
  record: Record<string, unknown>,
  path: string,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const ref = readOptionalRef(record.ref, `${path}.ref`, refNames, errors);
  if (!record.object || typeof record.object !== 'object' || Array.isArray(record.object)) {
    errors.push(agentError('object_missing', 'object.create requires an object payload.', { path: `${path}.object` }));
    return undefined;
  }
  const objectRecord = record.object as Record<string, unknown>;
  const type = objectRecord.type;
  if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
    errors.push(agentError(
      'object_type',
      `object.type must be one of: ${AGENT_CREATABLE_OBJECT_TYPES.join(', ')}.`,
      { path: `${path}.object.type` },
    ));
    return undefined;
  }
  if (type === 'imported_model') {
    errors.push(agentError(
      'object_type_forbidden',
      'imported_model cannot be created through the Agent API.',
      { path: `${path}.object.type` },
    ));
    return undefined;
  }

  const name = readOptionalString(objectRecord.name, `${path}.object.name`, errors, warnings);
  const position = readOptionalVec3(objectRecord.position, `${path}.object.position`, errors, true);
  const rotation = readOptionalVec3(objectRecord.rotation, `${path}.object.rotation`, errors, false);
  const scale = readOptionalVec3(objectRecord.scale, `${path}.object.scale`, errors, false);
  if (scale) {
    for (let i = 0; i < 3; i += 1) {
      if (scale[i]! < AGENT_PLAN_LIMITS.minScale || scale[i]! > AGENT_PLAN_LIMITS.maxScale) {
        errors.push(agentError(
          'scale_range',
          `scale components must be between ${AGENT_PLAN_LIMITS.minScale} and ${AGENT_PLAN_LIMITS.maxScale}.`,
          { path: `${path}.object.scale` },
        ));
        break;
      }
    }
  }
  const dimensions = readOptionalVec3(objectRecord.dimensions, `${path}.object.dimensions`, errors, false);
  if (dimensions) {
    for (let i = 0; i < 3; i += 1) {
      if (
        dimensions[i]! < AGENT_PLAN_LIMITS.minDimensionMeters
        || dimensions[i]! > AGENT_PLAN_LIMITS.maxDimensionMeters
      ) {
        errors.push(agentError(
          'dimensions_range',
          `dimensions must be between ${AGENT_PLAN_LIMITS.minDimensionMeters} and ${AGENT_PLAN_LIMITS.maxDimensionMeters}.`,
          { path: `${path}.object.dimensions` },
        ));
        break;
      }
    }
  }
  let stagingRole: StagingRole | undefined;
  if (objectRecord.stagingRole !== undefined) {
    if (typeof objectRecord.stagingRole !== 'string' || !ALLOWED_ROLES.has(objectRecord.stagingRole)) {
      errors.push(agentError(
        'staging_role',
        `stagingRole must be one of: ${AGENT_STAGING_ROLES.join(', ')}.`,
        { path: `${path}.object.stagingRole` },
      ));
    } else {
      stagingRole = objectRecord.stagingRole as StagingRole;
    }
  }

  if (errors.some((item) => item.path?.startsWith(path))) {
    // Keep collecting other commands, but this command is invalid.
  }

  const command: ForeSceneAgentCommand = {
    op: 'object.create',
    object: {
      type: type as SceneObjectType,
    },
  };
  if (ref !== undefined) command.ref = ref;
  if (name !== undefined) command.object.name = name;
  if (position) command.object.position = position;
  if (rotation) command.object.rotation = rotation;
  if (scale) command.object.scale = scale;
  if (dimensions) command.object.dimensions = dimensions;
  if (stagingRole) command.object.stagingRole = stagingRole;
  return command;
}

function parseObjectUpdate(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const target = parseEntityTarget(record.object, `${path}.object`, errors);
  const updates = parseObjectUpdates(record.updates, `${path}.updates`, errors, warnings);
  if (!target || !updates) return undefined;
  return { op: 'object.update', object: target, updates };
}

function parseObjectDelete(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  _warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const target = parseEntityTarget(record.object, `${path}.object`, errors);
  if (!target) return undefined;
  return { op: 'object.delete', object: target };
}

function parseObjectDuplicate(
  record: Record<string, unknown>,
  path: string,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
  _warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const target = parseEntityTarget(record.object, `${path}.object`, errors);
  const ref = readOptionalRef(record.ref, `${path}.ref`, refNames, errors);
  if (!target) return undefined;
  const command: ForeSceneAgentCommand = { op: 'object.duplicate', object: target };
  if (ref !== undefined) command.ref = ref;
  return command;
}

function parseShotCreate(
  record: Record<string, unknown>,
  path: string,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const ref = readOptionalRef(record.ref, `${path}.ref`, refNames, errors);
  let shotPayload: {
    name?: string;
    description?: string;
    camera?: Partial<CameraData>;
  } = {};
  if (record.shot !== undefined) {
    if (!record.shot || typeof record.shot !== 'object' || Array.isArray(record.shot)) {
      errors.push(agentError('shot_type', 'shot must be an object when provided.', { path: `${path}.shot` }));
      return undefined;
    }
    const shotRecord = record.shot as Record<string, unknown>;
    const name = readOptionalString(shotRecord.name, `${path}.shot.name`, errors, warnings);
    const description = readOptionalString(shotRecord.description, `${path}.shot.description`, errors, warnings);
    const camera = parsePartialCamera(shotRecord.camera, `${path}.shot.camera`, errors);
    shotPayload = {};
    if (name !== undefined) shotPayload.name = name;
    if (description !== undefined) shotPayload.description = description;
    if (camera) shotPayload.camera = camera;
  }
  const command: ForeSceneAgentCommand = { op: 'shot.create', shot: shotPayload };
  if (ref !== undefined) command.ref = ref;
  return command;
}

function parseShotUpdateCamera(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  _warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const target = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const camera = parsePartialCamera(record.camera, `${path}.camera`, errors);
  if (!target || !camera || Object.keys(camera).length === 0) {
    if (target && (!camera || Object.keys(camera).length === 0)) {
      errors.push(agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'shot.updateCamera requires a camera payload.',
        { path: `${path}.camera` },
      ));
    }
    return undefined;
  }
  return { op: 'shot.updateCamera', shot: target, camera };
}

function parseShotStageObject(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const object = parseEntityTarget(record.object, `${path}.object`, errors);
  const transform = parseOptionalTransform(record.transform, `${path}.transform`, errors);
  let visible: boolean | undefined;
  if (record.visible !== undefined) {
    if (typeof record.visible !== 'boolean') {
      errors.push(agentError('visible_type', 'visible must be a boolean.', { path: `${path}.visible` }));
    } else {
      visible = record.visible;
    }
  }
  const humanPose = parseOptionalHumanPose(record.humanPose, `${path}.humanPose`, errors);
  let posePreset = readOptionalString(record.posePreset, `${path}.posePreset`, errors, warnings);
  if (posePreset) {
    const aliased = POSE_PRESET_ALIASES[posePreset];
    if (aliased) {
      warnings.push(agentWarning(
        'pose_preset_alias',
        `posePreset "${posePreset}" mapped to "${aliased}".`,
        { path: `${path}.posePreset` },
      ));
      posePreset = aliased;
    }
    if (!ALLOWED_PRESETS.has(posePreset)) {
      errors.push(agentError(
        'pose_preset',
        `Unknown posePreset "${posePreset}".`,
        { path: `${path}.posePreset` },
      ));
      posePreset = undefined;
    }
  }
  if (!shot || !object) return undefined;
  if (
    transform === undefined
    && visible === undefined
    && humanPose === undefined
    && posePreset === undefined
  ) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'shot.stageObject requires transform, visible, humanPose, and/or posePreset.',
      { path },
    ));
    return undefined;
  }
  const command: ForeSceneAgentCommand = { op: 'shot.stageObject', shot, object };
  if (transform) command.transform = transform;
  if (visible !== undefined) command.visible = visible;
  if (humanPose) command.humanPose = humanPose;
  if (posePreset) command.posePreset = posePreset;
  return command;
}

function parseShotClearStaging(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  _warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const object = record.object === undefined
    ? undefined
    : parseEntityTarget(record.object, `${path}.object`, errors);
  let clearPoseOnly: boolean | undefined;
  if (record.clearPoseOnly !== undefined) {
    if (typeof record.clearPoseOnly !== 'boolean') {
      errors.push(agentError(
        'clear_pose_only_type',
        'clearPoseOnly must be a boolean.',
        { path: `${path}.clearPoseOnly` },
      ));
    } else {
      clearPoseOnly = record.clearPoseOnly;
    }
  }
  if (!shot) return undefined;
  if (record.object !== undefined && !object) return undefined;
  const command: ForeSceneAgentCommand = { op: 'shot.clearStaging', shot };
  if (object) command.object = object;
  if (clearPoseOnly !== undefined) command.clearPoseOnly = clearPoseOnly;
  return command;
}

function parseWorkspaceOpen(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  if (typeof record.workspace !== 'string' || !ALLOWED_WORKSPACES.has(record.workspace)) {
    errors.push(agentError(
      'workspace',
      `workspace must be one of: ${AGENT_WORKSPACES.join(', ')}.`,
      { path: `${path}.workspace` },
    ));
    return undefined;
  }
  return { op: 'workspace.open', workspace: record.workspace as Workspace };
}

function parseSelectionSet(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  let objectIds: string[] | undefined;
  if (record.objectIds !== undefined) {
    if (!Array.isArray(record.objectIds)) {
      errors.push(agentError('object_ids_type', 'objectIds must be an array of strings.', { path: `${path}.objectIds` }));
    } else {
      objectIds = [];
      record.objectIds.forEach((value, index) => {
        if (typeof value !== 'string' || !value.trim()) {
          errors.push(agentError(
            'object_id_type',
            'objectIds entries must be nonempty strings.',
            { path: `${path}.objectIds[${index}]` },
          ));
        } else {
          objectIds!.push(value);
        }
      });
    }
  }
  let shotId: string | null | undefined;
  if (record.shotId !== undefined) {
    if (record.shotId === null) {
      shotId = null;
    } else if (typeof record.shotId === 'string' && record.shotId.trim()) {
      shotId = record.shotId;
    } else {
      errors.push(agentError(
        'shot_id_type',
        'shotId must be a string or null when provided.',
        { path: `${path}.shotId` },
      ));
    }
  }
  if (objectIds === undefined && shotId === undefined) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'selection.set requires objectIds and/or shotId.',
      { path },
    ));
    return undefined;
  }
  if (objectIds === undefined && shotId === undefined) {
    warnings.push(agentWarning('selection_empty', 'selection.set has no effect.', { path }));
  }
  const command: ForeSceneAgentCommand = { op: 'selection.set' };
  if (objectIds !== undefined) command.objectIds = objectIds;
  if (shotId !== undefined) command.shotId = shotId;
  return command;
}

function parseObjectUpdates(
  raw: unknown,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError('updates_missing', 'updates must be an object.', { path }));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  const allowed = new Set([
    'name',
    'visible',
    'locked',
    'stagingRole',
    'transform',
    'position',
    'rotation',
    'scale',
    'dimensions',
    'color',
    'secondaryColor',
  ]);

  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      warnings.push(agentWarning(
        'unknown_update_field',
        `Ignoring unsupported update field "${key}".`,
        { path: `${path}.${key}` },
      ));
      continue;
    }
  }

  if (record.name !== undefined) {
    const name = readOptionalString(record.name, `${path}.name`, errors, warnings);
    if (name !== undefined) updates.name = name;
  }
  if (record.visible !== undefined) {
    if (typeof record.visible !== 'boolean') {
      errors.push(agentError('visible_type', 'visible must be a boolean.', { path: `${path}.visible` }));
    } else {
      updates.visible = record.visible;
    }
  }
  if (record.locked !== undefined) {
    if (typeof record.locked !== 'boolean') {
      errors.push(agentError('locked_type', 'locked must be a boolean.', { path: `${path}.locked` }));
    } else {
      updates.locked = record.locked;
    }
  }
  if (record.stagingRole !== undefined) {
    if (typeof record.stagingRole !== 'string' || !ALLOWED_ROLES.has(record.stagingRole)) {
      errors.push(agentError(
        'staging_role',
        `stagingRole must be one of: ${AGENT_STAGING_ROLES.join(', ')}.`,
        { path: `${path}.stagingRole` },
      ));
    } else {
      updates.stagingRole = record.stagingRole;
    }
  }
  const transform = parseOptionalTransform(record.transform, `${path}.transform`, errors);
  if (transform) updates.transform = transform;
  const position = readOptionalVec3(record.position, `${path}.position`, errors, true);
  if (position) updates.position = position;
  const rotation = readOptionalVec3(record.rotation, `${path}.rotation`, errors, false);
  if (rotation) updates.rotation = rotation;
  const scale = readOptionalVec3(record.scale, `${path}.scale`, errors, false);
  if (scale) updates.scale = scale;
  const dimensions = readOptionalVec3(record.dimensions, `${path}.dimensions`, errors, false);
  if (dimensions) updates.dimensions = dimensions;
  if (record.color !== undefined) {
    const color = readOptionalString(record.color, `${path}.color`, errors, warnings);
    if (color !== undefined) updates.color = color;
  }
  if (record.secondaryColor !== undefined) {
    const secondaryColor = readOptionalString(record.secondaryColor, `${path}.secondaryColor`, errors, warnings);
    if (secondaryColor !== undefined) updates.secondaryColor = secondaryColor;
  }

  if (Object.keys(updates).length === 0) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'updates must include at least one supported field.',
      { path },
    ));
    return undefined;
  }
  return updates;
}

function parseEntityTarget(
  raw: unknown,
  path: string,
  errors: AgentDiagnostic[],
): AgentEntityTarget | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'Target must be an object with id, ref, or query.',
      { path },
    ));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const present = ['id', 'ref', 'query'].filter((key) => record[key] !== undefined);
  if (present.length !== 1) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'Target must include exactly one of id, ref, or query.',
      { path },
    ));
    return undefined;
  }
  if (typeof record.id === 'string' && record.id.trim()) {
    return { id: record.id };
  }
  if (typeof record.ref === 'string' && record.ref.trim()) {
    return { ref: record.ref };
  }
  if (record.query && typeof record.query === 'object' && !Array.isArray(record.query)) {
    const queryRecord = record.query as Record<string, unknown>;
    const query: {
      name?: string;
      type?: SceneObjectType;
      stagingRole?: StagingRole;
      match?: 'exact' | 'contains';
    } = {};
    if (queryRecord.name !== undefined) {
      if (typeof queryRecord.name !== 'string') {
        errors.push(agentError('query_name', 'query.name must be a string.', { path: `${path}.query.name` }));
      } else {
        query.name = queryRecord.name;
      }
    }
    if (queryRecord.type !== undefined) {
      if (typeof queryRecord.type !== 'string') {
        errors.push(agentError('query_type', 'query.type must be a string.', { path: `${path}.query.type` }));
      } else {
        query.type = queryRecord.type as SceneObjectType;
      }
    }
    if (queryRecord.stagingRole !== undefined) {
      if (typeof queryRecord.stagingRole !== 'string' || !ALLOWED_ROLES.has(queryRecord.stagingRole)) {
        errors.push(agentError(
          'query_staging_role',
          `query.stagingRole must be one of: ${AGENT_STAGING_ROLES.join(', ')}.`,
          { path: `${path}.query.stagingRole` },
        ));
      } else {
        query.stagingRole = queryRecord.stagingRole as StagingRole;
      }
    }
    if (queryRecord.match !== undefined) {
      if (queryRecord.match !== 'exact' && queryRecord.match !== 'contains') {
        errors.push(agentError(
          'query_match',
          'query.match must be "exact" or "contains".',
          { path: `${path}.query.match` },
        ));
      } else {
        query.match = queryRecord.match;
      }
    }
    if (!query.name && !query.type && !query.stagingRole) {
      errors.push(agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'query requires name, type, and/or stagingRole.',
        { path: `${path}.query` },
      ));
      return undefined;
    }
    return { query };
  }
  errors.push(agentError(
    AGENT_DIAGNOSTIC_CODES.invalidArgument,
    'Target id/ref must be a nonempty string.',
    { path },
  ));
  return undefined;
}

function parsePartialCamera(
  raw: unknown,
  path: string,
  errors: AgentDiagnostic[],
): Partial<CameraData> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError('camera_type', 'camera must be an object.', { path }));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const camera: Partial<CameraData> = {};
  const position = readOptionalVec3(record.position, `${path}.position`, errors, true);
  const target = readOptionalVec3(record.target, `${path}.target`, errors, true);
  if (position) camera.position = position;
  if (target) camera.target = target;
  if (record.fovDegrees !== undefined) {
    if (typeof record.fovDegrees !== 'number' || !Number.isFinite(record.fovDegrees) || record.fovDegrees <= 0 || record.fovDegrees >= 180) {
      errors.push(agentError(
        'fov',
        'fovDegrees must be a finite number between 0 and 180.',
        { path: `${path}.fovDegrees` },
      ));
    } else {
      camera.fovDegrees = record.fovDegrees;
    }
  }
  if (record.aspectRatio !== undefined) {
    if (typeof record.aspectRatio !== 'number' || !Number.isFinite(record.aspectRatio) || record.aspectRatio <= 0) {
      errors.push(agentError(
        'aspect_ratio',
        'aspectRatio must be a positive finite number.',
        { path: `${path}.aspectRatio` },
      ));
    } else {
      camera.aspectRatio = record.aspectRatio;
    }
  }
  if (record.near !== undefined) {
    if (typeof record.near !== 'number' || !Number.isFinite(record.near) || record.near <= 0) {
      errors.push(agentError('near', 'near must be a positive finite number.', { path: `${path}.near` }));
    } else {
      camera.near = record.near;
    }
  }
  if (record.far !== undefined) {
    if (typeof record.far !== 'number' || !Number.isFinite(record.far) || record.far <= 0) {
      errors.push(agentError('far', 'far must be a positive finite number.', { path: `${path}.far` }));
    } else {
      camera.far = record.far;
    }
  }
  return camera;
}

function parseOptionalTransform(
  raw: unknown,
  path: string,
  errors: AgentDiagnostic[],
): Transform | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError('transform_type', 'transform must be an object.', { path }));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const position = readOptionalVec3(record.position, `${path}.position`, errors, true);
  const rotation = readOptionalVec3(record.rotation, `${path}.rotation`, errors, false);
  const scale = readOptionalVec3(record.scale, `${path}.scale`, errors, false);
  if (!position || !rotation || !scale) {
    errors.push(agentError(
      'transform_incomplete',
      'transform requires position, rotation, and scale Vec3 values.',
      { path },
    ));
    return undefined;
  }
  return { position, rotation, scale };
}

function parseOptionalHumanPose(
  raw: unknown,
  path: string,
  errors: AgentDiagnostic[],
): HumanPose | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError('human_pose_type', 'humanPose must be an object.', { path }));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    errors.push(agentError('human_pose_version', 'humanPose.version must be 1.', { path: `${path}.version` }));
    return undefined;
  }
  if (!record.joints || typeof record.joints !== 'object' || Array.isArray(record.joints)) {
    errors.push(agentError('human_pose_joints', 'humanPose.joints must be an object.', { path: `${path}.joints` }));
    return undefined;
  }
  // Trust joint payload shape lightly; deeper joint validation belongs with pose engine milestones.
  const pose: HumanPose = {
    version: 1,
    joints: structuredClone(record.joints) as HumanPose['joints'],
  };
  if (typeof record.presetId === 'string') pose.presetId = record.presetId;
  return pose;
}

function readOptionalRef(
  value: unknown,
  path: string,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(agentError('ref_type', 'ref must be a nonempty string.', { path }));
    return undefined;
  }
  const ref = value.trim();
  if (ref.length > AGENT_PLAN_LIMITS.maxRefLength) {
    errors.push(agentError(
      'ref_limit',
      `ref exceeds ${AGENT_PLAN_LIMITS.maxRefLength} characters.`,
      { path },
    ));
    return undefined;
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(ref)) {
    errors.push(agentError(
      'ref_format',
      'ref must start with a letter and contain only letters, digits, _ or -.',
      { path },
    ));
    return undefined;
  }
  if (refNames.has(ref)) {
    errors.push(agentError('duplicate_ref', `Duplicate plan-local ref "${ref}".`, { path }));
    return undefined;
  }
  refNames.add(ref);
  return ref;
}

function readOptionalString(
  value: unknown,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    errors.push(agentError('string_type', `${path} must be a string when provided.`, { path }));
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    warnings.push(agentWarning('empty_string', `${path} was empty and was omitted.`, { path }));
    return undefined;
  }
  if (path.endsWith('.name') && trimmed.length > AGENT_PLAN_LIMITS.maxNameLength) {
    errors.push(agentError(
      'name_limit',
      `name exceeds ${AGENT_PLAN_LIMITS.maxNameLength} characters.`,
      { path },
    ));
    return undefined;
  }
  return trimmed;
}

function readOptionalVec3(
  value: unknown,
  path: string,
  errors: AgentDiagnostic[],
  requireInRange: boolean,
): [number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3) {
    errors.push(agentError('vec3_type', `${path} must be a [x,y,z] array.`, { path }));
    return undefined;
  }
  const nums = value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      errors.push(agentError(
        'vec3_finite',
        `${path}[${index}] must be a finite number.`,
        { path: `${path}[${index}]` },
      ));
      return undefined;
    }
    if (requireInRange && Math.abs(entry) > AGENT_PLAN_LIMITS.maxPositionMeters) {
      errors.push(agentError(
        'vec3_range',
        `${path}[${index}] exceeds ±${AGENT_PLAN_LIMITS.maxPositionMeters}m.`,
        { path: `${path}[${index}]` },
      ));
      return undefined;
    }
    return entry;
  });
  if (nums.some((entry) => entry === undefined)) return undefined;
  return [nums[0]!, nums[1]!, nums[2]!];
}
