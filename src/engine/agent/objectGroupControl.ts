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
import { computeRigidGroupMemberTransforms, groupPivotFromObjects } from './groupTransform';
import { applyShotStagingPatch, getEffectiveObject, getShotEffectiveState } from './spatialShotState';
import {
  agentError,
  agentInfo,
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

  const requestedIds = [...new Set(input.objectIds)];
  const existing = Object.values(objectGroups(project)).find((candidate) => (
    candidate.objectIds.length === requestedIds.length
    && candidate.objectIds.every((objectId) => requestedIds.includes(objectId))
  ));
  if (existing && (!input.sourceImportId || existing.sourceImportId === input.sourceImportId)) {
    return {
      ok: true,
      status: 'completed',
      groupId: existing.id,
      group: summarizeGroup(project, existing),
      diagnostics: [],
    };
  }

  if (existing && input.sourceImportId && !existing.sourceImportId) {
    const importedMembersMatch = requestedIds.every((objectId) => (
      project.scene.objects.find((object) => object.id === objectId)
        ?.importedModel?.sourceImportId === input.sourceImportId
    ));
    if (!importedMembersMatch) {
      return {
        ok: false,
        status: 'failed',
        diagnostics: [agentError(
          'group_source_import_mismatch',
          `Existing group "${existing.id}" cannot be linked to source import "${input.sourceImportId}".`,
        )],
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
    const repaired = { ...existing, sourceImportId: input.sourceImportId };
    const verified = await runDestructive('Link object group to source import', () => {
      useProjectStore.setState((state) => ({
        project: touchProject({
          ...state.project,
          scene: {
            ...state.project.scene,
            objectGroups: {
              ...objectGroups(state.project),
              [existing.id]: repaired,
            },
          },
        }),
      }));
    });
    return {
      ok: true,
      status: 'completed',
      groupId: existing.id,
      group: summarizeGroup(useProjectStore.getState().project, repaired),
      revisionId: verified?.revision.id,
      diagnostics: [],
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

  const shotState = getShotEffectiveState(project, input.shotId);
  if (!shotState) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('shot_not_found', `No shot with id "${input.shotId}".`)],
    };
  }

  const effectiveMembers = group.objectIds
    .map((objectId) => getEffectiveObject(shotState, objectId))
    .filter((member): member is SceneObject => Boolean(member));

  const verified = await runDestructive('Stage object group', () => {
    useProjectStore.setState((state) => {
      let nextProject = state.project;
      if (input.transform && effectiveMembers.length > 0) {
        const pivot = groupPivotFromObjects(effectiveMembers);
        const memberTransforms = computeRigidGroupMemberTransforms(
          effectiveMembers,
          pivot,
          input.transform,
        );
        for (const objectId of group.objectIds) {
          const transform = memberTransforms.get(objectId);
          if (!transform) continue;
          nextProject = applyShotStagingPatch(nextProject, input.shotId, objectId, { transform });
        }
      }
      if (input.visible !== undefined) {
        for (const objectId of group.objectIds) {
          nextProject = applyShotStagingPatch(nextProject, input.shotId, objectId, { visible: input.visible });
        }
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
  const state = getShotEffectiveState(project, input.shotId);
  const effectiveMembers = assemblyIds
    .map((objectId) => getEffectiveObject(state!, objectId))
    .filter((member): member is SceneObject => Boolean(member));

  const diagnostics = inspectAgentShotDiagnostics({
    project,
    shot,
    subjectIds: assemblyIds,
  });

  if (effectiveMembers.length > 0) {
    const box = selectionBounds(effectiveMembers);
    diagnostics.diagnostics.push(agentInfo(
      'assembly_bounds',
      'Shot-effective assembly bounds min '
        + box.min.x.toFixed(2) + ',' + box.min.y.toFixed(2) + ',' + box.min.z.toFixed(2)
        + ' max '
        + box.max.x.toFixed(2) + ',' + box.max.y.toFixed(2) + ',' + box.max.z.toFixed(2),
    ));
  }
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
