/**
 * Structural shot validation before compiling geometry.
 */

import type { PrevisProductionManifestV1, PrevisShotDefinition } from './manifest';
import { PREVIS_CAMERA_TEMPLATES } from './manifest';
import {
  PREVIS_DIAGNOSTIC_CODES,
  previsError,
  type PrevisDiagnostic,
} from './manifestDiagnostics';
import type { CompiledProductionContext } from './locationCompiler';
import { normalizeAnchorKey } from './locationTemplates';

export function validateShotDefinition(
  shot: PrevisShotDefinition,
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
  path: string,
): PrevisDiagnostic[] {
  const errors: PrevisDiagnostic[] = [];
  const locationIds = new Set(manifest.locations.map((location) => location.id));
  const castIds = new Set(manifest.cast.map((character) => character.id));
  const propIds = new Set((manifest.props ?? []).map((prop) => prop.id));
  const assetIds = new Set((manifest.assets ?? []).map((asset) => asset.id));

  if (!locationIds.has(shot.locationId)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.unknownReference,
      `Unknown locationId "${shot.locationId}".`,
      { path: `${path}.locationId`, entityId: shot.id },
    ));
  }

  if (!(PREVIS_CAMERA_TEMPLATES as readonly string[]).includes(shot.camera.template)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.unsupportedTemplate,
      `Unsupported camera template "${shot.camera.template}".`,
      { path: `${path}.camera.template`, entityId: shot.id },
    ));
  }

  for (const subject of shot.subjects) {
    if (!castIds.has(subject) && !propIds.has(subject) && !assetIds.has(subject)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unknownReference,
        `Unknown subject "${subject}".`,
        { path: `${path}.subjects`, entityId: shot.id },
      ));
    }
  }

  if (shot.camera.template === 'two_shot' && shot.camera.subjects.length < 2) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.invalidCombination,
      'two_shot requires at least two camera subjects.',
      { path: `${path}.camera.subjects`, entityId: shot.id },
    ));
  }

  if (shot.camera.template === 'over_the_shoulder') {
    if (!shot.camera.foregroundSubject) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.invalidCombination,
        'over_the_shoulder requires foregroundSubject.',
        { path: `${path}.camera.foregroundSubject`, entityId: shot.id },
      ));
    } else if (
      !castIds.has(shot.camera.foregroundSubject)
      && !propIds.has(shot.camera.foregroundSubject)
      && !assetIds.has(shot.camera.foregroundSubject)
    ) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unknownReference,
        `Unknown foregroundSubject "${shot.camera.foregroundSubject}".`,
        { path: `${path}.camera.foregroundSubject`, entityId: shot.id },
      ));
    }
  }

  const anchors = context.locationAnchors[shot.locationId] ?? {};
  for (const instruction of shot.blocking ?? []) {
    if (instruction.placement.type === 'relative') {
      const key = normalizeAnchorKey(instruction.placement.anchor);
      const knownSubject = castIds.has(instruction.placement.anchor)
        || propIds.has(instruction.placement.anchor)
        || assetIds.has(instruction.placement.anchor);
      const knownAnchor = Boolean(
        anchors[instruction.placement.anchor]
        || anchors[key],
      );
      if (!knownSubject && !knownAnchor && Object.keys(anchors).length > 0) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.unknownReference,
          `Unknown blocking anchor "${instruction.placement.anchor}".`,
          { path: `${path}.blocking`, entityId: shot.id },
        ));
      }
    }
  }

  if (shot.motion) {
    if (shot.motion.keyframes.length < 2) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidRange, 'motion requires at least two keyframes.', { path: `${path}.motion.keyframes`, entityId: shot.id }));
    }
    for (let index = 1; index < shot.motion.keyframes.length; index += 1) {
      if (shot.motion.keyframes[index]!.timeSeconds <= shot.motion.keyframes[index - 1]!.timeSeconds) {
        errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidRange, 'motion keyframe times must be strictly increasing.', { path: `${path}.motion.keyframes`, entityId: shot.id }));
        break;
      }
    }
    const knownSubjects = new Set([...castIds, ...propIds, ...assetIds]);
    for (const keyframe of shot.motion.keyframes) {
      for (const staging of keyframe.staging ?? []) {
        if (!knownSubjects.has(staging.subject)) errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.unknownReference, `Unknown motion subject "${staging.subject}".`, { path: `${path}.motion`, entityId: shot.id }));
      }
    }
  }

  return errors;
}

export function validateManifestShotNumbers(
  manifest: PrevisProductionManifestV1,
): PrevisDiagnostic[] {
  const seen = new Set<string>();
  const errors: PrevisDiagnostic[] = [];
  manifest.shots.forEach((shot, index) => {
    if (seen.has(shot.shotNumber)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.duplicateShotNumber,
        `Duplicate shotNumber "${shot.shotNumber}".`,
        { path: `shots[${index}].shotNumber`, entityId: shot.id },
      ));
    }
    seen.add(shot.shotNumber);
  });
  return errors;
}
