/**
 * Shot-list batch compiler — semantic shots → Agent API plans.
 */

import type { ForeSceneAgentCommand, ForeSceneAgentPlan } from '../agent/protocol';
import type { Vec3 } from '../../domain/types';
import {
  aspectRatioValue,
  type PrevisProductionManifestV1,
  type PrevisShotDefinition,
} from './manifest';
import { previsError, previsWarning, type PrevisDiagnostic } from './manifestDiagnostics';
import {
  characterById,
  previsRef,
  type CompiledProductionContext,
} from './locationCompiler';
import { solveBlockingBatch } from './blockingSolver';
import {
  solveShotCamera,
  subjectBoundsFromPlacement,
  type SubjectBounds,
} from './cameraSolver';
import { validateShotDefinition } from './shotValidator';
import { resolvePrevisPosePresetId } from './posePresets';
import { defaultPropDimensions } from './propDimensions';

export { defaultPropDimensions } from './propDimensions';

export const PREVIS_SHOT_BATCH_SIZE = 5;

export interface CompiledShotBatch {
  batchIndex: number;
  shotNumbers: string[];
  plan: ForeSceneAgentPlan;
  diagnostics: PrevisDiagnostic[];
  /** Per-shot compile outcomes for run-state. */
  shotResults: Record<string, {
    ok: boolean;
    warnings: string[];
    camera?: { position: Vec3; target: Vec3; fovDegrees: number };
  }>;
}

export function compileShotList(
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
  options: {
    batchSize?: number;
    /** Skip shot numbers already compiled in run-state. */
    skipShotNumbers?: Set<string>;
    /** Existing live shot ids keyed by shot number — compile as upsert instead of create. */
    existingShotIds?: Record<string, string>;
  } = {},
): CompiledShotBatch[] {
  const batchSize = options.batchSize ?? PREVIS_SHOT_BATCH_SIZE;
  const skip = options.skipShotNumbers ?? new Set<string>();
  const pending = manifest.shots.filter((shot) => !skip.has(shot.shotNumber));
  const batches: CompiledShotBatch[] = [];

  for (let index = 0; index < pending.length; index += batchSize) {
    const slice = pending.slice(index, index + batchSize);
    batches.push(compileShotBatch(manifest, context, slice, batches.length, {
      existingShotIds: options.existingShotIds,
    }));
  }

  return batches;
}

export function compileShotBatch(
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
  shots: PrevisShotDefinition[],
  batchIndex: number,
  options: {
    existingShotIds?: Record<string, string>;
  } = {},
): CompiledShotBatch {
  const diagnostics: PrevisDiagnostic[] = [];
  const commands: ForeSceneAgentCommand[] = [];
  const shotResults: CompiledShotBatch['shotResults'] = {};
  const aspect = aspectRatioValue(manifest.project.aspectRatio);

  for (const shot of shots) {
    const path = `shots[id=${shot.id}]`;
    const structural = validateShotDefinition(shot, manifest, context, path);
    if (structural.length > 0) {
      diagnostics.push(...structural);
      shotResults[shot.shotNumber] = {
        ok: false,
        warnings: structural.map((item) => item.message),
      };
      continue;
    }

    try {
      const compiled = compileSingleShot(shot, manifest, context, aspect, {
        existingShotId: options.existingShotIds?.[shot.shotNumber],
      });
      diagnostics.push(...compiled.diagnostics);
      commands.push(...compiled.commands);
      shotResults[shot.shotNumber] = {
        ok: compiled.ok,
        warnings: compiled.warnings,
        camera: compiled.camera
          ? {
              position: compiled.camera.position,
              target: compiled.camera.target,
              fovDegrees: compiled.camera.fovDegrees,
            }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(previsError('shot_compile_failed', message, {
        path,
        entityId: shot.id,
      }));
      shotResults[shot.shotNumber] = { ok: false, warnings: [message] };
    }
  }

  const first = shots[0]?.shotNumber ?? '000';
  const last = shots[shots.length - 1]?.shotNumber ?? first;

  return {
    batchIndex,
    shotNumbers: shots.map((shot) => shot.shotNumber),
    plan: {
      version: 1,
      planId: `previs-shots-${first}-${last}`.slice(0, 80),
      description: `Previs shots ${first}–${last}`,
      commands,
    },
    diagnostics,
    shotResults,
  };
}

function compileSingleShot(
  shot: PrevisShotDefinition,
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
  aspectRatio: number,
  options: { existingShotId?: string } = {},
): {
  ok: boolean;
  commands: ForeSceneAgentCommand[];
  diagnostics: PrevisDiagnostic[];
  warnings: string[];
  camera?: { position: Vec3; target: Vec3; fovDegrees: number };
} {
  const diagnostics: PrevisDiagnostic[] = [];
  const warnings: string[] = [];
  const commands: ForeSceneAgentCommand[] = [];
  const anchors = context.locationAnchors[shot.locationId] ?? {};
  const zoneOrigin = context.locationOrigins[shot.locationId] ?? [0, 0, 0];

  // Default subject parking at location center if no blocking provided.
  const subjectPositions: Record<string, Vec3> = {};
  for (const subjectId of shot.subjects) {
    const center = anchors.center ?? zoneOrigin;
    subjectPositions[subjectId] = [center[0], 0, center[2]];
  }

  const blockingResults = solveBlockingBatch(shot.blocking ?? defaultBlocking(shot, anchors), {
    anchors,
    subjects: {},
  });

  for (const [subjectId, result] of Object.entries(blockingResults)) {
    subjectPositions[subjectId] = result.position;
    warnings.push(...result.warnings);
  }

  // Ensure camera subjects have positions even without blocking entries.
  for (const subjectId of new Set([...shot.subjects, ...shot.camera.subjects])) {
    if (!subjectPositions[subjectId]) {
      const center = anchors.center ?? zoneOrigin;
      subjectPositions[subjectId] = [center[0], 0, center[2]];
    }
  }

  const subjectBounds: SubjectBounds[] = Object.entries(subjectPositions).map(([id, position]) => {
    const character = characterById(manifest, id);
    const prop = (manifest.props ?? []).find((item) => item.id === id);
    const blocking = blockingResults[id];
    // Yaw from staging rotation (Y axis degrees → radians).
    const yawRadians = blocking?.rotation
      ? (blocking.rotation[1] * Math.PI) / 180
      : undefined;
    if (character) {
      return subjectBoundsFromPlacement({
        id,
        position,
        height: character.height ?? 1.75,
        width: 0.55,
        depth: 0.55,
        yawRadians,
      });
    }
    if (prop) {
      const dims = prop.dimensions ?? defaultPropDimensions(prop.primitive);
      return subjectBoundsFromPlacement({
        id,
        position,
        width: dims[0],
        height: dims[1],
        depth: dims[2],
        yawRadians,
      });
    }
    return subjectBoundsFromPlacement({ id, position, height: 1.75, yawRadians });
  });

  const locationBlockers = resolveLocationBlockers(
    context,
    shot.locationId,
  );
  const cameraSolve = solveShotCamera({
    shot,
    subjects: subjectBounds,
    aspectRatio,
    blockers: locationBlockers.map((box) => ({
      id: box.objectId,
      min: box.min,
      max: box.max,
    })),
  });
  warnings.push(...cameraSolve.warnings);
  if (cameraSolve.notes?.includes('wall_hidden_for_camera') || (cameraSolve.hideBlockerIds?.length ?? 0) > 0) {
    warnings.push('wall_hidden_for_camera');
  }

  if (
    !Number.isFinite(cameraSolve.camera.position[0])
    || !Number.isFinite(cameraSolve.camera.target[0])
    || !Number.isFinite(cameraSolve.camera.fovDegrees)
  ) {
    diagnostics.push(previsError(
      'camera_non_finite',
      `Shot ${shot.shotNumber} produced a non-finite camera.`,
      { entityId: shot.id },
    ));
    return { ok: false, commands: [], diagnostics, warnings };
  }

  const shotRef = previsRef('shot', shot.shotNumber);
  const existingId = options.existingShotId;
  const shotTarget: { id: string } | { ref: string } = existingId
    ? { id: existingId }
    : { ref: shotRef };

  if (existingId) {
    commands.push({
      op: 'shot.rename',
      shot: shotTarget,
      name: shot.name,
    });
    commands.push({
      op: 'shot.updateDescription',
      shot: shotTarget,
      description: shot.description,
    });
    commands.push({
      op: 'shot.updateCamera',
      shot: shotTarget,
      camera: {
        position: cameraSolve.camera.position,
        target: cameraSolve.camera.target,
        fovDegrees: cameraSolve.camera.fovDegrees,
        aspectRatio: cameraSolve.camera.aspectRatio,
        near: cameraSolve.camera.near,
        far: cameraSolve.camera.far,
      },
    });
    commands.push({
      op: 'shot.clearStaging',
      shot: shotTarget,
    });
  } else {
    commands.push({
      op: 'shot.create',
      ref: shotRef,
      shot: {
        name: shot.name,
        description: shot.description,
        shotNumber: shot.shotNumber,
        productionShotId: shot.shotNumber,
        camera: {
          position: cameraSolve.camera.position,
          target: cameraSolve.camera.target,
          fovDegrees: cameraSolve.camera.fovDegrees,
          aspectRatio: cameraSolve.camera.aspectRatio,
          near: cameraSolve.camera.near,
          far: cameraSolve.camera.far,
        },
      },
    });
  }

  // Visibility: participants listed only in shot.subjects may be staged off-camera
  // (e.g. medium of Alex while Blair remains a scene participant but not visible).
  // Prefer explicit requirements.visibleSubjects when present.
  const requiredVisible = shot.requirements?.visibleSubjects ?? shot.subjects;
  const visibleIds = new Set([
    ...requiredVisible,
    ...shot.camera.subjects,
    ...(shot.camera.foregroundSubject ? [shot.camera.foregroundSubject] : []),
    ...(shot.requirements?.visibleProps ?? []),
  ]);

  for (const character of manifest.cast) {
    const objectTarget = resolveEntityTarget(
      context.entities[`cast.${character.id}`]?.objectId,
      previsRef('cast', character.id),
    );
    const isParticipant = shot.subjects.includes(character.id)
      || visibleIds.has(character.id);
    const isVisible = visibleIds.has(character.id);
    const blocking = blockingResults[character.id];
    const pose = blocking?.posePreset
      ?? (character.defaultPose ? resolvePrevisPosePresetId(character.defaultPose) : undefined);

    if (isParticipant) {
      const position = subjectPositions[character.id] ?? [zoneOrigin[0], 0, zoneOrigin[2]];
      const rotation = blocking?.rotation ?? [0, 0, 0];
      // Staging transform uses object center Y for humans: height/2 above floor contact.
      const height = character.height ?? 1.75;
      commands.push({
        op: 'shot.stageObject',
        shot: shotTarget,
        object: objectTarget,
        visible: isVisible,
        transform: {
          position: [position[0], height / 2, position[2]],
          rotation,
          scale: [1, 1, 1],
        },
        ...(pose ? { posePreset: pose } : {}),
      });
    } else {
      commands.push({
        op: 'shot.stageObject',
        shot: shotTarget,
        object: objectTarget,
        visible: false,
      });
    }
  }

  for (const prop of manifest.props ?? []) {
    const objectTarget = resolveEntityTarget(
      context.entities[`props.${prop.id}`]?.objectId,
      previsRef('prop', prop.id),
    );
    const inShot = visibleIds.has(prop.id);
    const blocking = blockingResults[prop.id];
    if (inShot) {
      const position = subjectPositions[prop.id] ?? [zoneOrigin[0], 0, zoneOrigin[2]];
      const dims = prop.dimensions ?? defaultPropDimensions(prop.primitive);
      commands.push({
        op: 'shot.stageObject',
        shot: shotTarget,
        object: objectTarget,
        visible: true,
        transform: {
          position: [position[0], dims[1] / 2, position[2]],
          rotation: blocking?.rotation ?? [0, 0, 0],
          scale: [1, 1, 1],
        },
      });
    } else {
      commands.push({
        op: 'shot.stageObject',
        shot: shotTarget,
        object: objectTarget,
        visible: false,
      });
    }
  }

  // Hide inactive location geometry via staging when possible — location objects
  // are architecture (stagingRole set). Stage visibility for other locations' floors etc.
  for (const location of manifest.locations) {
    const entity = context.entities[`locations.${location.id}`];
    if (!entity?.objectIds?.length) continue;
    const active = location.id === shot.locationId;
    for (const objectToken of entity.objectIds) {
      // Only hide non-active location set pieces; keep them in build.
      if (!active) {
        commands.push({
          op: 'shot.stageObject',
          shot: shotTarget,
          object: resolveEntityTarget(objectToken, objectToken),
          visible: false,
        });
      }
    }
  }

  // Apply wall-hide overrides from the camera solver so scored compositions match renders.
  const hideBlockerIds = new Set(cameraSolve.hideBlockerIds ?? []);
  for (const blockerId of hideBlockerIds) {
    if (!blockerId) continue;
    commands.push({
      op: 'shot.stageObject',
      shot: shotTarget,
      object: resolveEntityTarget(blockerId, blockerId),
      visible: false,
    });
  }

  if (shot.motion) {
    commands.push({
      op: 'shot.timeline.replace',
      shot: shotTarget,
      durationSeconds: shot.motion.durationSeconds,
      keyframes: shot.motion.keyframes.map((keyframe) => ({
        timeSeconds: keyframe.timeSeconds,
        camera: keyframe.camera ?? {},
        objects: keyframe.staging?.map((staging) => ({
          object: resolveEntityTarget(
            context.entities[`cast.${staging.subject}`]?.objectId
              ?? context.entities[`props.${staging.subject}`]?.objectId,
            previsRef(manifest.cast.some((item) => item.id === staging.subject) ? 'cast' : 'prop', staging.subject),
          ),
          ...(staging.visible !== undefined ? { visible: staging.visible } : {}),
          ...(staging.transform ? {
            transform: {
              position: staging.transform.position ?? [0, 0, 0],
              rotation: staging.transform.rotation ?? [0, 0, 0],
              scale: staging.transform.scale ?? [1, 1, 1],
            },
          } : {}),
          ...(staging.posePreset ? { posePreset: staging.posePreset } : {}),
        })),
      })),
    });
  }

  commands.push({
    op: 'shot.select',
    shot: shotTarget,
  });

  for (const warning of warnings) {
    diagnostics.push(previsWarning('shot_compile_warning', warning, { entityId: shot.id }));
  }

  return {
    ok: true,
    commands,
    diagnostics,
    warnings,
    camera: {
      position: cameraSolve.camera.position,
      target: cameraSolve.camera.target,
      fovDegrees: cameraSolve.camera.fovDegrees,
    },
  };
}

function defaultBlocking(
  shot: PrevisShotDefinition,
  anchors: Record<string, Vec3>,
) {
  const center = anchors.center;
  if (!center) return [];
  const slots = ['center', 'left', 'right', 'foreground', 'background'] as const;
  return shot.subjects.map((subject, index) => ({
    subject,
    placement: {
      type: 'location_slot' as const,
      slot: slots[index % slots.length]!,
    },
  }));
}

/**
 * Prefer a real object id when the run-state has resolved one after apply.
 * Fall back to a plan-local ref for same-plan compiles / previews.
 */
function resolveEntityTarget(
  stored: string | undefined,
  fallbackRef: string,
): { id: string } | { ref: string } {
  if (stored && looksLikeEntityId(stored)) return { id: stored };
  if (stored && !looksLikeEntityId(stored)) return { ref: stored };
  return { ref: fallbackRef };
}

/**
 * Map location blocker plan-refs to live object ids via entity.refs when available.
 */
function resolveLocationBlockers(
  context: CompiledProductionContext,
  locationId: string,
): Array<{ objectId: string; min: Vec3; max: Vec3; type?: string }> {
  const raw = context.locationBlockers[locationId] ?? [];
  const entity = context.entities[`locations.${locationId}`];
  const refMap = entity?.refs ?? {};
  return raw.map((box) => {
    const resolved = refMap[box.objectId] ?? box.objectId;
    return {
      objectId: resolved,
      min: box.min,
      max: box.max,
      type: box.type,
    };
  });
}

function looksLikeEntityId(value: string): boolean {
  // createId() uses prefixes like "obj_", "shot_", "lm_" plus random chars.
  // Plan refs we generate are loc_/cast_/prop_/shot_ with manifest ids.
  // Real store ids from createId are typically longer and include a random suffix.
  return /^(obj|object|shot|lm|landmark|asset|project|pano|keyframe)_/i.test(value)
    && value.length >= 12;
}
