/**
 * Read-only project inspection helpers for the ForeScene Agent API.
 * Pure over project/selection snapshots — no React, no store writes.
 */

import type {
  LocationProject,
  SceneObject,
  Shot,
  Workspace,
} from '../../domain/types';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  type AgentDiagnostic,
} from './diagnostics';
import type {
  AgentEntityTarget,
  AgentLandmarkSummary,
  AgentObjectInspection,
  AgentObjectQuery,
  AgentObjectSummary,
  AgentProjectInspection,
  AgentMissingAssetSummary,
  AgentShotInspection,
  AgentShotSummary,
  AgentShotTimeSample,
  AgentShotTimelineInspection,
} from './protocol';
import { inspectShotTimeline as inspectTimeline, sampleShotTimeline } from '../shotTimeline';
import { getAssetInstanceIds, getAssetShotIds, listMissingProjectAssets } from '../projectAssetRecovery';

export interface AgentInspectionContext {
  project: LocationProject;
  workspace: Workspace;
  selectedObjectIds: string[];
  selectedShotId?: string;
  revisionId?: string;
}

function cloneVec3(value: [number, number, number]): [number, number, number] {
  return [value[0], value[1], value[2]];
}

function nameMatches(
  candidate: string,
  query: string,
  match: 'exact' | 'contains',
): boolean {
  if (match === 'exact') return candidate === query;
  return candidate.toLowerCase().includes(query.toLowerCase());
}

export function inspectProjectSnapshot(
  ctx: AgentInspectionContext,
): AgentProjectInspection {
  const { project } = ctx;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    units: project.units,
    schemaVersion: project.schemaVersion,
    updatedAt: project.updatedAt,
    objectCount: project.scene.objects.length,
    shotCount: project.shots.length,
    landmarkCount: project.landmarks.length,
    panoCount: project.panoRefs.length,
    workspace: ctx.workspace,
    selectedObjectIds: [...ctx.selectedObjectIds],
    selectedShotId: ctx.selectedShotId,
    revisionId: ctx.revisionId,
    missingAssetCount: listMissingProjectAssets(project).length,
    missingAssets: listMissingProjectAssets(project).map((asset): AgentMissingAssetSummary => ({
      assetId: asset.id,
      name: asset.name,
      originalFileName: asset.originalFileName,
      status: asset.resolutionStatus as AgentMissingAssetSummary['status'],
      instanceObjectIds: getAssetInstanceIds(project, asset.id),
      affectedShotIds: getAssetShotIds(project, asset.id),
    })),
  };
}

export function summarizeObject(object: SceneObject, project?: LocationProject): AgentObjectSummary {
  return {
    id: object.id,
    name: object.name,
    type: object.type,
    stagingRole: object.stagingRole,
    visible: object.visible,
    locked: object.locked,
    position: cloneVec3(object.transform.position),
    hasHumanPose: Boolean(object.humanPose),
    isPoseable: Boolean(object.poseableCharacter),
    assetStatus: object.modelAssetId && project
      ? project.assets.assets[object.modelAssetId]?.resolutionStatus ?? 'missing'
      : undefined,
  };
}

export function inspectObjectSnapshot(object: SceneObject, project?: LocationProject): AgentObjectInspection {
  return {
    ...summarizeObject(object, project),
    transform: {
      position: cloneVec3(object.transform.position),
      rotation: cloneVec3(object.transform.rotation),
      scale: cloneVec3(object.transform.scale),
    },
    dimensions: cloneVec3(object.dimensions),
    category: object.category,
    color: object.color,
    modelAssetId: object.modelAssetId,
  };
}

export function listObjectsSnapshot(
  project: LocationProject,
  query: AgentObjectQuery = {},
): AgentObjectSummary[] {
  const match = query.match ?? 'contains';
  return project.scene.objects
    .filter((object) => {
      if (query.name !== undefined && !nameMatches(object.name, query.name, match)) {
        return false;
      }
      if (query.type !== undefined && object.type !== query.type) return false;
      if (query.stagingRole !== undefined && object.stagingRole !== query.stagingRole) {
        return false;
      }
      if (query.visible !== undefined && object.visible !== query.visible) return false;
      if (query.locked !== undefined && object.locked !== query.locked) return false;
      return true;
    })
    .map((object) => summarizeObject(object, project));
}

export function summarizeShot(shot: Shot): AgentShotSummary {
  const overrideCount = shot.objectOverrides
    ? Object.keys(shot.objectOverrides).length
    : 0;
  return {
    id: shot.id,
    shotNumber: shot.shotNumber,
    name: shot.name,
    description: shot.description,
    status: shot.status,
    cameraPosition: cloneVec3(shot.camera.position),
    cameraTarget: cloneVec3(shot.camera.target),
    fovDegrees: shot.camera.fovDegrees,
    overrideObjectCount: overrideCount,
    keyframeCount: shot.cameraKeyframes.length,
    linkedPanoId: shot.linkedPanoId,
  };
}

export function inspectShotSnapshot(shot: Shot): AgentShotInspection {
  const stagedObjectIds = shot.objectOverrides
    ? Object.keys(shot.objectOverrides)
    : [];
  return {
    ...summarizeShot(shot),
    camera: {
      ...shot.camera,
      position: cloneVec3(shot.camera.position),
      target: cloneVec3(shot.camera.target),
    },
    landmarkIds: [...shot.landmarkIds],
    stagedObjectIds,
  };
}

export function inspectShotTimelineSnapshot(
  project: LocationProject,
  shot: Shot,
): AgentShotTimelineInspection {
  const inspection = inspectTimeline(project, shot.id);
  return {
    ...inspection,
    keyframes: inspection.keyframes.map((keyframe) => ({
      id: keyframe.id,
      label: keyframe.label,
      timeSeconds: keyframe.timeSeconds,
      easing: keyframe.easing,
      camera: {
        ...keyframe.camera,
        position: cloneVec3(keyframe.camera.position),
        target: cloneVec3(keyframe.camera.target),
      },
      objectOverrides: structuredClone(keyframe.objectOverrides ?? {}),
      stagedObjectIds: Object.keys(keyframe.objectOverrides ?? {}),
    })),
  };
}

export function sampleShotAtTimeSnapshot(
  project: LocationProject,
  shotId: string,
  timeSeconds: number,
): AgentShotTimeSample {
  const sample = sampleShotTimeline(project, shotId, timeSeconds);
  return {
    ...sample,
    camera: {
      ...sample.camera,
      position: cloneVec3(sample.camera.position),
      target: cloneVec3(sample.camera.target),
    },
    objectOverrides: structuredClone(sample.objectOverrides),
  };
}

export function listShotsSnapshot(project: LocationProject): AgentShotSummary[] {
  return project.shots.map(summarizeShot);
}

export function listLandmarksSnapshot(
  project: LocationProject,
): AgentLandmarkSummary[] {
  return project.landmarks.map((landmark) => ({
    id: landmark.id,
    name: landmark.name,
    displayName: landmark.displayName,
    position: cloneVec3(landmark.position),
    linkedObjectId: landmark.linkedObjectId,
    visible: landmark.visible,
  }));
}

export type ResolveTargetResult =
  | { ok: true; id: string }
  | { ok: false; diagnostics: AgentDiagnostic[] };

/**
 * Resolve an entity target against existing project entities.
 * Plan-local `{ ref }` targets are rejected until the plan compiler exists.
 * Name queries that match multiple entities return `ambiguous_target`.
 */
export function resolveExistingObjectTarget(
  project: LocationProject,
  target: AgentEntityTarget,
): ResolveTargetResult {
  if ('id' in target && typeof target.id === 'string') {
    const found = project.scene.objects.some((object) => object.id === target.id);
    if (!found) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No object with id "${target.id}".`,
            { path: 'object.id' },
          ),
        ],
      };
    }
    return { ok: true, id: target.id };
  }

  if ('ref' in target) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.notImplemented,
          'Plan-local refs are only resolvable during plan preparation.',
          { path: 'object.ref' },
        ),
      ],
    };
  }

  if ('query' in target) {
    const matches = listObjectsSnapshot(project, target.query);
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            'No object matched the query.',
            { path: 'object.query' },
          ),
        ],
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.ambiguousTarget,
            `Object query matched ${matches.length} entities; refine the query.`,
            {
              path: 'object.query',
              candidates: matches.map((match) => match.id),
            },
          ),
        ],
      };
    }
    return { ok: true, id: matches[0]!.id };
  }

  return {
    ok: false,
    diagnostics: [
      agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'Object target must include id, ref, or query.',
        { path: 'object' },
      ),
    ],
  };
}

export function resolveExistingShotTarget(
  project: LocationProject,
  target: AgentEntityTarget,
): ResolveTargetResult {
  if ('id' in target && typeof target.id === 'string') {
    const found = project.shots.some((shot) => shot.id === target.id);
    if (!found) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No shot with id "${target.id}".`,
            { path: 'shot.id' },
          ),
        ],
      };
    }
    return { ok: true, id: target.id };
  }

  if ('ref' in target) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.notImplemented,
          'Plan-local refs are only resolvable during plan preparation.',
          { path: 'shot.ref' },
        ),
      ],
    };
  }

  if ('query' in target) {
    const match = target.query.match ?? 'contains';
    const name = target.query.name;
    const matches = project.shots.filter((shot) => {
      if (name === undefined) return true;
      return nameMatches(shot.name, name, match);
    });
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            'No shot matched the query.',
            { path: 'shot.query' },
          ),
        ],
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.ambiguousTarget,
            `Shot query matched ${matches.length} entities; refine the query.`,
            {
              path: 'shot.query',
              candidates: matches.map((shot) => shot.id),
            },
          ),
        ],
      };
    }
    return { ok: true, id: matches[0]!.id };
  }

  return {
    ok: false,
    diagnostics: [
      agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'Shot target must include id, ref, or query.',
        { path: 'shot' },
      ),
    ],
  };
}

export function resolveExistingLandmarkTarget(
  project: LocationProject,
  target: AgentEntityTarget,
): ResolveTargetResult {
  if ('id' in target && typeof target.id === 'string') {
    const found = project.landmarks.some((landmark) => landmark.id === target.id);
    if (!found) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No landmark with id "${target.id}".`,
            { path: 'landmark.id' },
          ),
        ],
      };
    }
    return { ok: true, id: target.id };
  }

  if ('ref' in target) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.notImplemented,
          'Plan-local refs are only resolvable during plan preparation.',
          { path: 'landmark.ref' },
        ),
      ],
    };
  }

  if ('query' in target) {
    const match = target.query.match ?? 'contains';
    const name = target.query.name;
    const matches = project.landmarks.filter((landmark) => {
      if (name === undefined) return true;
      return nameMatches(landmark.name, name, match)
        || (landmark.displayName ? nameMatches(landmark.displayName, name, match) : false);
    });
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            'No landmark matched the query.',
            { path: 'landmark.query' },
          ),
        ],
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.ambiguousTarget,
            `Landmark query matched ${matches.length} entities; refine the query.`,
            {
              path: 'landmark.query',
              candidates: matches.map((landmark) => landmark.id),
            },
          ),
        ],
      };
    }
    return { ok: true, id: matches[0]!.id };
  }

  return {
    ok: false,
    diagnostics: [
      agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'Landmark target must include id, ref, or query.',
        { path: 'landmark' },
      ),
    ],
  };
}
