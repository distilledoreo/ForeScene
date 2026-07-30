/**
 * Pure agent plan compiler: validate → resolve → apply on a structuredClone.
 * Never touches Zustand. Preview and (later) atomic commit share this path.
 */

import {
  createOriginShot,
  createSceneObject,
  createShot,
} from '../../domain/defaults';
import type {
  CameraData,
  LocationProject,
  SceneObject,
  Shot,
  Transform,
  Vec3,
  Workspace,
} from '../../domain/types';
import { applyHumanPosePreset } from '../humanPosePresets';
import { duplicateSceneObject } from '../sandboxCore';
import {
  canStageObjectPerShot,
  clearShotObjectOverride,
  clearShotObjectPoseOverride,
  cloneTransform,
  updateShotObjectOverrides,
} from '../shotSceneState';
import {
  getCanonicalPano,
  linkAllShotsToCanonicalPano,
  withShotPanoLink,
} from '../sync';
import { normalizeWorkspace } from '../workflow';
import { copyStagingToNextShot } from '../sequenceStoryboard';
import { touchProject } from '../../state/slices/touchProject';
import { AGENT_UPRIGHT_OBJECT_TYPES } from './constants';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  type AgentDiagnostic,
} from './diagnostics';
import {
  buildPlanSummary,
  emptyPlanDiff,
  projectFingerprint,
  selectionChanged,
  type AgentSelectionState,
} from './planDiff';
import type {
  AgentEntityReference,
  AgentPlanDiff,
  AgentPlanPreviewResult,
  AgentPlanSummary,
  ForeSceneAgentCommand,
  ForeSceneAgentPlan,
} from './protocol';
import { resolveObjectTarget, resolveShotTarget } from './targetResolver';
import { parseForeSceneAgentPlan } from './validation';

export interface AgentPlanExecutionContext {
  project: LocationProject;
  workspace: Workspace;
  selectedObjectIds: string[];
  selectedShotId?: string;
  activePanoId?: string;
  gridSnap: boolean;
}

export interface PreparedAgentPlan {
  planId: string;
  baseProjectId: string;
  baseFingerprint: string;
  baseProjectUpdatedAt: string;
  nextProject: LocationProject;
  nextSelection: AgentSelectionState;
  nextActivePanoId?: string;
  refs: Record<string, AgentEntityReference>;
  summary: AgentPlanSummary;
  diff: AgentPlanDiff;
  warnings: AgentDiagnostic[];
}

export type PrepareAgentPlanResult =
  | { ok: true; prepared: PreparedAgentPlan; warnings: AgentDiagnostic[] }
  | { ok: false; diagnostics: AgentDiagnostic[]; warnings: AgentDiagnostic[] };

export function createAgentPlanExecutionContext(params: {
  project: LocationProject;
  workspace: Workspace;
  selectedObjectIds: string[];
  selectedShotId?: string;
  activePanoId?: string;
  gridSnap?: boolean;
}): AgentPlanExecutionContext {
  return {
    project: structuredClone(params.project),
    workspace: params.workspace,
    selectedObjectIds: [...params.selectedObjectIds],
    selectedShotId: params.selectedShotId,
    activePanoId: params.activePanoId,
    gridSnap: params.gridSnap ?? true,
  };
}

/**
 * Parse + prepare a plan against a cloned project. On any command failure,
 * discard the clone and return diagnostics — the live project is untouched.
 */
export function prepareAgentPlan(
  input: unknown,
  source: {
    project: LocationProject;
    workspace: Workspace;
    selectedObjectIds: string[];
    selectedShotId?: string;
    activePanoId?: string;
    gridSnap?: boolean;
  },
): PrepareAgentPlanResult {
  const parsed = parseForeSceneAgentPlan(input);
  const warnings = [...parsed.warnings];
  if (!parsed.plan) {
    return { ok: false, diagnostics: parsed.errors, warnings };
  }

  const fingerprint = projectFingerprint(source.project);
  if (
    parsed.plan.expectedFingerprint
    && parsed.plan.expectedFingerprint !== fingerprint
  ) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.staleRevision,
          'Project fingerprint does not match expectedFingerprint; reload and re-preview.',
          { path: 'expectedFingerprint' },
        ),
      ],
      warnings,
    };
  }

  const ctx = createAgentPlanExecutionContext(source);
  const beforeSelection: AgentSelectionState = {
    selectedObjectIds: [...source.selectedObjectIds],
    selectedShotId: source.selectedShotId,
    workspace: source.workspace,
  };
  const refs: Record<string, AgentEntityReference> = {};
  const diff = emptyPlanDiff();
  const diagnostics: AgentDiagnostic[] = [];

  for (let index = 0; index < parsed.plan.commands.length; index += 1) {
    const command = parsed.plan.commands[index]!;
    const result = applyCommand(ctx, command, refs, diff, `commands[${index}]`);
    if (!result.ok) {
      diagnostics.push(...result.diagnostics);
      // Fail the entire plan — no partial preparation.
      return { ok: false, diagnostics, warnings };
    }
    warnings.push(...result.warnings);
  }

  const afterSelection: AgentSelectionState = {
    selectedObjectIds: [...ctx.selectedObjectIds],
    selectedShotId: ctx.selectedShotId,
    workspace: ctx.workspace,
  };
  diff.selectionChanged = selectionChanged(beforeSelection, afterSelection);
  diff.workspaceChanged = beforeSelection.workspace !== afterSelection.workspace;

  const planId = parsed.plan.planId ?? `plan_${Date.now().toString(36)}`;
  const summary = buildPlanSummary({
    commandCount: parsed.plan.commands.length,
    description: parsed.plan.description,
    refs,
    diff,
  });

  return {
    ok: true,
    prepared: {
      planId,
      baseProjectId: source.project.id,
      baseFingerprint: fingerprint,
      baseProjectUpdatedAt: source.project.updatedAt,
      nextProject: ctx.project,
      nextSelection: afterSelection,
      nextActivePanoId: ctx.activePanoId,
      refs,
      summary,
      diff,
      warnings: [...warnings],
    },
    warnings,
  };
}

export function previewAgentPlan(
  input: unknown,
  source: {
    project: LocationProject;
    workspace: Workspace;
    selectedObjectIds: string[];
    selectedShotId?: string;
    activePanoId?: string;
    gridSnap?: boolean;
  },
): AgentPlanPreviewResult {
  const liveFingerprint = projectFingerprint(source.project);
  const liveUpdatedAt = source.project.updatedAt;
  const prepared = prepareAgentPlan(input, source);
  if (!prepared.ok) {
    return {
      ok: false,
      fingerprint: liveFingerprint,
      baseProjectUpdatedAt: liveUpdatedAt,
      warnings: prepared.warnings,
      diagnostics: prepared.diagnostics,
    };
  }
  // Guarantees: preparation used a clone; live project identity is unchanged.
  return {
    ok: true,
    planId: prepared.prepared.planId,
    summary: prepared.prepared.summary,
    diff: prepared.prepared.diff,
    fingerprint: prepared.prepared.baseFingerprint,
    baseProjectUpdatedAt: prepared.prepared.baseProjectUpdatedAt,
    warnings: prepared.warnings,
    diagnostics: [],
  };
}

type ApplyResult =
  | { ok: true; warnings: AgentDiagnostic[] }
  | { ok: false; diagnostics: AgentDiagnostic[]; warnings: AgentDiagnostic[] };

function applyCommand(
  ctx: AgentPlanExecutionContext,
  command: ForeSceneAgentCommand,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  switch (command.op) {
    case 'project.updateInfo':
      return applyProjectUpdateInfo(ctx, command, diff);
    case 'object.create':
      return applyObjectCreate(ctx, command, refs, diff, path);
    case 'object.update':
      return applyObjectUpdate(ctx, command, refs, diff, path);
    case 'object.delete':
      return applyObjectDelete(ctx, command, refs, diff, path);
    case 'object.duplicate':
      return applyObjectDuplicate(ctx, command, refs, diff, path);
    case 'shot.create':
      return applyShotCreate(ctx, command, refs, diff, path);
    case 'shot.rename':
      return applyShotRename(ctx, command, refs, diff, path);
    case 'shot.updateDescription':
      return applyShotUpdateDescription(ctx, command, refs, diff, path);
    case 'shot.updateCamera':
      return applyShotUpdateCamera(ctx, command, refs, diff, path);
    case 'shot.select':
      return applyShotSelect(ctx, command, refs, path);
    case 'shot.copyStagingToNext':
      return applyShotCopyStagingToNext(ctx, command, refs, diff, path);
    case 'shot.stageObject':
      return applyShotStageObject(ctx, command, refs, diff, path);
    case 'shot.clearStaging':
      return applyShotClearStaging(ctx, command, refs, diff, path);
    case 'workspace.open':
      return applyWorkspaceOpen(ctx, command);
    case 'selection.set':
      return applySelectionSet(ctx, command, path);
    default:
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.notImplemented,
            `Unsupported command.`,
            { path: `${path}.op` },
          ),
        ],
        warnings: [],
      };
  }
}

function applyProjectUpdateInfo(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'project.updateInfo' }>,
  diff: AgentPlanDiff,
): ApplyResult {
  ctx.project = touchProject({
    ...ctx.project,
    name: command.name ?? ctx.project.name,
    description: command.description ?? ctx.project.description,
  });
  diff.projectInfoChanged = true;
  return { ok: true, warnings: [] };
}

function applyObjectCreate(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'object.create' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const type = command.object.type;
  const index = ctx.project.scene.objects.filter((object) => object.type === type).length + 1;
  let object = createSceneObject(type, index);

  if (command.object.name) object = { ...object, name: command.object.name };
  if (command.object.dimensions) {
    object = { ...object, dimensions: [...command.object.dimensions] as Vec3 };
  }
  if (command.object.stagingRole) {
    object = { ...object, stagingRole: command.object.stagingRole };
  }

  const transform = cloneTransform(object.transform);
  if (command.object.rotation) transform.rotation = [...command.object.rotation] as Vec3;
  if (command.object.scale) transform.scale = [...command.object.scale] as Vec3;
  if (command.object.position) {
    transform.position = resolveAgentCreatePosition(object, command.object.position, transform.scale);
  }
  object = { ...object, transform };

  if (command.ref && refs[command.ref]) {
    return {
      ok: false,
      diagnostics: [
        agentError('duplicate_ref', `Ref "${command.ref}" is already bound.`, { path: `${path}.ref` }),
      ],
      warnings: [],
    };
  }

  ctx.project = touchProject({
    ...ctx.project,
    scene: {
      ...ctx.project.scene,
      objects: [...ctx.project.scene.objects, object],
    },
  });
  ctx.selectedObjectIds = [object.id];
  diff.objectsCreated.push(object.id);
  if (command.ref) {
    refs[command.ref] = { kind: 'object', id: object.id, ref: command.ref, name: object.name };
  }
  return { ok: true, warnings: [] };
}

/**
 * SetBlueprint-aligned placement:
 * - floors: top surface at provided Y (typically 0)
 * - upright people/architecture: bottom rests on provided Y
 * - other types: provided position is the object center
 */
export function resolveAgentCreatePosition(
  object: Pick<SceneObject, 'type' | 'dimensions'>,
  position: Vec3,
  scale: Vec3 = [1, 1, 1],
): Vec3 {
  const scaledHeight = object.dimensions[1] * scale[1];
  if (object.type === 'floor') {
    return [position[0], position[1] - scaledHeight / 2, position[2]];
  }
  if (AGENT_UPRIGHT_OBJECT_TYPES.has(object.type)) {
    return [position[0], position[1] + scaledHeight / 2, position[2]];
  }
  return [position[0], position[1], position[2]];
}

function applyObjectUpdate(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'object.update' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const resolved = resolveObjectTarget(ctx.project, command.object, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const existing = ctx.project.scene.objects.find((object) => object.id === resolved.id);
  if (!existing) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No object with id "${resolved.id}".`, { path }),
      ],
      warnings: [],
    };
  }

  const updates = command.updates;
  let next: SceneObject = { ...existing };
  if (typeof updates.name === 'string') next = { ...next, name: updates.name };
  if (typeof updates.visible === 'boolean') next = { ...next, visible: updates.visible };
  if (typeof updates.locked === 'boolean') next = { ...next, locked: updates.locked };
  if (typeof updates.stagingRole === 'string') {
    next = { ...next, stagingRole: updates.stagingRole as SceneObject['stagingRole'] };
  }
  if (typeof updates.color === 'string') next = { ...next, color: updates.color };
  if (typeof updates.secondaryColor === 'string') {
    next = { ...next, secondaryColor: updates.secondaryColor };
  }
  if (Array.isArray(updates.dimensions) && updates.dimensions.length === 3) {
    next = { ...next, dimensions: [...updates.dimensions] as Vec3 };
  }

  const transform = cloneTransform(next.transform);
  if (updates.transform && typeof updates.transform === 'object') {
    const t = updates.transform as Transform;
    transform.position = [...t.position] as Vec3;
    transform.rotation = [...t.rotation] as Vec3;
    transform.scale = [...t.scale] as Vec3;
  }
  if (Array.isArray(updates.position) && updates.position.length === 3) {
    transform.position = [...updates.position] as Vec3;
  }
  if (Array.isArray(updates.rotation) && updates.rotation.length === 3) {
    transform.rotation = [...updates.rotation] as Vec3;
  }
  if (Array.isArray(updates.scale) && updates.scale.length === 3) {
    transform.scale = [...updates.scale] as Vec3;
  }
  next = { ...next, transform };

  ctx.project = touchProject({
    ...ctx.project,
    scene: {
      ...ctx.project.scene,
      objects: ctx.project.scene.objects.map((object) => (
        object.id === next.id ? next : object
      )),
    },
  });
  if (!diff.objectsCreated.includes(next.id)) {
    diff.objectsUpdated.push(next.id);
  }
  return { ok: true, warnings: [] };
}

function applyObjectDelete(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'object.delete' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const resolved = resolveObjectTarget(ctx.project, command.object, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const id = resolved.id;
  ctx.project = touchProject({
    ...ctx.project,
    scene: {
      ...ctx.project.scene,
      objects: ctx.project.scene.objects.filter((object) => object.id !== id),
    },
    shots: ctx.project.shots.map((shot) => {
      if (!shot.objectOverrides || !(id in shot.objectOverrides)) return shot;
      const nextOverrides = { ...shot.objectOverrides };
      delete nextOverrides[id];
      return {
        ...shot,
        objectOverrides: nextOverrides,
        updatedAt: new Date().toISOString(),
      };
    }),
  });
  ctx.selectedObjectIds = ctx.selectedObjectIds.filter((selectedId) => selectedId !== id);
  for (const [ref, entity] of Object.entries(refs)) {
    if (entity.id === id) delete refs[ref];
  }
  diff.objectsDeleted.push(id);
  return { ok: true, warnings: [] };
}

function applyObjectDuplicate(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'object.duplicate' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const resolved = resolveObjectTarget(ctx.project, command.object, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const source = ctx.project.scene.objects.find((object) => object.id === resolved.id);
  if (!source) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No object with id "${resolved.id}".`, { path }),
      ],
      warnings: [],
    };
  }
  const index = ctx.project.scene.objects.filter((object) => object.type === source.type).length + 1;
  const duplicate = duplicateSceneObject(source, index, ctx.gridSnap);
  ctx.project = touchProject({
    ...ctx.project,
    scene: {
      ...ctx.project.scene,
      objects: [...ctx.project.scene.objects, duplicate],
    },
  });
  ctx.selectedObjectIds = [duplicate.id];
  diff.objectsCreated.push(duplicate.id);
  if (command.ref) {
    refs[command.ref] = {
      kind: 'object',
      id: duplicate.id,
      ref: command.ref,
      name: duplicate.name,
    };
  }
  return { ok: true, warnings: [] };
}

function applyShotCreate(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.create' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  _path: string,
): ApplyResult {
  const sourceShot = ctx.project.shots.find((shot) => shot.id === ctx.selectedShotId);
  const linkedPano = getCanonicalPano(ctx.project);
  const origin = createOriginShot(ctx.project, ctx.project.shots.length + 1);
  let camera: CameraData = origin.camera;
  if (command.shot.camera) {
    camera = {
      ...camera,
      ...command.shot.camera,
      position: command.shot.camera.position
        ? [...command.shot.camera.position] as Vec3
        : [...camera.position] as Vec3,
      target: command.shot.camera.target
        ? [...command.shot.camera.target] as Vec3
        : [...camera.target] as Vec3,
    };
  }

  let shot = createShot({
    index: ctx.project.shots.length + 1,
    camera,
    linkedPanoId: linkedPano?.id,
    exportDefaults: ctx.project.exportConfiguration?.defaults,
  });
  shot = withShotPanoLink(ctx.project, shot, linkedPano);
  if (command.shot.name) shot.name = command.shot.name;
  if (command.shot.description !== undefined) shot.description = command.shot.description;
  shot.objectOverrides = structuredClone(sourceShot?.objectOverrides ?? {});

  ctx.project = touchProject({
    ...ctx.project,
    shots: [...ctx.project.shots, shot],
  });
  ctx.selectedShotId = shot.id;
  ctx.workspace = 'shots';
  if (shot.linkedPanoId) ctx.activePanoId = shot.linkedPanoId;
  diff.shotsCreated.push(shot.id);
  if (command.ref) {
    refs[command.ref] = { kind: 'shot', id: shot.id, ref: command.ref, name: shot.name };
  }
  return { ok: true, warnings: [] };
}

function applyShotRename(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.rename' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const resolved = resolveShotTarget(ctx.project, command.shot, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  ctx.project = touchProject({
    ...ctx.project,
    shots: ctx.project.shots.map((shot) => (
      shot.id === resolved.id
        ? { ...shot, name: command.name, updatedAt: new Date().toISOString() }
        : shot
    )),
  });
  if (refs) {
    for (const entity of Object.values(refs)) {
      if (entity.kind === 'shot' && entity.id === resolved.id) entity.name = command.name;
    }
  }
  if (!diff.shotsCreated.includes(resolved.id)) diff.shotsUpdated.push(resolved.id);
  return { ok: true, warnings: [] };
}

function applyShotUpdateDescription(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.updateDescription' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const resolved = resolveShotTarget(ctx.project, command.shot, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  ctx.project = touchProject({
    ...ctx.project,
    shots: ctx.project.shots.map((shot) => (
      shot.id === resolved.id
        ? { ...shot, description: command.description, updatedAt: new Date().toISOString() }
        : shot
    )),
  });
  if (!diff.shotsCreated.includes(resolved.id)) diff.shotsUpdated.push(resolved.id);
  return { ok: true, warnings: [] };
}

function applyShotSelect(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.select' }>,
  refs: Record<string, AgentEntityReference>,
  path: string,
): ApplyResult {
  const resolved = resolveShotTarget(ctx.project, command.shot, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const shot = ctx.project.shots.find((item) => item.id === resolved.id);
  if (!shot) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${resolved.id}".`, { path }),
      ],
      warnings: [],
    };
  }
  ctx.selectedShotId = shot.id;
  if (shot.linkedPanoId) ctx.activePanoId = shot.linkedPanoId;
  return { ok: true, warnings: [] };
}

function applyShotCopyStagingToNext(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.copyStagingToNext' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const resolved = resolveShotTarget(ctx.project, command.shot, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const index = ctx.project.shots.findIndex((shot) => shot.id === resolved.id);
  if (index < 0 || index >= ctx.project.shots.length - 1) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          'shot.copyStagingToNext requires a following shot in the sequence.',
          { path },
        ),
      ],
      warnings: [],
    };
  }
  const nextId = ctx.project.shots[index + 1]!.id;
  const nextShots = copyStagingToNextShot(ctx.project.shots, resolved.id).map((shot) => (
    shot.id === nextId
      ? { ...shot, updatedAt: new Date().toISOString() }
      : shot
  ));
  ctx.project = touchProject({
    ...ctx.project,
    shots: nextShots,
  });
  if (!diff.shotsCreated.includes(nextId)) diff.shotsUpdated.push(nextId);
  return { ok: true, warnings: [] };
}

function applyShotUpdateCamera(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.updateCamera' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const resolved = resolveShotTarget(ctx.project, command.shot, refs);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostics: resolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const existing = ctx.project.shots.find((shot) => shot.id === resolved.id);
  if (!existing) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${resolved.id}".`, { path }),
      ],
      warnings: [],
    };
  }
  const camera: CameraData = {
    ...existing.camera,
    ...command.camera,
    position: command.camera.position
      ? [...command.camera.position] as Vec3
      : [...existing.camera.position] as Vec3,
    target: command.camera.target
      ? [...command.camera.target] as Vec3
      : [...existing.camera.target] as Vec3,
  };
  const linkedPano = existing.linkedPanoId
    ? ctx.project.panoRefs.find((pano) => pano.id === existing.linkedPanoId)
    : getCanonicalPano(ctx.project);
  const updated = withShotPanoLink(
    ctx.project,
    {
      ...existing,
      camera,
      updatedAt: new Date().toISOString(),
    },
    linkedPano,
  );
  ctx.project = touchProject({
    ...ctx.project,
    shots: ctx.project.shots.map((shot) => (shot.id === updated.id ? updated : shot)),
  });
  if (!diff.shotsCreated.includes(updated.id)) {
    diff.shotsUpdated.push(updated.id);
  }
  return { ok: true, warnings: [] };
}

function applyShotStageObject(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.stageObject' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const shotResolved = resolveShotTarget(ctx.project, command.shot, refs);
  if (!shotResolved.ok) {
    return {
      ok: false,
      diagnostics: shotResolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const objectResolved = resolveObjectTarget(ctx.project, command.object, refs);
  if (!objectResolved.ok) {
    return {
      ok: false,
      diagnostics: objectResolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const shot = ctx.project.shots.find((item) => item.id === shotResolved.id);
  const object = ctx.project.scene.objects.find((item) => item.id === objectResolved.id);
  if (!shot || !object) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, 'Shot or object missing for staging.', { path }),
      ],
      warnings: [],
    };
  }
  if (!canStageObjectPerShot(object)) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          `Object "${object.name}" cannot be staged per shot (locked or helper).`,
          { path },
        ),
      ],
      warnings: [],
    };
  }

  const humanPose = command.humanPose
    ?? (command.posePreset ? applyHumanPosePreset(command.posePreset) : undefined);
  const overrides = updateShotObjectOverrides(shot, object, {
    transform: command.transform,
    visible: command.visible,
    humanPose,
  });
  const updated: Shot = {
    ...shot,
    objectOverrides: overrides,
    updatedAt: new Date().toISOString(),
  };
  ctx.project = touchProject({
    ...ctx.project,
    shots: ctx.project.shots.map((item) => (item.id === updated.id ? updated : item)),
  });
  if (!diff.shotsCreated.includes(updated.id)) {
    diff.shotsUpdated.push(updated.id);
  }
  return { ok: true, warnings: [] };
}

function applyShotClearStaging(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'shot.clearStaging' }>,
  refs: Record<string, AgentEntityReference>,
  diff: AgentPlanDiff,
  path: string,
): ApplyResult {
  const shotResolved = resolveShotTarget(ctx.project, command.shot, refs);
  if (!shotResolved.ok) {
    return {
      ok: false,
      diagnostics: shotResolved.diagnostics.map((item) => ({
        ...item,
        path: item.path ? `${path}.${item.path}` : path,
      })),
      warnings: [],
    };
  }
  const shot = ctx.project.shots.find((item) => item.id === shotResolved.id);
  if (!shot) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${shotResolved.id}".`, { path }),
      ],
      warnings: [],
    };
  }

  let overrides = shot.objectOverrides ?? {};
  if (command.object) {
    const objectResolved = resolveObjectTarget(ctx.project, command.object, refs);
    if (!objectResolved.ok) {
      return {
        ok: false,
        diagnostics: objectResolved.diagnostics.map((item) => ({
          ...item,
          path: item.path ? `${path}.${item.path}` : path,
        })),
        warnings: [],
      };
    }
    overrides = command.clearPoseOnly
      ? clearShotObjectPoseOverride(shot, objectResolved.id)
      : clearShotObjectOverride(shot, objectResolved.id);
  } else if (command.clearPoseOnly) {
    const next: typeof overrides = { ...overrides };
    for (const objectId of Object.keys(next)) {
      const cleared = clearShotObjectPoseOverride({ objectOverrides: next }, objectId);
      if (cleared[objectId]) next[objectId] = cleared[objectId]!;
      else delete next[objectId];
    }
    overrides = next;
  } else {
    overrides = {};
  }

  const updated: Shot = {
    ...shot,
    objectOverrides: overrides,
    updatedAt: new Date().toISOString(),
  };
  ctx.project = touchProject({
    ...ctx.project,
    shots: ctx.project.shots.map((item) => (item.id === updated.id ? updated : item)),
  });
  if (!diff.shotsCreated.includes(updated.id)) {
    diff.shotsUpdated.push(updated.id);
  }
  return { ok: true, warnings: [] };
}

function applyWorkspaceOpen(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'workspace.open' }>,
): ApplyResult {
  const workspace = normalizeWorkspace(command.workspace);
  if (workspace === 'shots') {
    let project = ctx.project;
    if (project.shots.length === 0) {
      project = touchProject({
        ...project,
        shots: [createOriginShot(project)],
      });
    }
    project = linkAllShotsToCanonicalPano(project);
    const selected = project.shots.find((shot) => shot.id === ctx.selectedShotId) ?? project.shots[0];
    ctx.project = project;
    ctx.workspace = 'shots';
    ctx.selectedShotId = selected?.id;
    if (selected?.linkedPanoId) ctx.activePanoId = selected.linkedPanoId;
    return { ok: true, warnings: [] };
  }
  ctx.workspace = workspace;
  return { ok: true, warnings: [] };
}

function applySelectionSet(
  ctx: AgentPlanExecutionContext,
  command: Extract<ForeSceneAgentCommand, { op: 'selection.set' }>,
  path: string,
): ApplyResult {
  if (command.objectIds) {
    const missing = command.objectIds.filter(
      (id) => !ctx.project.scene.objects.some((object) => object.id === id),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `Unknown object ids in selection: ${missing.join(', ')}.`,
            { path: `${path}.objectIds`, candidates: missing },
          ),
        ],
        warnings: [],
      };
    }
    ctx.selectedObjectIds = [...command.objectIds];
  }
  if (command.shotId === null) {
    ctx.selectedShotId = undefined;
  } else if (typeof command.shotId === 'string') {
    const shot = ctx.project.shots.find((item) => item.id === command.shotId);
    if (!shot) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No shot with id "${command.shotId}".`,
            { path: `${path}.shotId` },
          ),
        ],
        warnings: [],
      };
    }
    ctx.selectedShotId = shot.id;
    if (shot.linkedPanoId) ctx.activePanoId = shot.linkedPanoId;
  }
  return { ok: true, warnings: [] };
}
