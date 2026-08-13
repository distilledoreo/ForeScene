/**
 * Versioned ForeScene Agent plan parser.
 * Pure engine code — independent of React and Zustand.
 * Builds a fresh normalized plan only when there are no errors.
 */

import type { CameraData, ExportSettingsOverride, HumanPose, SceneObjectType, StagingRole, Transform, Workspace } from '../../domain/types';
import {
  CHARACTER_PASS_OVERRIDE_KEYS,
  DEPTH_OVERRIDE_KEYS,
  EXPORT_SETTING_TOP_LEVEL_KEYS,
  type ExportSettingFieldPath,
} from '../exportConfiguration';
import { HUMAN_POSE_PRESET_ALIASES, HUMAN_POSE_PRESETS } from '../humanPosePresets';
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
  AgentKeyframeTarget,
  AgentTimelineObjectInput,
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
const POSE_PRESET_ALIASES = HUMAN_POSE_PRESET_ALIASES;

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
    case 'shot.rename':
      return parseShotRename(record, path, errors, warnings);
    case 'shot.updateDescription':
      return parseShotUpdateDescription(record, path, errors, warnings);
    case 'shot.updateCamera':
      return parseShotUpdateCamera(record, path, errors, warnings);
    case 'shot.setPanorama':
      return parseShotSetPanorama(record, path, errors);
    case 'shot.select':
      return parseShotSelect(record, path, errors);
    case 'shot.copyStagingToNext':
      return parseShotCopyStagingToNext(record, path, errors);
    case 'shot.stageObject':
      return parseShotStageObject(record, path, errors, warnings);
    case 'shot.clearStaging':
      return parseShotClearStaging(record, path, errors, warnings);
    case 'shot.delete':
      return parseShotDelete(record, path, errors);
    case 'shot.timeline.replace':
      return parseShotTimelineReplace(record, path, refNames, errors, warnings);
    case 'shot.timeline.clear':
      return parseShotTimelineClear(record, path, errors);
    case 'shot.timeline.setDuration':
      return parseShotTimelineSetDuration(record, path, errors);
    case 'shot.keyframe.create':
      return parseShotKeyframeCreate(record, path, refNames, errors, warnings);
    case 'shot.keyframe.update':
      return parseShotKeyframeUpdate(record, path, errors, warnings);
    case 'shot.keyframe.delete':
      return parseShotKeyframeDelete(record, path, errors);
    case 'shot.keyframe.stageObject':
      return parseShotKeyframeStageObject(record, path, errors, warnings);
    case 'shot.keyframe.clearStaging':
      return parseShotKeyframeClearStaging(record, path, errors);
    case 'landmark.create':
      return parseLandmarkCreate(record, path, refNames, errors, warnings);
    case 'landmark.update':
      return parseLandmarkUpdate(record, path, errors, warnings);
    case 'landmark.delete':
      return parseLandmarkDelete(record, path, errors);
    case 'landmark.linkObject':
      return parseLandmarkLinkObject(record, path, errors);
    case 'export.sceneDefaults.patch':
      return parseExportSceneDefaultsPatch(record, path, errors, warnings);
    case 'export.shotOverrides.patch':
      return parseExportShotOverridesPatch(record, path, errors, warnings);
    case 'export.shotOverrides.reset':
      return parseExportShotOverridesReset(record, path, errors, warnings);
    case 'export.shotOverrides.copy':
      return parseExportShotOverridesCopy(record, path, errors);
    case 'export.shotOverrides.promote':
      return parseExportShotOverridesPromote(record, path, errors);
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
    shotNumber?: string;
    productionShotId?: string;
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
    const shotNumber = readOptionalString(shotRecord.shotNumber, `${path}.shot.shotNumber`, errors, warnings);
    const productionShotId = readOptionalString(
      shotRecord.productionShotId,
      `${path}.shot.productionShotId`,
      errors,
      warnings,
    );
    const camera = parsePartialCamera(shotRecord.camera, `${path}.shot.camera`, errors);
    shotPayload = {};
    if (name !== undefined) shotPayload.name = name;
    if (description !== undefined) shotPayload.description = description;
    if (shotNumber !== undefined) shotPayload.shotNumber = shotNumber;
    if (productionShotId !== undefined) shotPayload.productionShotId = productionShotId;
    if (camera) shotPayload.camera = camera;
  }
  const command: ForeSceneAgentCommand = { op: 'shot.create', shot: shotPayload };
  if (ref !== undefined) command.ref = ref;
  return command;
}

function parseShotRename(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const name = readOptionalString(record.name, `${path}.name`, errors, warnings);
  if (!shot || name === undefined) {
    if (shot && name === undefined) {
      errors.push(agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'shot.rename requires a nonempty name.',
        { path: `${path}.name` },
      ));
    }
    return undefined;
  }
  return { op: 'shot.rename', shot, name };
}

function parseShotUpdateDescription(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  if (record.description === undefined) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'shot.updateDescription requires description.',
      { path: `${path}.description` },
    ));
    return undefined;
  }
  if (typeof record.description !== 'string') {
    errors.push(agentError(
      'description_type',
      'description must be a string.',
      { path: `${path}.description` },
    ));
    return undefined;
  }
  if (record.description.length > AGENT_PLAN_LIMITS.maxDescriptionLength) {
    errors.push(agentError(
      'description_limit',
      `description exceeds ${AGENT_PLAN_LIMITS.maxDescriptionLength} characters.`,
      { path: `${path}.description` },
    ));
    return undefined;
  }
  if (!shot) return undefined;
  // Allow empty string to clear description.
  void warnings;
  return { op: 'shot.updateDescription', shot, description: record.description };
}

function parseShotSelect(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  if (!shot) return undefined;
  return { op: 'shot.select', shot };
}

function parseShotSetPanorama(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  if (record.pano === undefined) {
    errors.push(agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'shot.setPanorama requires a pano target or null.', { path: `${path}.pano` }));
    return undefined;
  }
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  if (record.pano === null) {
    return shot ? { op: 'shot.setPanorama', shot, pano: null } : undefined;
  }
  const pano = parseEntityTarget(record.pano, `${path}.pano`, errors);
  if (!shot || !pano) return undefined;
  return { op: 'shot.setPanorama', shot, pano };
}

function parseShotCopyStagingToNext(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  if (!shot) return undefined;
  return { op: 'shot.copyStagingToNext', shot };
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

function parseShotDelete(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  if (!shot) return undefined;
  return { op: 'shot.delete', shot };
}

function parseShotTimelineReplace(
  record: Record<string, unknown>,
  path: string,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const durationSeconds = readTimelineDuration(record.durationSeconds, `${path}.durationSeconds`, errors);
  if (!Array.isArray(record.keyframes) || record.keyframes.length === 0) {
    errors.push(agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'shot.timeline.replace requires a nonempty keyframes array.', { path: `${path}.keyframes` }));
    return undefined;
  }
  const keyframes: Extract<ForeSceneAgentCommand, { op: 'shot.timeline.replace' }>['keyframes'] = [];
  let previousTime = -Infinity;
  record.keyframes.forEach((raw, index) => {
    const keyframePath = `${path}.keyframes[${index}]`;
    const parsed = parseTimelineKeyframe(raw, keyframePath, refNames, errors, warnings, true);
    if (!parsed) return;
    if (parsed.timeSeconds <= previousTime) {
      errors.push(agentError('timeline_order', 'Replacement keyframes must be in strict chronological order.', { path: `${keyframePath}.timeSeconds` }));
    }
    previousTime = parsed.timeSeconds;
    keyframes.push(parsed);
  });
  if (!shot || keyframes.length === 0) return undefined;
  const command: Extract<ForeSceneAgentCommand, { op: 'shot.timeline.replace' }> = { op: 'shot.timeline.replace', shot, keyframes };
  if (durationSeconds !== undefined) command.durationSeconds = durationSeconds;
  return command;
}

function parseShotTimelineClear(
  record: Record<string, unknown>, path: string, errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  return shot ? { op: 'shot.timeline.clear', shot } : undefined;
}

function parseShotTimelineSetDuration(
  record: Record<string, unknown>, path: string, errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const durationSeconds = readTimelineDuration(record.durationSeconds, `${path}.durationSeconds`, errors);
  return shot && durationSeconds !== undefined ? { op: 'shot.timeline.setDuration', shot, durationSeconds } : undefined;
}

function parseShotKeyframeCreate(
  record: Record<string, unknown>,
  path: string,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const ref = readOptionalRef(record.ref, `${path}.ref`, refNames, errors);
  const timeSeconds = readTimelineTime(record.timeSeconds, `${path}.timeSeconds`, errors);
  const camera = parsePartialCamera(record.camera, `${path}.camera`, errors);
  const easing = parseTimelineEasing(record.easing, `${path}.easing`, errors);
  const objects = parseTimelineObjects(record.objects, `${path}.objects`, errors, warnings);
  if (!shot || timeSeconds === undefined || !camera) return undefined;
  const command: Extract<ForeSceneAgentCommand, { op: 'shot.keyframe.create' }> = {
    op: 'shot.keyframe.create', shot, timeSeconds, camera,
  };
  const label = readOptionalString(record.label, `${path}.label`, errors, warnings);
  if (ref !== undefined) command.ref = ref;
  if (label !== undefined) command.label = label;
  if (easing !== undefined) command.easing = easing;
  if (objects !== undefined) command.objects = objects;
  if (record.snapshotShotStaging !== undefined) {
    if (typeof record.snapshotShotStaging !== 'boolean') errors.push(agentError('snapshot_staging_type', 'snapshotShotStaging must be a boolean.', { path: `${path}.snapshotShotStaging` }));
    else command.snapshotShotStaging = record.snapshotShotStaging;
  }
  return command;
}

function parseShotKeyframeUpdate(
  record: Record<string, unknown>, path: string, errors: AgentDiagnostic[], warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const keyframe = parseKeyframeTarget(record.keyframe, `${path}.keyframe`, errors);
  const timeSeconds = record.timeSeconds === undefined ? undefined : readTimelineTime(record.timeSeconds, `${path}.timeSeconds`, errors);
  const camera = record.camera === undefined ? undefined : parsePartialCamera(record.camera, `${path}.camera`, errors);
  const easing = parseTimelineEasing(record.easing, `${path}.easing`, errors);
  const label = readOptionalString(record.label, `${path}.label`, errors, warnings);
  const objects = parseTimelineObjects(record.objects, `${path}.objects`, errors, warnings);
  if (!shot || !keyframe) return undefined;
  if (timeSeconds === undefined && camera === undefined && easing === undefined && label === undefined && objects === undefined) {
    errors.push(agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'shot.keyframe.update requires at least one patch field.', { path }));
    return undefined;
  }
  const command: Extract<ForeSceneAgentCommand, { op: 'shot.keyframe.update' }> = { op: 'shot.keyframe.update', shot, keyframe };
  if (timeSeconds !== undefined) command.timeSeconds = timeSeconds;
  if (camera !== undefined) command.camera = camera;
  if (easing !== undefined) command.easing = easing;
  if (label !== undefined) command.label = label;
  if (objects !== undefined) command.objects = objects;
  return command;
}

function parseShotKeyframeDelete(record: Record<string, unknown>, path: string, errors: AgentDiagnostic[]): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const keyframe = parseKeyframeTarget(record.keyframe, `${path}.keyframe`, errors);
  return shot && keyframe ? { op: 'shot.keyframe.delete', shot, keyframe } : undefined;
}

function parseShotKeyframeStageObject(
  record: Record<string, unknown>, path: string, errors: AgentDiagnostic[], warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const keyframe = parseKeyframeTarget(record.keyframe, `${path}.keyframe`, errors);
  const object = parseEntityTarget(record.object, `${path}.object`, errors);
  const patch = parseTimelineObjectFields(record, path, errors, warnings);
  if (!shot || !keyframe || !object || !patch) return undefined;
  return { op: 'shot.keyframe.stageObject', shot, keyframe, object, ...patch };
}

function parseShotKeyframeClearStaging(record: Record<string, unknown>, path: string, errors: AgentDiagnostic[]): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const keyframe = parseKeyframeTarget(record.keyframe, `${path}.keyframe`, errors);
  const object = record.object === undefined ? undefined : parseEntityTarget(record.object, `${path}.object`, errors);
  if (!shot || !keyframe || (record.object !== undefined && !object)) return undefined;
  return object ? { op: 'shot.keyframe.clearStaging', shot, keyframe, object } : { op: 'shot.keyframe.clearStaging', shot, keyframe };
}

function parseTimelineKeyframe(
  raw: unknown, path: string, refNames: Set<string>, errors: AgentDiagnostic[], warnings: AgentDiagnostic[], allowRef: boolean,
): Extract<ForeSceneAgentCommand, { op: 'shot.timeline.replace' }>['keyframes'][number] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError('keyframe_type', 'Keyframe must be an object.', { path }));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const ref = allowRef ? readOptionalRef(record.ref, `${path}.ref`, refNames, errors) : undefined;
  const timeSeconds = readTimelineTime(record.timeSeconds, `${path}.timeSeconds`, errors);
  const camera = parsePartialCamera(record.camera, `${path}.camera`, errors);
  const label = readOptionalString(record.label, `${path}.label`, errors, warnings);
  const easing = parseTimelineEasing(record.easing, `${path}.easing`, errors);
  const objects = parseTimelineObjects(record.objects, `${path}.objects`, errors, warnings);
  if (timeSeconds === undefined || !camera) return undefined;
  const result: Extract<ForeSceneAgentCommand, { op: 'shot.timeline.replace' }>['keyframes'][number] = { timeSeconds, camera };
  if (ref !== undefined) result.ref = ref;
  if (label !== undefined) result.label = label;
  if (easing !== undefined) result.easing = easing;
  if (objects !== undefined) result.objects = objects;
  return result;
}

function parseTimelineObjects(
  raw: unknown, path: string, errors: AgentDiagnostic[], warnings: AgentDiagnostic[],
): AgentTimelineObjectInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(agentError('objects_type', 'objects must be an array.', { path }));
    return undefined;
  }
  const result: AgentTimelineObjectInput[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(agentError('object_state_type', 'Timeline object state must be an object.', { path: `${path}[${index}]` }));
      return;
    }
    const record = entry as Record<string, unknown>;
    const object = parseEntityTarget(record.object, `${path}[${index}].object`, errors);
    const fields = parseTimelineObjectFields(record, `${path}[${index}]`, errors, warnings);
    if (object && fields) result.push({ object, ...fields });
  });
  return result;
}

function parseTimelineObjectFields(
  record: Record<string, unknown>, path: string, errors: AgentDiagnostic[], warnings: AgentDiagnostic[],
): Pick<AgentTimelineObjectInput, 'transform' | 'visible' | 'humanPose' | 'posePreset'> | undefined {
  const transform = parseOptionalTransform(record.transform, `${path}.transform`, errors);
  let visible: boolean | undefined;
  if (record.visible !== undefined) {
    if (typeof record.visible !== 'boolean') errors.push(agentError('visible_type', 'visible must be a boolean.', { path: `${path}.visible` }));
    else visible = record.visible;
  }
  const humanPose = parseOptionalHumanPose(record.humanPose, `${path}.humanPose`, errors);
  let posePreset = readOptionalString(record.posePreset, `${path}.posePreset`, errors, warnings);
  if (posePreset) {
    const aliased = POSE_PRESET_ALIASES[posePreset];
    if (aliased) { warnings.push(agentWarning('pose_preset_alias', `posePreset "${posePreset}" mapped to "${aliased}".`, { path: `${path}.posePreset` })); posePreset = aliased; }
    if (!ALLOWED_PRESETS.has(posePreset)) { errors.push(agentError('pose_preset', `Unknown posePreset "${posePreset}".`, { path: `${path}.posePreset` })); posePreset = undefined; }
  }
  if (transform === undefined && visible === undefined && humanPose === undefined && posePreset === undefined) {
    errors.push(agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'Timeline object state requires transform, visible, humanPose, and/or posePreset.', { path }));
    return undefined;
  }
  return { ...(transform ? { transform } : {}), ...(visible !== undefined ? { visible } : {}), ...(humanPose ? { humanPose } : {}), ...(posePreset ? { posePreset } : {}) };
}

function parseKeyframeTarget(raw: unknown, path: string, errors: AgentDiagnostic[]): AgentKeyframeTarget | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'Keyframe target must include id or ref.', { path }));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id === 'string' && record.id.trim() && record.ref === undefined) return { id: record.id };
  if (typeof record.ref === 'string' && record.ref.trim() && record.id === undefined) return { ref: record.ref };
  errors.push(agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'Keyframe target must include exactly one of id or ref.', { path }));
  return undefined;
}

function readTimelineTime(raw: unknown, path: string, errors: AgentDiagnostic[]): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    errors.push(agentError('timeline_time', 'timeSeconds must be a finite non-negative number.', { path }));
    return undefined;
  }
  return raw;
}

function readTimelineDuration(raw: unknown, path: string, errors: AgentDiagnostic[]): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0.5 || raw > 30) {
    errors.push(agentError('timeline_duration', 'durationSeconds must be between 0.5 and 30 seconds.', { path }));
    return undefined;
  }
  return raw;
}

function parseTimelineEasing(raw: unknown, path: string, errors: AgentDiagnostic[]): 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'linear' && raw !== 'easeIn' && raw !== 'easeOut' && raw !== 'easeInOut') {
    errors.push(agentError('timeline_easing', 'easing must be linear, easeIn, easeOut, or easeInOut.', { path }));
    return undefined;
  }
  return raw;
}

function parseLandmarkCreate(
  record: Record<string, unknown>,
  path: string,
  refNames: Set<string>,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const ref = readOptionalRef(record.ref, `${path}.ref`, refNames, errors);
  if (!record.landmark || typeof record.landmark !== 'object' || Array.isArray(record.landmark)) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'landmark.create requires a landmark object.',
      { path: `${path}.landmark` },
    ));
    return undefined;
  }
  const landmarkRecord = record.landmark as Record<string, unknown>;
  const name = readOptionalString(landmarkRecord.name, `${path}.landmark.name`, errors, warnings);
  const displayName = readOptionalString(
    landmarkRecord.displayName,
    `${path}.landmark.displayName`,
    errors,
    warnings,
  );
  const description = readOptionalString(
    landmarkRecord.description,
    `${path}.landmark.description`,
    errors,
    warnings,
  );
  const position = readOptionalVec3(landmarkRecord.position, `${path}.landmark.position`, errors, true);
  const linkedObjectId = readOptionalString(
    landmarkRecord.linkedObjectId,
    `${path}.landmark.linkedObjectId`,
    errors,
    warnings,
  );
  let visible: boolean | undefined;
  if (landmarkRecord.visible !== undefined) {
    if (typeof landmarkRecord.visible !== 'boolean') {
      errors.push(agentError('visible_type', 'visible must be a boolean.', { path: `${path}.landmark.visible` }));
    } else {
      visible = landmarkRecord.visible;
    }
  }
  let promptCritical: boolean | undefined;
  if (landmarkRecord.promptCritical !== undefined) {
    if (typeof landmarkRecord.promptCritical !== 'boolean') {
      errors.push(agentError(
        'prompt_critical_type',
        'promptCritical must be a boolean.',
        { path: `${path}.landmark.promptCritical` },
      ));
    } else {
      promptCritical = landmarkRecord.promptCritical;
    }
  }
  const tags = parseOptionalStringArray(landmarkRecord.tags, `${path}.landmark.tags`, errors);
  const landmark: Extract<ForeSceneAgentCommand, { op: 'landmark.create' }>['landmark'] = {};
  if (name !== undefined) landmark.name = name;
  if (displayName !== undefined) landmark.displayName = displayName;
  if (description !== undefined) landmark.description = description;
  if (position) landmark.position = position;
  if (linkedObjectId !== undefined) landmark.linkedObjectId = linkedObjectId;
  if (visible !== undefined) landmark.visible = visible;
  if (promptCritical !== undefined) landmark.promptCritical = promptCritical;
  if (tags) landmark.tags = tags;
  const command: ForeSceneAgentCommand = { op: 'landmark.create', landmark };
  if (ref !== undefined) command.ref = ref;
  return command;
}

function parseLandmarkUpdate(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const landmark = parseEntityTarget(record.landmark, `${path}.landmark`, errors);
  if (!landmark) return undefined;
  if (!record.updates || typeof record.updates !== 'object' || Array.isArray(record.updates)) {
    errors.push(agentError('updates_missing', 'updates must be an object.', { path: `${path}.updates` }));
    return undefined;
  }
  const updatesRecord = record.updates as Record<string, unknown>;
  const updates: Extract<ForeSceneAgentCommand, { op: 'landmark.update' }>['updates'] = {};
  const name = readOptionalString(updatesRecord.name, `${path}.updates.name`, errors, warnings);
  const displayName = readOptionalString(
    updatesRecord.displayName,
    `${path}.updates.displayName`,
    errors,
    warnings,
  );
  const description = readOptionalString(
    updatesRecord.description,
    `${path}.updates.description`,
    errors,
    warnings,
  );
  const position = readOptionalVec3(updatesRecord.position, `${path}.updates.position`, errors, true);
  if (name !== undefined) updates.name = name;
  if (displayName !== undefined) updates.displayName = displayName;
  if (description !== undefined) updates.description = description;
  if (position) updates.position = position;
  if (updatesRecord.linkedObjectId === null) {
    updates.linkedObjectId = null;
  } else if (updatesRecord.linkedObjectId !== undefined) {
    const linkedObjectId = readOptionalString(
      updatesRecord.linkedObjectId,
      `${path}.updates.linkedObjectId`,
      errors,
      warnings,
    );
    if (linkedObjectId !== undefined) updates.linkedObjectId = linkedObjectId;
  }
  if (updatesRecord.visible !== undefined) {
    if (typeof updatesRecord.visible !== 'boolean') {
      errors.push(agentError('visible_type', 'visible must be a boolean.', { path: `${path}.updates.visible` }));
    } else {
      updates.visible = updatesRecord.visible;
    }
  }
  if (updatesRecord.promptCritical !== undefined) {
    if (typeof updatesRecord.promptCritical !== 'boolean') {
      errors.push(agentError(
        'prompt_critical_type',
        'promptCritical must be a boolean.',
        { path: `${path}.updates.promptCritical` },
      ));
    } else {
      updates.promptCritical = updatesRecord.promptCritical;
    }
  }
  const tags = parseOptionalStringArray(updatesRecord.tags, `${path}.updates.tags`, errors);
  if (tags) updates.tags = tags;
  if (Object.keys(updates).length === 0) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'landmark.update requires at least one supported field.',
      { path: `${path}.updates` },
    ));
    return undefined;
  }
  return { op: 'landmark.update', landmark, updates };
}

function parseLandmarkDelete(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const landmark = parseEntityTarget(record.landmark, `${path}.landmark`, errors);
  if (!landmark) return undefined;
  return { op: 'landmark.delete', landmark };
}

function parseLandmarkLinkObject(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const landmark = parseEntityTarget(record.landmark, `${path}.landmark`, errors);
  if (!landmark) return undefined;
  if (record.object === null) {
    return { op: 'landmark.linkObject', landmark, object: null };
  }
  const object = parseEntityTarget(record.object, `${path}.object`, errors);
  if (!object) return undefined;
  return { op: 'landmark.linkObject', landmark, object };
}

function parseExportSceneDefaultsPatch(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const patch = parseExportSettingsOverride(record.patch, `${path}.patch`, errors, warnings);
  if (!patch) return undefined;
  return { op: 'export.sceneDefaults.patch', patch };
}

function parseExportShotOverridesPatch(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  const patch = parseExportSettingsOverride(record.patch, `${path}.patch`, errors, warnings);
  if (!shot || !patch) return undefined;
  return { op: 'export.shotOverrides.patch', shot, patch };
}

function parseExportShotOverridesReset(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  if (!shot) return undefined;
  if (record.field === undefined) {
    return { op: 'export.shotOverrides.reset', shot };
  }
  if (typeof record.field !== 'string' || !isExportSettingFieldPath(record.field)) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'field must be a known export setting path when provided.',
      { path: `${path}.field` },
    ));
    warnings.push(agentWarning(
      'export_field_hint',
      `Supported fields include: ${EXPORT_SETTING_TOP_LEVEL_KEYS.slice(0, 6).join(', ')}, characterPass.*, depth.*`,
      { path: `${path}.field` },
    ));
    return undefined;
  }
  return { op: 'export.shotOverrides.reset', shot, field: record.field };
}

function parseExportShotOverridesCopy(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const fromShot = parseEntityTarget(record.fromShot, `${path}.fromShot`, errors);
  if (!Array.isArray(record.toShots) || record.toShots.length === 0) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'toShots must be a nonempty array of shot targets.',
      { path: `${path}.toShots` },
    ));
    return undefined;
  }
  const toShots: AgentEntityTarget[] = [];
  for (let index = 0; index < record.toShots.length; index += 1) {
    const target = parseEntityTarget(record.toShots[index], `${path}.toShots[${index}]`, errors);
    if (target) toShots.push(target);
  }
  if (!fromShot || toShots.length !== record.toShots.length) return undefined;
  return { op: 'export.shotOverrides.copy', fromShot, toShots };
}

function parseExportShotOverridesPromote(
  record: Record<string, unknown>,
  path: string,
  errors: AgentDiagnostic[],
): ForeSceneAgentCommand | undefined {
  const shot = parseEntityTarget(record.shot, `${path}.shot`, errors);
  if (!shot) return undefined;
  return { op: 'export.shotOverrides.promote', shot };
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
      'Target must be an object with id, ref, query, or shotNumber.',
      { path },
    ));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const present = ['id', 'ref', 'query', 'shotNumber'].filter((key) => record[key] !== undefined);
  if (present.length !== 1) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'Target must include exactly one of id, ref, query, or shotNumber.',
      { path },
    ));
    return undefined;
  }
  if (typeof record.shotNumber === 'string' && record.shotNumber.trim()) {
    return { shotNumber: record.shotNumber.trim() };
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
      shotNumber?: string;
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
    if (queryRecord.shotNumber !== undefined) {
      if (typeof queryRecord.shotNumber !== 'string' || !queryRecord.shotNumber.trim()) {
        errors.push(agentError('query_shot_number', 'query.shotNumber must be a nonempty string.', { path: `${path}.query.shotNumber` }));
      } else {
        query.shotNumber = queryRecord.shotNumber.trim();
      }
    }
    if (!query.name && !query.type && !query.stagingRole && !query.shotNumber) {
      errors.push(agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'query requires name, type, stagingRole, and/or shotNumber.',
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

function parseOptionalStringArray(
  value: unknown,
  path: string,
  errors: AgentDiagnostic[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(agentError('string_array_type', `${path} must be an array of strings.`, { path }));
    return undefined;
  }
  const tags: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push(agentError(
        'string_array_entry',
        `${path} entries must be strings.`,
        { path: `${path}[${index}]` },
      ));
      return;
    }
    const trimmed = entry.trim();
    if (trimmed) tags.push(trimmed);
  });
  return tags;
}

const EXPORT_FIELD_PATHS = new Set<string>([
  ...EXPORT_SETTING_TOP_LEVEL_KEYS,
  ...CHARACTER_PASS_OVERRIDE_KEYS.map((key) => `characterPass.${key}`),
  ...DEPTH_OVERRIDE_KEYS.map((key) => `depth.${key}`),
]);

function isExportSettingFieldPath(value: string): value is ExportSettingFieldPath {
  return EXPORT_FIELD_PATHS.has(value);
}

function parseExportSettingsOverride(
  raw: unknown,
  path: string,
  errors: AgentDiagnostic[],
  warnings: AgentDiagnostic[],
): ExportSettingsOverride | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'patch must be an object.',
      { path },
    ));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const patch: ExportSettingsOverride = {};
  const topLevel = new Set<string>(EXPORT_SETTING_TOP_LEVEL_KEYS);

  for (const key of Object.keys(record)) {
    if (key === 'characterPass' || key === 'depth') continue;
    if (!topLevel.has(key)) {
      warnings.push(agentWarning(
        'unknown_export_field',
        `Ignoring unsupported export field "${key}".`,
        { path: `${path}.${key}` },
      ));
    }
  }

  for (const key of EXPORT_SETTING_TOP_LEVEL_KEYS) {
    if (record[key] === undefined) continue;
    const value = record[key];
    if (key === 'width' || key === 'height') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        errors.push(agentError(
          'export_dimension',
          `${key} must be a positive finite number.`,
          { path: `${path}.${key}` },
        ));
      } else {
        patch[key] = Math.round(value);
      }
      continue;
    }
    if (key === 'peopleExportMode') {
      if (value !== 'with_people' && value !== 'clean_plate' && value !== 'both') {
        errors.push(agentError(
          'people_export_mode',
          'peopleExportMode must be with_people, clean_plate, or both.',
          { path: `${path}.peopleExportMode` },
        ));
      } else {
        patch.peopleExportMode = value;
      }
      continue;
    }
    if (typeof value !== 'boolean') {
      errors.push(agentError(
        'export_boolean',
        `${key} must be a boolean.`,
        { path: `${path}.${key}` },
      ));
    } else {
      patch[key] = value;
    }
  }

  if (record.characterPass !== undefined) {
    if (!record.characterPass || typeof record.characterPass !== 'object' || Array.isArray(record.characterPass)) {
      errors.push(agentError(
        'character_pass_type',
        'characterPass must be an object.',
        { path: `${path}.characterPass` },
      ));
    } else {
      const nested = record.characterPass as Record<string, unknown>;
      const characterPass: NonNullable<ExportSettingsOverride['characterPass']> = {};
      for (const key of CHARACTER_PASS_OVERRIDE_KEYS) {
        if (nested[key] === undefined) continue;
        const value = nested[key];
        if (key === 'motionFormat') {
          if (value !== 'green_mp4' && value !== 'transparent_png_sequence' && value !== 'both') {
            errors.push(agentError(
              'motion_format',
              'characterPass.motionFormat must be green_mp4, transparent_png_sequence, or both.',
              { path: `${path}.characterPass.motionFormat` },
            ));
          } else {
            characterPass.motionFormat = value;
          }
          continue;
        }
        if (key === 'backgroundColor') {
          if (typeof value !== 'string' || !value.trim()) {
            errors.push(agentError(
              'background_color',
              'characterPass.backgroundColor must be a nonempty string.',
              { path: `${path}.characterPass.backgroundColor` },
            ));
          } else {
            characterPass.backgroundColor = value.trim();
          }
          continue;
        }
        if (typeof value !== 'boolean') {
          errors.push(agentError(
            'character_pass_boolean',
            `characterPass.${key} must be a boolean.`,
            { path: `${path}.characterPass.${key}` },
          ));
        } else {
          characterPass[key] = value;
        }
      }
      if (Object.keys(characterPass).length > 0) patch.characterPass = characterPass;
    }
  }

  if (record.depth !== undefined) {
    if (!record.depth || typeof record.depth !== 'object' || Array.isArray(record.depth)) {
      errors.push(agentError(
        'depth_type',
        'depth must be an object.',
        { path: `${path}.depth` },
      ));
    } else {
      const nested = record.depth as Record<string, unknown>;
      const depth: NonNullable<ExportSettingsOverride['depth']> = {};
      for (const key of DEPTH_OVERRIDE_KEYS) {
        if (nested[key] === undefined) continue;
        const value = nested[key];
        if (key === 'rangeMode') {
          if (value !== 'auto' && value !== 'manual') {
            errors.push(agentError(
              'depth_range_mode',
              'depth.rangeMode must be auto or manual.',
              { path: `${path}.depth.rangeMode` },
            ));
          } else {
            depth.rangeMode = value;
          }
          continue;
        }
        if (key === 'nearMeters' || key === 'farMeters') {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            errors.push(agentError(
              'depth_meters',
              `depth.${key} must be a finite number.`,
              { path: `${path}.depth.${key}` },
            ));
          } else {
            depth[key] = value;
          }
          continue;
        }
        if (typeof value !== 'boolean') {
          errors.push(agentError(
            'depth_boolean',
            `depth.${key} must be a boolean.`,
            { path: `${path}.depth.${key}` },
          ));
        } else {
          depth[key] = value;
        }
      }
      if (Object.keys(depth).length > 0) patch.depth = depth;
    }
  }

  if (Object.keys(patch).length === 0) {
    errors.push(agentError(
      AGENT_DIAGNOSTIC_CODES.invalidArgument,
      'patch must include at least one supported export field.',
      { path },
    ));
    return undefined;
  }
  return patch;
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
