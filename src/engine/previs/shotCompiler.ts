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
  } = {},
): CompiledShotBatch[] {
  const batchSize = options.batchSize ?? PREVIS_SHOT_BATCH_SIZE;
  const skip = options.skipShotNumbers ?? new Set<string>();
  const pending = manifest.shots.filter((shot) => !skip.has(shot.shotNumber));
  const batches: CompiledShotBatch[] = [];

  for (let index = 0; index < pending.length; index += batchSize) {
    const slice = pending.slice(index, index + batchSize);
    batches.push(compileShotBatch(manifest, context, slice, batches.length));
  }

  return batches;
}

export function compileShotBatch(
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
  shots: PrevisShotDefinition[],
  batchIndex: number,
): CompiledShotBatch {
  const diagnostics: PrevisDiagnostic[] = [];
  const commands: ForeSceneAgentCommand[] = [];
  const shotResults: CompiledShotBatch['shotResults'] = {};
  const aspect = aspectRatioValue(manifest.project.aspectRatio);

  // Hide all cast/props by default in build; visibility is per-shot staging.
  // We stage visibility per shot instead.

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
      const compiled = compileSingleShot(shot, manifest, context, aspect);
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
    return subjectBoundsFromPlacement({
      id,
      position,
      height: character?.height ?? 1.75,
    });
  });

  const cameraSolve = solveShotCamera({
    shot,
    subjects: subjectBounds,
    aspectRatio,
  });
  warnings.push(...cameraSolve.warnings);

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

  // Hide every cast/prop not in this shot; stage participants.
  const visibleIds = new Set([
    ...shot.subjects,
    ...shot.camera.subjects,
    ...(shot.camera.foregroundSubject ? [shot.camera.foregroundSubject] : []),
    ...(shot.requirements?.visibleSubjects ?? []),
    ...(shot.requirements?.visibleProps ?? []),
  ]);

  for (const character of manifest.cast) {
    const objectTarget = resolveEntityTarget(
      context.entities[`cast.${character.id}`]?.objectId,
      previsRef('cast', character.id),
    );
    const inShot = visibleIds.has(character.id);
    const blocking = blockingResults[character.id];
    const pose = blocking?.posePreset
      ?? (character.defaultPose ? resolvePrevisPosePresetId(character.defaultPose) : undefined);

    if (inShot) {
      const position = subjectPositions[character.id] ?? [zoneOrigin[0], 0, zoneOrigin[2]];
      const rotation = blocking?.rotation ?? [0, 0, 0];
      // Staging transform uses object center Y for humans: height/2 above floor contact.
      const height = character.height ?? 1.75;
      commands.push({
        op: 'shot.stageObject',
        shot: { ref: shotRef },
        object: objectTarget,
        visible: true,
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
        shot: { ref: shotRef },
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
      const dims = prop.dimensions ?? [0.6, 0.6, 0.6];
      commands.push({
        op: 'shot.stageObject',
        shot: { ref: shotRef },
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
        shot: { ref: shotRef },
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
          shot: { ref: shotRef },
          object: resolveEntityTarget(objectToken, objectToken),
          visible: false,
        });
      }
    }
  }

  commands.push({
    op: 'shot.select',
    shot: { ref: shotRef },
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

function looksLikeEntityId(value: string): boolean {
  // createId() uses prefixes like "obj_", "shot_", "lm_" plus random chars.
  // Plan refs we generate are loc_/cast_/prop_/shot_ with manifest ids.
  // Real store ids from createId are typically longer and include a random suffix.
  return /^(obj|object|shot|lm|landmark|asset|project|pano|keyframe)_/i.test(value)
    && value.length >= 12;
}

