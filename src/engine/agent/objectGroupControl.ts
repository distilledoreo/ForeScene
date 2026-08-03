/**
 * Agent API logical object groups and assembly diagnostics.
 */

import type { LocationProject, ObjectGroup, SceneObject, Transform } from '../../domain/types';
import { createId } from '../../utils/ids';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { selectionBounds } from '../buildSelection';
import { applyShotStagingPatch } from './spatialShotState';
import {
  agentError,
  agentWarning,
  writeAccessRequiredDiagnostic,
} from './diagnostics';
import { inspectAgentShotDiagnostics } from './shotDiagnostics';
import type {
  AgentObjectGroupInput,
  AgentObjectGroupResult,
  AgentObjectGroupSummary,
  AgentShotDiagnostics,
} from './protocol';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';
import { getShotEffectiveState } from './spatialShotState';

function objectGroups(project: LocationProject): Record<string, ObjectGroup> {
  return project.scene.objectGroups ?? {};
}

function summarizeGroup(project: LocationProject, group: ObjectGroup): AgentObjectGroupSummary {
  const objects = project.scene.objects.filter((object) => group.objectIds.includes(object.id));
  let worldBounds: AgentObjectGroupSummary['worldBounds'];
  if (objects.length > 0) {
    const box = selectionBounds(objects);
    worldBounds = {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    };
  }
  return {
    groupId: group.id,
    name: group.name,
    objectIds: [...group.objectIds],
    sourceImportId: group.sourceImportId,
    worldBounds,
  };
}

export function listAgentObjectGroups(): AgentObjectGroupSummary[] {
  const project = useProjectStore.getState().project;
  return Object.values(objectGroups(project)).map((group) => summarizeGroup(project, group));
}

export function inspectAgentObjectGroup(groupId: string): AgentObjectGroupSummary | undefined {
  const project = useProjectStore.getState().project;
  const group = objectGroups(project)[groupId];
  if (!group) return undefined;
  return summarizeGroup(project, group);
}

export function resolveAssemblyObjectIds(
  project: LocationProject,
  input: { objectId?: string; groupId?: string; sourceImportId?: string },
): string[] {
  if (input.groupId) {
    const group = objectGroups(project)[input.groupId];
    return group ? [...group.objectIds] : [];
  }
  if (input.objectId) {
    const object = project.scene.objects.find((candidate) => candidate.id === input.objectId);
    if (object?.importedModel?.sourceImportId) {
      return project.scene.objects
        .filter((candidate) => candidate.importedModel?.sourceImportId === object.importedModel!.sourceImportId)
        .map((candidate) => candidate.id);
    }
    return [input.objectId];
  }
  if (input.sourceImportId) {
    return project.scene.objects
      .filter((candidate) => candidate.importedModel?.sourceImportId === input.sourceImportId)
      .map((candidate) => candidate.id);
  }
  return [];
}

export async function createAgentObjectGroup(
  input: AgentObjectGroupInput,
): Promise<AgentObjectGroupResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic('createObjectGroup')],
    };
  }

  const project = useProjectStore.getState().project;
  const missing = input.objectIds.filter((id) => !project.scene.objects.some((object) => object.id === id));
  if (missing.length > 0) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('object_not_found', 'Objects not found: ' + missing.join(', ') + '.')],
    };
  }

  const groupId = createId('group');
  const group: ObjectGroup = {
    id: groupId,
    name: input.name,
    objectIds: [...input.objectIds],
    ...(input.sourceImportId ? { sourceImportId: input.sourceImportId } : {}),
  };

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }

  const verified = await runDestructive('Create object group', () => {
    useProjectStore.setState((state) => ({
      project: touchProject({
        ...state.project,
        scene: {
          ...state.project.scene,
          objectGroups: {
            ...objectGroups(state.project),
            [groupId]: group,
          },
        },
      }),
    }));
  });

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    groupId,
    group: summarizeGroup(useProjectStore.getState().project, group),
    revisionId: verified?.revision.id,
    diagnostics: [],
  };
}

export async function stageAgentObjectGroup(input: {
  shotId: string;
  groupId: string;
  transform?: Transform;
  visible?: boolean;
}): Promise<AgentObjectGroupResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic('stageObjectGroup')],
    };
  }

  const project = useProjectStore.getState().project;
  const group = objectGroups(project)[input.groupId];
  if (!group) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('group_not_found', 'No object group with id ' + input.groupId + '.')],
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }

  const verified = await runDestructive('Stage object group', () => {
    useProjectStore.setState((state) => {
      let nextProject = state.project;
      for (const objectId of group.objectIds) {
        const patch: { transform?: Transform; visible?: boolean } = {};
        if (input.transform) patch.transform = input.transform;
        if (input.visible !== undefined) patch.visible = input.visible;
        nextProject = applyShotStagingPatch(nextProject, input.shotId, objectId, patch);
      }
      return { project: touchProject(nextProject) };
    });
  });

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    groupId: input.groupId,
    group: summarizeGroup(useProjectStore.getState().project, group),
    revisionId: verified?.revision.id,
    diagnostics: [],
  };
}

export function diagnoseAgentObjectGroup(input: {
  shotId: string;
  groupId: string;
}): AgentShotDiagnostics {
  const project = useProjectStore.getState().project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  const group = objectGroups(project)[input.groupId];
  if (!shot || !group) {
    return {
      shotId: input.shotId,
      subjects: [],
      foregroundOcclusionFraction: 0,
      linkedPanoramaResolved: false,
      cameraIntersectsSolidGeometry: false,
      cameraDisplacementMeters: 0,
      subjectDisplacements: [],
      diagnostics: [agentError('group_or_shot_not_found', 'Shot or object group not found.')],
    };
  }

  const assemblyIds = group.objectIds;
  const diagnostics = inspectAgentShotDiagnostics({
    project,
    shot,
    subjectIds: assemblyIds,
  });

  const state = getShotEffectiveState(project, input.shotId);
  const presentIds = new Set(state?.objects.map((object) => object.id) ?? []);
  const missingMembers = assemblyIds.filter((id) => !presentIds.has(id));
  if (missingMembers.length > 0) {
    diagnostics.diagnostics.push(agentWarning(
      'assembly_incomplete',
      'Assembly missing members: ' + missingMembers.join(', ') + '.',
    ));
  }

  return diagnostics;
}

/** Create implicit groups from import batches when explicit groups are absent. */
export function inferImportAssemblyGroups(project: LocationProject): AgentObjectGroupSummary[] {
  const byImport = new Map<string, SceneObject[]>();
  for (const object of project.scene.objects) {
    const importId = object.importedModel?.sourceImportId;
    if (!importId) continue;
    const list = byImport.get(importId) ?? [];
    list.push(object);
    byImport.set(importId, list);
  }
  return [...byImport.entries()].map(([sourceImportId, objects]) => {
    const box = selectionBounds(objects);
    return {
      groupId: 'import_' + sourceImportId,
      name: objects[0]?.importedModel?.sourceName ?? sourceImportId,
      objectIds: objects.map((object) => object.id),
      sourceImportId,
      worldBounds: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      },
    };
  });
}
