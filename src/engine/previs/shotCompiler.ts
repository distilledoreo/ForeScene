/**
 * Shot-list batch compiler — semantic shots → Agent API plans.
 */

import type {
  AgentTimelineObjectInput,
  ForeSceneAgentCommand,
  ForeSceneAgentPlan,
} from '../agent/protocol';
import type { LocationProject, ShotPresenceContract, Transform, Vec3 } from '../../domain/types';
import { resolveManifestEntityMemberTransforms } from './manifestEntityTransforms';
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
import type { PrevisEntityMapping } from './runState';
import { solveBlockingBatch } from './blockingSolver';
import {
  solveShotCamera,
  subjectBoundsFromPlacement,
  type SubjectBounds,
} from './cameraSolver';
import { validateShotDefinition } from './shotValidator';
import { resolvePrevisPosePresetId } from './posePresets';
import {
  canInferNativeActionPose,
  inferNativeActionPose,
  inferRigidLocomotionRotation,
  isLocomotionAction,
  resolveReadableMotionCamera,
  resolveReadableMotionSubjectPosition,
} from './actionIntent';
import { defaultPropDimensions } from './propDimensions';
import {
  deriveDynamicObjectUniverse,
  getShotPresenceContract,
  resolveExpectedShotPresence,
} from './shotPresence';
import { resolveProductionPose } from './entityCapability';
import { resolveShotEnvironment } from './shotEnvironment';
import { selectionBounds } from '../buildSelection';

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
    /** Prepared project used to enforce project-wide closed-world presence. */
    presenceProject?: LocationProject;
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
      presenceProject: options.presenceProject,
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
    presenceProject?: LocationProject;
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
        presenceProject: options.presenceProject,
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
  options: { existingShotId?: string; presenceProject?: LocationProject } = {},
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
  const effectiveStaticTransforms: Record<string, {
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
  }> = {};
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

  const subjectBounds: SubjectBounds[] = Object.entries(subjectPositions).flatMap(([id, position]) => {
    const character = characterById(manifest, id);
    const prop = (manifest.props ?? []).find((item) => item.id === id);
    if (prop?.embeddedIn) return [];
    const blocking = blockingResults[id];
    // Yaw from staging rotation (Y axis degrees → radians).
    const yawRadians = blocking?.rotation
      ? (blocking.rotation[1] * Math.PI) / 180
      : undefined;
    if (character) {
      return [subjectBoundsFromPlacement({
        id,
        position,
        height: character.height ?? 1.75,
        width: 0.55,
        depth: 0.55,
        yawRadians,
      })];
    }
    if (prop) {
      const dims = prop.dimensions ?? defaultPropDimensions(prop.primitive);
      return [subjectBoundsFromPlacement({
        id,
        position,
        width: dims[0],
        height: dims[1],
        depth: dims[2],
        yawRadians,
      })];
    }
    const importedAsset = manifest.assets?.find((item) => (
      item.id === id && (item.type === 'imported_model' || item.type === 'primitive_proxy')
    ));
    if (importedAsset) {
      const assetDimensions = manifestAssetDimensions(manifest, context, options.presenceProject, id)
        ?? [1.3, 1.3, 1.3] as Vec3;
      return [subjectBoundsFromPlacement({
        id,
        // Imported-model blocking positions are floor contacts. Keep camera
        // bounds aligned with the grounded transform emitted below instead of
        // inheriting landmark marker height (commonly 1.2m).
        position: [position[0], 0, position[2]],
        width: assetDimensions[0],
        height: assetDimensions[1],
        depth: assetDimensions[2],
        yawRadians,
        requireCompleteAssembly: true,
      })];
    }
    return [subjectBoundsFromPlacement({ id, position, height: 1.75, yawRadians })];
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

  const requestedPoseBySubject = Object.fromEntries(
    (shot.blocking ?? []).flatMap((instruction) => (
      instruction.pose ? [[instruction.subject, instruction.pose]] : []
    )),
  );
  const resolveCompilerPose = (entityId: string, requestedPose: string | undefined): string | undefined => {
    if (!requestedPose) return undefined;
    if (!options.presenceProject?.workflow.production) return resolvePrevisPosePresetId(requestedPose);
    const resolution = resolveProductionPose({
      project: options.presenceProject,
      entityId,
      requestedPose,
      shotId: shot.id,
    });
    if (resolution.relationship === 'contradictory' || !resolution.resolvedPose) {
      diagnostics.push(previsError(
        'contradictory_pose_substitution',
        resolution.reason ?? `Pose "${requestedPose}" cannot be resolved for entity "${entityId}".`,
        { entityId: shot.id },
      ));
      return undefined;
    }
    if (resolution.requiresReview) {
      warnings.push(resolution.reason ?? `Pose "${requestedPose}" requires production review.`);
      diagnostics.push(previsWarning(
        'pose_substitution_needs_review',
        resolution.reason ?? `Pose "${requestedPose}" requires production review.`,
        { entityId: shot.id },
      ));
    }
    return resolution.resolvedPose;
  };

  const closedWorldPresence = resolveCompilerPresence(options.presenceProject, shot);
  if (closedWorldPresence?.diagnostics.length) {
    for (const item of closedWorldPresence.diagnostics) {
      diagnostics.push(previsError('shot_presence_invalid', item.message, {
        entityId: shot.id,
      }));
    }
    return { ok: false, commands: [], diagnostics, warnings };
  }

  const environment = options.presenceProject
    ? resolveShotEnvironment(options.presenceProject, {
      id: shot.id,
      shotNumber: shot.shotNumber,
      productionShotId: shot.shotNumber,
    })
    : undefined;
  const manifestLocation = manifest.locations.find((location) => location.id === shot.locationId);
  const manifestPanoSpecified = Boolean(manifestLocation) && (
    Object.prototype.hasOwnProperty.call(manifestLocation, 'defaultPanoId')
    || (manifestLocation?.panoIds?.length ?? 0) > 0
  );
  const manifestPanoId = manifestLocation?.defaultPanoId !== undefined
    ? manifestLocation.defaultPanoId
    : manifestLocation?.panoIds?.[0];
  if (
    manifestPanoSpecified
    && typeof manifestPanoId === 'string'
    && options.presenceProject
    && !options.presenceProject.panoRefs.some((pano) => pano.id === manifestPanoId)
  ) {
    diagnostics.push(previsError(
      'expected_panorama_missing',
      `Location "${shot.locationId}" names panorama "${manifestPanoId}", but it is not present in the live project.`,
      { entityId: shot.id },
    ));
    return { ok: false, commands: [], diagnostics, warnings };
  }
  if (environment?.diagnostics.length) {
    for (const item of environment.diagnostics) {
      diagnostics.push(item.severity === 'warning'
        ? previsWarning(item.code, item.message, { entityId: shot.id })
        : previsError(item.code, item.message, { entityId: shot.id }));
    }
    if (environment.diagnostics.some((item) => item.severity === 'error')) {
      return { ok: false, commands: [], diagnostics, warnings };
    }
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

  // Route the prepared panorama after the shot exists. This is an executable
  // plan command rather than a direct store write, so preview/apply and
  // production compilation share the same deterministic mutation path.
  if (manifestPanoSpecified || environment?.panorama) {
    commands.push({
      op: 'shot.setPanorama',
      shot: shotTarget,
      pano: manifestPanoSpecified
        ? (typeof manifestPanoId === 'string' ? { id: manifestPanoId } : null)
        : { id: environment!.panorama!.id },
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
  const shotStagingCommandStart = commands.length;

  for (const character of manifest.cast) {
    const entityMapping = context.entities[`cast.${character.id}`];
    const isParticipant = shot.subjects.includes(character.id)
      || visibleIds.has(character.id);
    const isVisible = visibleIds.has(character.id);
    const blocking = blockingResults[character.id];
    const requestedPose = requestedPoseBySubject[character.id]
      ?? character.defaultPose
      ?? (canInferNativeActionPose(character) ? inferNativeActionPose(shot, character.id) : undefined);
    const pose = resolveCompilerPose(character.id, requestedPose)
      ?? (!options.presenceProject?.workflow.production ? blocking?.posePreset : undefined);

    if (isParticipant) {
      const position = subjectPositions[character.id] ?? [zoneOrigin[0], 0, zoneOrigin[2]];
      const rotation = blocking?.rotation ?? [0, 0, 0];
      const height = character.height ?? 1.75;
      const transform = {
        position: [position[0], height / 2, position[2]] as Vec3,
        rotation: [...rotation] as Vec3,
        scale: [1, 1, 1] as Vec3,
      };
      effectiveStaticTransforms[character.id] = transform;
      appendManifestEntityStageCommands({
        commands,
        shotTarget,
        mapping: entityMapping,
        fallbackRef: previsRef('cast', character.id),
        project: options.presenceProject,
        visible: isVisible,
        transform,
        posePreset: pose,
      });
    } else {
      appendManifestEntityStageCommands({
        commands,
        shotTarget,
        mapping: entityMapping,
        fallbackRef: previsRef('cast', character.id),
        project: options.presenceProject,
        visible: false,
      });
    }
  }

  for (const prop of manifest.props ?? []) {
    const entityMapping = context.entities[`props.${prop.id}`];
    const inShot = visibleIds.has(prop.id);
    const blocking = blockingResults[prop.id];
    if (prop.embeddedIn) {
      // Visibility and transforms are owned by the host character. The prop's
      // production binding aliases that same renderable object/group.
      continue;
    }
    if (inShot) {
      const position = subjectPositions[prop.id] ?? [zoneOrigin[0], 0, zoneOrigin[2]];
      const dims = prop.dimensions ?? defaultPropDimensions(prop.primitive);
      const transform = {
        position: [position[0], dims[1] / 2, position[2]] as Vec3,
        rotation: [...(blocking?.rotation ?? [0, 0, 0])] as Vec3,
        scale: [1, 1, 1] as Vec3,
      };
      effectiveStaticTransforms[prop.id] = transform;
      appendManifestEntityStageCommands({
        commands,
        shotTarget,
        mapping: entityMapping,
        fallbackRef: previsRef('prop', prop.id),
        project: options.presenceProject,
        visible: true,
        transform,
      });
    } else {
      appendManifestEntityStageCommands({
        commands,
        shotTarget,
        mapping: entityMapping,
        fallbackRef: previsRef('prop', prop.id),
        project: options.presenceProject,
        visible: false,
      });
    }
  }

  for (const asset of manifest.assets ?? []) {
    if (asset.type !== 'imported_model' && asset.type !== 'primitive_proxy') continue;
    const entityMapping = context.entities[`assets.${asset.id}`];
    if (!entityMapping) continue;
    const inShot = shot.subjects.includes(asset.id) || visibleIds.has(asset.id);
    const blocking = blockingResults[asset.id];
    const assetDimensions = manifestAssetDimensions(manifest, context, options.presenceProject, asset.id);
    if (inShot) {
      const position = subjectPositions[asset.id] ?? [zoneOrigin[0], 0, zoneOrigin[2]];
      const transform = {
        position: [position[0], assetDimensions ? assetDimensions[1] / 2 : 0, position[2]] as Vec3,
        rotation: [...(blocking?.rotation ?? [0, 0, 0])] as Vec3,
        scale: [1, 1, 1] as Vec3,
      };
      effectiveStaticTransforms[asset.id] = transform;
      appendManifestEntityStageCommands({
        commands,
        shotTarget,
        mapping: entityMapping,
        fallbackRef: previsRef('asset', asset.id),
        project: options.presenceProject,
        visible: true,
        transform,
      });
    } else {
      appendManifestEntityStageCommands({
        commands,
        shotTarget,
        mapping: entityMapping,
        fallbackRef: previsRef('asset', asset.id),
        project: options.presenceProject,
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
  const hideBlockerIds = new Set(
    isLocomotionAction(shot) ? [] : (cameraSolve.hideBlockerIds ?? []),
  );
  for (const blockerId of hideBlockerIds) {
    if (!blockerId) continue;
    commands.push({
      op: 'shot.stageObject',
      shot: shotTarget,
      object: resolveEntityTarget(blockerId, blockerId),
      visible: false,
    });
  }

  // Close the project-wide dynamic universe after manifest staging and camera
  // wall-hide decisions. Existing prepared objects are addressed by id; newly
  // authored manifest refs remain covered by the normal cast/prop loops above.
  if (closedWorldPresence) {
    for (const objectId of closedWorldPresence.dynamicObjectIds) {
      commands.push({
        op: 'shot.stageObject',
        shot: shotTarget,
        object: { id: objectId },
        visible: closedWorldPresence.expectedVisibleObjectIds.has(objectId),
      });
    }
  }

  if (shot.motion) {
    // Timeline object snapshots are absolute. Seed every keyframe with the
    // shot's authored static staging so a camera-only move cannot fall back to
    // project-wide parked transforms after persistence or presence repair.
    const staticTimelineObjects = mergeTimelineObjects(commands
      .slice(shotStagingCommandStart)
      .flatMap((command): AgentTimelineObjectInput[] => command.op === 'shot.stageObject'
        ? [{
            object: command.object,
            ...(command.transform ? { transform: command.transform } : {}),
            ...(command.visible !== undefined ? { visible: command.visible } : {}),
            ...(command.humanPose ? { humanPose: command.humanPose } : {}),
            ...(command.posePreset ? { posePreset: command.posePreset } : {}),
          }]
        : []));
    commands.push({
      op: 'shot.timeline.replace',
      shot: shotTarget,
      durationSeconds: shot.motion.durationSeconds,
      keyframes: shot.motion.keyframes.map((keyframe) => ({
        timeSeconds: keyframe.timeSeconds,
        camera: resolveReadableMotionCamera(shot, keyframe) ?? {},
        ...(() => {
          const animatedObjects = [
            ...(keyframe.staging?.flatMap((staging) => {
              const castMapping = context.entities[`cast.${staging.subject}`];
              const propMapping = context.entities[`props.${staging.subject}`];
              const assetMapping = context.entities[`assets.${staging.subject}`];
              const mapping = castMapping ?? propMapping ?? assetMapping;
              const prefix = manifest.cast.some((item) => item.id === staging.subject)
                ? 'cast'
                : (manifest.props ?? []).some((item) => item.id === staging.subject)
                  ? 'prop'
                  : 'asset';
              const stagedCharacter = manifest.cast.find((item) => item.id === staging.subject);
              const inferredPose = canInferNativeActionPose(stagedCharacter)
                ? inferNativeActionPose(shot, staging.subject, shot.motion!.keyframes.indexOf(keyframe))
                : undefined;
              const resolvedPose = resolveCompilerPose(
                staging.subject,
                staging.posePreset ?? inferredPose,
              );
              const rigidLocomotionRotation = stagedCharacter?.type === 'imported_character'
                && !staging.transform?.rotation
                ? inferRigidLocomotionRotation(shot, staging.subject)
                : undefined;
              const readablePosition = resolveReadableMotionSubjectPosition(
                shot,
                keyframe,
                staging.subject,
              );
              const effectiveStaging = rigidLocomotionRotation || readablePosition
                ? {
                    ...staging,
                    transform: {
                      ...staging.transform,
                      ...(readablePosition ? { position: readablePosition } : {}),
                      ...(rigidLocomotionRotation ? { rotation: rigidLocomotionRotation } : {}),
                    },
                  }
                : staging;
              const stagedAssetDimensions = assetMapping
                ? manifestAssetDimensions(manifest, context, options.presenceProject, staging.subject)
                : undefined;
              return buildKeyframeStagingObjects({
                mapping,
                project: options.presenceProject,
                fallbackRef: previsRef(prefix, staging.subject),
                effectiveStaticTransform: effectiveStaticTransforms[staging.subject],
                staging: effectiveStaging,
                resolvedPose,
                groundOffsetY: stagedAssetDimensions
                  ? stagedAssetDimensions[1] / 2
                  : undefined,
              });
            }) ?? []),
            ...(closedWorldPresence?.dynamicObjectIds.map((objectId) => ({
              object: { id: objectId },
              visible: closedWorldPresence.expectedVisibleObjectIds.has(objectId),
            })) ?? []),
          ];
          const objects = mergeTimelineObjects([
            ...staticTimelineObjects,
            ...animatedObjects,
          ]);
          return objects.length > 0 ? { objects } : {};
        })(),
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

function mergeTimelineObjects(
  entries: readonly AgentTimelineObjectInput[],
): AgentTimelineObjectInput[] {
  const merged = new Map<string, AgentTimelineObjectInput>();
  for (const entry of entries) {
    const key = JSON.stringify(entry.object);
    const previous = merged.get(key);
    merged.set(key, {
      ...(previous ?? {}),
      ...entry,
      object: entry.object,
    });
  }
  return [...merged.values()];
}

function resolveCompilerPresence(
  project: LocationProject | undefined,
  shot: PrevisShotDefinition,
): {
  dynamicObjectIds: string[];
  expectedVisibleObjectIds: Set<string>;
  contract: ShotPresenceContract;
  diagnostics: Array<{ message: string }>;
} | undefined {
  if (!project) return undefined;
  const contract = getShotPresenceContract(project, {
    id: shot.id,
    shotNumber: shot.shotNumber,
    productionShotId: shot.shotNumber,
  });
  if (!contract) return undefined;
  const resolution = resolveExpectedShotPresence(project, contract);
  const unclassified = deriveDynamicObjectUniverse(project)
    .filter((item) => item.classification === 'unclassified')
    .map((item) => ({
      message: `Dynamic object "${item.objectId}" has no usable production classification.`,
    }));
  return {
    dynamicObjectIds: deriveDynamicObjectUniverse(project).map((item) => item.objectId),
    expectedVisibleObjectIds: new Set(resolution.expectedVisibleObjectIds),
    contract,
    diagnostics: [
      ...resolution.diagnostics.map((item) => ({ message: item.message })),
      ...unclassified,
    ],
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

function manifestEntityStageObjectTargets(
  mapping: PrevisEntityMapping | undefined,
  fallbackRef: string,
): Array<{ id: string } | { ref: string }> {
  if (mapping?.groupId && mapping.objectIds?.length) {
    return mapping.objectIds.map((objectId) => ({ id: objectId }));
  }
  return [resolveEntityTarget(mapping?.objectId, fallbackRef)];
}

function appendManifestEntityStageCommands(input: {
  commands: ForeSceneAgentCommand[];
  shotTarget: { id: string } | { ref: string };
  mapping: PrevisEntityMapping | undefined;
  fallbackRef: string;
  project: LocationProject | undefined;
  visible: boolean;
  transform?: Transform;
  posePreset?: string;
}): void {
  if (input.mapping?.groupId && input.mapping.objectIds?.length && input.transform) {
    const members = resolveManifestEntityMemberTransforms({
      mapping: input.mapping,
      project: input.project,
      targetTransform: input.transform,
    });
    for (const member of members) {
      input.commands.push({
        op: 'shot.stageObject',
        shot: input.shotTarget,
        object: { id: member.objectId },
        visible: input.visible,
        transform: member.transform,
        ...(input.posePreset ? { posePreset: input.posePreset } : {}),
      });
    }
    return;
  }
  if (input.mapping?.groupId && input.mapping.objectIds?.length) {
    for (const objectId of input.mapping.objectIds) {
      input.commands.push({
        op: 'shot.stageObject',
        shot: input.shotTarget,
        object: { id: objectId },
        visible: input.visible,
      });
    }
    return;
  }
  const objectTarget = resolveEntityTarget(input.mapping?.objectId, input.fallbackRef);
  input.commands.push({
    op: 'shot.stageObject',
    shot: input.shotTarget,
    object: objectTarget,
    visible: input.visible,
    ...(input.transform ? { transform: input.transform } : {}),
    ...(input.posePreset ? { posePreset: input.posePreset } : {}),
  });
}

function buildKeyframeStagingObjects(input: {
  mapping: PrevisEntityMapping | undefined;
  project: LocationProject | undefined;
  fallbackRef: string;
  effectiveStaticTransform?: Transform;
  staging: {
    visible?: boolean;
    transform?: {
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
    };
  };
  resolvedPose?: string;
  /** Imported-model manifest positions are floor contacts, matching static blocking placement. */
  groundOffsetY?: number;
}): Array<{
  object: { id: string } | { ref: string };
  visible?: boolean;
  transform?: Transform;
  posePreset?: string;
}> {
  const baseTransform = input.effectiveStaticTransform ?? {
    position: [0, 0, 0] as Vec3,
    rotation: [0, 0, 0] as Vec3,
    scale: [1, 1, 1] as Vec3,
  };
  if (input.staging.transform) {
    const requestedPosition = input.staging.transform.position;
    const targetTransform: Transform = {
      position: requestedPosition
        ? [requestedPosition[0], requestedPosition[1] + (input.groundOffsetY ?? 0), requestedPosition[2]]
        : baseTransform.position,
      rotation: input.staging.transform.rotation ?? baseTransform.rotation,
      scale: input.staging.transform.scale ?? baseTransform.scale,
    };
    if (input.mapping?.groupId && input.mapping.objectIds?.length) {
      const members = resolveManifestEntityMemberTransforms({
        mapping: input.mapping,
        project: input.project,
        targetTransform,
      });
      return members.map((member) => ({
        object: { id: member.objectId },
        ...(input.staging.visible !== undefined ? { visible: input.staging.visible } : {}),
        transform: member.transform,
        ...(input.resolvedPose ? { posePreset: input.resolvedPose } : {}),
      }));
    }
    const objectTarget = resolveEntityTarget(input.mapping?.objectId, input.fallbackRef);
    return [{
      object: objectTarget,
      ...(input.staging.visible !== undefined ? { visible: input.staging.visible } : {}),
      transform: targetTransform,
      ...(input.resolvedPose ? { posePreset: input.resolvedPose } : {}),
    }];
  }
  const targets = manifestEntityStageObjectTargets(input.mapping, input.fallbackRef);
  return targets.map((object) => ({
    object,
    ...(input.staging.visible !== undefined ? { visible: input.staging.visible } : {}),
    ...(input.resolvedPose ? { posePreset: input.resolvedPose } : {}),
  }));
}

function manifestAssetDimensions(
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
  project: LocationProject | undefined,
  assetId: string,
): Vec3 | undefined {
  const asset = manifest.assets?.find((item) => item.id === assetId);
  if (!asset || (asset.type !== 'imported_model' && asset.type !== 'primitive_proxy') || !project) {
    return undefined;
  }
  const mapping = context.entities[`assets.${assetId}`];
  const objectIds = mapping?.objectIds?.length
    ? mapping.objectIds
    : (mapping?.objectId ? [mapping.objectId] : []);
  const members = objectIds.flatMap((objectId) => {
    const object = project.scene.objects.find((item) => item.id === objectId);
    return object ? [object] : [];
  });
  if (members.length === 0) return undefined;
  const bounds = selectionBounds(members);
  const size: Vec3 = [
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  ];
  if (!size.every((value) => Number.isFinite(value) && value > 0)) return undefined;
  return size;
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
