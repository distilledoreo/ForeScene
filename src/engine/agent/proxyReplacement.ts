/**
 * Deterministic proxy-to-model replacement planning.
 *
 * The planner consumes full Shot documents (rather than inspection summaries),
 * so transform, visibility, and keyframe staging are copied without guessing.
 */

import type {
  LocationProject,
  SceneObject,
  Shot,
  ShotObjectOverride,
} from '../../domain/types';
import { projectFingerprint } from './planDiff';
import type { ForeSceneAgentCommand, ForeSceneAgentPlan } from './protocol';

export interface ProxyReplacementPlanInput {
  project: LocationProject;
  /** Full copies retrieved via `window.foreScene.getShotDocument()`. */
  shotDocuments: readonly Shot[];
  proxyObjectId: string;
  replacementObjectId: string;
  /** Internal ids or production shot numbers (for example `08`). */
  requestedShotIds?: readonly string[];
}

export interface ProxyReplacementAffectedShot {
  id: string;
  shotNumber: string;
  keyframeIds: string[];
}

export type ProxyReplacementPlanResult =
  | {
      ok: true;
      plan: ForeSceneAgentPlan;
      affectedShots: ProxyReplacementAffectedShot[];
    }
  | { ok: false; errors: string[] };

export interface ProxyReplacementVerificationInput {
  beforeProject: LocationProject;
  afterProject: LocationProject;
  proxyObjectId: string;
  replacementObjectId: string;
  affectedShots: readonly ProxyReplacementAffectedShot[];
}

export interface ProxyReplacementVerificationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Build one atomic Agent plan that swaps every known proxy staging occurrence.
 * It deliberately does not apply the plan; callers must preview it first.
 */
export function createProxyReplacementPlan(
  input: ProxyReplacementPlanInput,
): ProxyReplacementPlanResult {
  const proxy = input.project.scene.objects.find((object) => object.id === input.proxyObjectId);
  const replacement = input.project.scene.objects.find((object) => object.id === input.replacementObjectId);
  if (!proxy) return { ok: false, errors: [`Proxy object "${input.proxyObjectId}" was not found.`] };
  if (!replacement) return { ok: false, errors: [`Replacement object "${input.replacementObjectId}" was not found.`] };
  if (proxy.id === replacement.id) return { ok: false, errors: ['Proxy and replacement must be different objects.'] };
  if (replacement.type !== 'imported_model') {
    return { ok: false, errors: [`Replacement "${replacement.name}" must be an imported model.`] };
  }

  const documents = new Map(input.shotDocuments.map((shot) => [shot.id, shot]));
  const missingDocuments = input.project.shots
    .filter((shot) => !documents.has(shot.id))
    .map((shot) => shot.shotNumber);
  if (missingDocuments.length > 0) {
    return { ok: false, errors: [`Full shot documents were not provided for: ${missingDocuments.join(', ')}.`] };
  }

  const allAffected = input.project.shots
    .map((summary) => documents.get(summary.id)!)
    .filter((shot) => shotStagesObject(shot, proxy.id));
  if (allAffected.length === 0) {
    return { ok: false, errors: [`Proxy "${proxy.name}" is not staged or animated in any shot.`] };
  }

  const selected = resolveRequestedShots(input.project, input.requestedShotIds);
  if (!selected.ok) return selected;
  const selectedIds = new Set(selected.shots.map((shot) => shot.id));
  const omitted = allAffected.filter((shot) => !selectedIds.has(shot.id));
  if (omitted.length > 0) {
    return {
      ok: false,
      errors: [`Requested shots omit proxy staging in: ${omitted.map((shot) => shot.shotNumber).join(', ')}.`],
    };
  }
  const requestedWithoutProxy = selected.shots.filter((shot) => !allAffected.some((affected) => affected.id === shot.id));
  if (input.requestedShotIds && input.requestedShotIds.length > 0 && requestedWithoutProxy.length > 0) {
    return {
      ok: false,
      errors: [`Requested shots do not stage the proxy: ${requestedWithoutProxy.map((shot) => shot.shotNumber).join(', ')}.`],
    };
  }

  const affected = allAffected.filter((shot) => selectedIds.has(shot.id));
  const commands: ForeSceneAgentCommand[] = [
    {
      op: 'object.update',
      object: { id: replacement.id },
      updates: { transform: cloneTransform(proxy), visible: true },
    },
    {
      op: 'object.update',
      object: { id: proxy.id },
      updates: { visible: false },
    },
  ];

  for (const shot of affected) {
    appendStagingPair(commands, {
      shotId: shot.id,
      proxyId: proxy.id,
      replacementId: replacement.id,
      source: shot.objectOverrides?.[proxy.id],
    });
    for (const keyframe of shot.cameraKeyframes) {
      const source = keyframe.objectOverrides?.[proxy.id];
      if (!source) continue;
      appendKeyframeStagingPair(commands, {
        shotId: shot.id,
        keyframeId: keyframe.id,
        proxyId: proxy.id,
        replacementId: replacement.id,
        source,
      });
    }
  }

  return {
    ok: true,
    plan: {
      version: 1,
      planId: `proxy-replacement-${proxy.id}-${replacement.id}`,
      description: `Replace proxy ${proxy.name} with ${replacement.name}`,
      expectedFingerprint: projectFingerprint(input.project),
      commands,
    },
    affectedShots: affected.map((shot) => ({
      id: shot.id,
      shotNumber: shot.shotNumber,
      keyframeIds: shot.cameraKeyframes
        .filter((keyframe) => Boolean(keyframe.objectOverrides?.[proxy.id]))
        .map((keyframe) => keyframe.id),
    })),
  };
}

function resolveRequestedShots(
  project: LocationProject,
  requested: readonly string[] | undefined,
): { ok: true; shots: Shot[] } | { ok: false; errors: string[] } {
  if (!requested || requested.length === 0) return { ok: true, shots: [...project.shots] };
  const shots: Shot[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const identifier of requested) {
    const shot = project.shots.find((candidate) => candidate.id === identifier || candidate.shotNumber === identifier);
    if (!shot) {
      unresolved.push(identifier);
      continue;
    }
    if (!seen.has(shot.id)) {
      seen.add(shot.id);
      shots.push(shot);
    }
  }
  if (unresolved.length > 0) return { ok: false, errors: [`Unknown shot identifiers: ${unresolved.join(', ')}.`] };
  return { ok: true, shots };
}

function shotStagesObject(shot: Shot, objectId: string): boolean {
  return Boolean(shot.objectOverrides?.[objectId])
    || shot.cameraKeyframes.some((keyframe) => Boolean(keyframe.objectOverrides?.[objectId]));
}

function cloneTransform(object: Pick<SceneObject, 'transform'>) {
  return {
    position: [...object.transform.position] as [number, number, number],
    rotation: [...object.transform.rotation] as [number, number, number],
    scale: [...object.transform.scale] as [number, number, number],
  };
}

function stageInput(source: ShotObjectOverride, visible: boolean) {
  return {
    ...(source.transform ? { transform: structuredClone(source.transform) } : {}),
    ...(source.humanPose ? { humanPose: structuredClone(source.humanPose) } : {}),
    visible,
  };
}

function appendStagingPair(
  commands: ForeSceneAgentCommand[],
  params: {
    shotId: string;
    proxyId: string;
    replacementId: string;
    source?: ShotObjectOverride;
  },
): void {
  const source = params.source ?? {};
  commands.push(
    {
      op: 'shot.stageObject',
      shot: { id: params.shotId },
      object: { id: params.replacementId },
      ...stageInput(source, true),
    },
    {
      op: 'shot.stageObject',
      shot: { id: params.shotId },
      object: { id: params.proxyId },
      ...stageInput(source, false),
    },
  );
}

function appendKeyframeStagingPair(
  commands: ForeSceneAgentCommand[],
  params: {
    shotId: string;
    keyframeId: string;
    proxyId: string;
    replacementId: string;
    source: ShotObjectOverride;
  },
): void {
  commands.push(
    {
      op: 'shot.keyframe.stageObject',
      shot: { id: params.shotId },
      keyframe: { id: params.keyframeId },
      object: { id: params.replacementId },
      ...stageInput(params.source, true),
    },
    {
      op: 'shot.keyframe.stageObject',
      shot: { id: params.shotId },
      keyframe: { id: params.keyframeId },
      object: { id: params.proxyId },
      ...stageInput(params.source, false),
    },
  );
}

/** Verify only the intended replacement changed; preserve cameras and timelines. */
export function verifyProxyReplacement(
  input: ProxyReplacementVerificationInput,
): ProxyReplacementVerificationResult {
  const errors: string[] = [];
  const before = input.beforeProject;
  const after = input.afterProject;
  if (after.id !== before.id) errors.push('Project id changed during replacement.');
  if (!sameIds(before.shots, after.shots)) errors.push('Shot ids changed during replacement.');
  if (!sameIds(before.panoRefs, after.panoRefs)) errors.push('Panorama ids changed during replacement.');
  if (!sameIds(before.scene.objects, after.scene.objects)) errors.push('Scene object ids changed during replacement.');

  const beforeProxy = before.scene.objects.find((object) => object.id === input.proxyObjectId);
  const afterProxy = after.scene.objects.find((object) => object.id === input.proxyObjectId);
  const beforeReplacement = before.scene.objects.find((object) => object.id === input.replacementObjectId);
  const afterReplacement = after.scene.objects.find((object) => object.id === input.replacementObjectId);
  if (!beforeProxy || !afterProxy || !beforeReplacement || !afterReplacement) {
    errors.push('Proxy or replacement object could not be reread after apply.');
    return { ok: false, errors };
  }
  if (!sameJson(afterReplacement.transform, beforeProxy.transform)) {
    errors.push('Replacement global transform does not match the proxy transform.');
  }
  if (afterProxy.visible !== false || afterReplacement.visible !== true) {
    errors.push('Proxy/replacement global visibility is not hidden/shown.');
  }

  const affectedById = new Map(input.affectedShots.map((shot) => [shot.id, shot]));
  for (const beforeShot of before.shots) {
    const afterShot = after.shots.find((shot) => shot.id === beforeShot.id);
    if (!afterShot) continue;
    if (!sameJson(beforeShot.camera, afterShot.camera)) {
      errors.push(`Camera changed for shot ${beforeShot.shotNumber}.`);
    }
    if (!sameIds(beforeShot.cameraKeyframes, afterShot.cameraKeyframes)) {
      errors.push(`Timeline keyframes changed for shot ${beforeShot.shotNumber}.`);
      continue;
    }
    for (const beforeKeyframe of beforeShot.cameraKeyframes) {
      const afterKeyframe = afterShot.cameraKeyframes.find((keyframe) => keyframe.id === beforeKeyframe.id);
      if (!afterKeyframe) continue;
      if (!sameJson(stripKeyframeOverrides(beforeKeyframe), stripKeyframeOverrides(afterKeyframe))) {
        errors.push(`Timeline camera data changed for shot ${beforeShot.shotNumber}, keyframe ${beforeKeyframe.id}.`);
      }
    }

    const affected = affectedById.get(beforeShot.id);
    if (!affected) {
      if (!sameJson(beforeShot.objectOverrides, afterShot.objectOverrides)) {
        errors.push(`Staging changed for unaffected shot ${beforeShot.shotNumber}.`);
      }
      for (const beforeKeyframe of beforeShot.cameraKeyframes) {
        const afterKeyframe = afterShot.cameraKeyframes.find((keyframe) => keyframe.id === beforeKeyframe.id);
        if (afterKeyframe && !sameJson(beforeKeyframe.objectOverrides, afterKeyframe.objectOverrides)) {
          errors.push(`Keyframe staging changed for unaffected shot ${beforeShot.shotNumber}, keyframe ${beforeKeyframe.id}.`);
        }
      }
      continue;
    }
    if (!sameJson(
      stripObjectPair(beforeShot.objectOverrides, input.proxyObjectId, input.replacementObjectId),
      stripObjectPair(afterShot.objectOverrides, input.proxyObjectId, input.replacementObjectId),
    )) {
      errors.push(`Unrelated staging changed for shot ${beforeShot.shotNumber}.`);
    }
    verifyStagingPair({
      errors,
      label: `shot ${beforeShot.shotNumber}`,
      source: beforeShot.objectOverrides?.[input.proxyObjectId],
      proxy: afterShot.objectOverrides?.[input.proxyObjectId],
      replacement: afterShot.objectOverrides?.[input.replacementObjectId],
      proxyVisible: effectiveVisible(afterProxy, afterShot.objectOverrides?.[input.proxyObjectId]),
      replacementVisible: effectiveVisible(afterReplacement, afterShot.objectOverrides?.[input.replacementObjectId]),
      allowMissingSource: affected.keyframeIds.length > 0,
    });
    for (const keyframeId of affected.keyframeIds) {
      const sourceKeyframe = beforeShot.cameraKeyframes.find((keyframe) => keyframe.id === keyframeId);
      const afterKeyframe = afterShot.cameraKeyframes.find((keyframe) => keyframe.id === keyframeId);
      if (!sourceKeyframe || !afterKeyframe) {
        errors.push(`Keyframe ${keyframeId} could not be reread for shot ${beforeShot.shotNumber}.`);
        continue;
      }
      if (!sameJson(
        stripObjectPair(sourceKeyframe.objectOverrides, input.proxyObjectId, input.replacementObjectId),
        stripObjectPair(afterKeyframe.objectOverrides, input.proxyObjectId, input.replacementObjectId),
      )) {
        errors.push(`Unrelated keyframe staging changed for shot ${beforeShot.shotNumber}, keyframe ${keyframeId}.`);
      }
      verifyStagingPair({
        errors,
        label: `shot ${beforeShot.shotNumber}, keyframe ${keyframeId}`,
        source: sourceKeyframe.objectOverrides?.[input.proxyObjectId],
        proxy: afterKeyframe.objectOverrides?.[input.proxyObjectId],
        replacement: afterKeyframe.objectOverrides?.[input.replacementObjectId],
        proxyVisible: effectiveVisible(afterProxy, afterKeyframe.objectOverrides?.[input.proxyObjectId]),
        replacementVisible: effectiveVisible(afterReplacement, afterKeyframe.objectOverrides?.[input.replacementObjectId]),
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function verifyStagingPair(params: {
  errors: string[];
  label: string;
  source?: ShotObjectOverride;
  proxy?: ShotObjectOverride;
  replacement?: ShotObjectOverride;
  proxyVisible: boolean;
  replacementVisible: boolean;
  allowMissingSource?: boolean;
}): void {
  if (!params.source) {
    if (!params.allowMissingSource) {
      params.errors.push(`Proxy source staging was missing for ${params.label}.`);
      return;
    }
  } else {
    if (!sameJson(params.proxy?.transform, params.source.transform)) {
      params.errors.push(`Proxy transform was not retained for ${params.label}.`);
    }
    if (!sameJson(params.replacement?.transform, params.source.transform)) {
      params.errors.push(`Replacement transform was not copied for ${params.label}.`);
    }
    if (!sameJson(params.proxy?.humanPose, params.source.humanPose)) {
      params.errors.push(`Proxy pose changed for ${params.label}.`);
    }
    if (!sameJson(params.replacement?.humanPose, params.source.humanPose)) {
      params.errors.push(`Replacement pose was not copied for ${params.label}.`);
    }
  }
  if (params.proxyVisible || !params.replacementVisible) {
    params.errors.push(`Proxy/replacement visibility is wrong for ${params.label}.`);
  }
}

function effectiveVisible(object: SceneObject, override: ShotObjectOverride | undefined): boolean {
  return override?.visible ?? object.visible;
}

function stripKeyframeOverrides(keyframe: Shot['cameraKeyframes'][number]) {
  const { objectOverrides: _objectOverrides, ...withoutObjectOverrides } = keyframe;
  return withoutObjectOverrides;
}

function stripObjectPair(
  overrides: Shot['objectOverrides'],
  proxyObjectId: string,
  replacementObjectId: string,
) {
  if (!overrides) return overrides;
  const next = { ...overrides };
  delete next[proxyObjectId];
  delete next[replacementObjectId];
  return Object.keys(next).length > 0 ? next : undefined;
}

function sameIds<T extends { id: string }>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value.id === right[index]?.id);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
