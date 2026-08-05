/**
 * Structured first-frame validation using real screen-space composition telemetry.
 */

import type { CameraData, LocationProject, Shot, Vec3 } from '../../domain/types';
import type { PrevisShotDefinition } from './manifest';
import { resolveProjectForShot } from '../shotSceneState';
import {
  buildShotCompositionTelemetry,
  isLandmarkInFrame,
  landmarkScreenY,
  type ShotCompositionTelemetry,
} from './compositionTelemetry';
import { templateFramingBands } from './framingProfiles';
import { otsPrimaryCropCoverage } from './cameraSolver';
import { getShotPresenceContract, verifyShotPresence } from './shotPresence';
import {
  getShotCompositionContract,
  verifyShotCompositionConstraints,
} from './compositionConstraints';

export type FrameValidationStatus = 'passed' | 'warning' | 'failed' | 'needs_review';

export interface FrameValidationIssue {
  code: string;
  message: string;
  subject?: string;
  expectedShotSize?: string;
  measuredCoverage?: number;
  expected?: Record<string, unknown>;
  measured?: Record<string, unknown>;
}

export interface FrameValidationResult {
  shotNumber: string;
  status: FrameValidationStatus;
  template?: string;
  issues: FrameValidationIssue[];
  telemetry?: ShotCompositionTelemetry;
}

export interface ValidateShotFrameInput {
  project: LocationProject;
  shot: Shot;
  definition: PrevisShotDefinition;
  frameExists: boolean;
  frameByteSize?: number;
  previousCamera?: CameraData;
  /** Manifest subject id → created object display name. */
  subjectNames?: Record<string, string>;
  /** Optional precomputed telemetry (avoids recompute during repair loops). */
  telemetry?: ShotCompositionTelemetry;
  /** Pixel sanity from clean renderer. */
  pixelStats?: {
    width: number;
    height: number;
    opaquePixelRatio: number;
    luminanceMean: number;
    luminanceVariance: number;
    sampledUniqueColorCount: number;
  };
  /** Frame came from canonical clay renderer (not UI screenshot). */
  fromCanonicalRenderer?: boolean;
}

export function validateShotFrame(input: ValidateShotFrameInput): FrameValidationResult {
  const issues: FrameValidationIssue[] = [];
  const { shot, definition, project } = input;
  const template = definition.camera.template;

  if (!shot) {
    return {
      shotNumber: definition.shotNumber,
      status: 'failed',
      template,
      issues: [{ code: 'shot_missing', message: 'Shot does not exist in the project.' }],
    };
  }

  const camera = shot.camera;
  if (
    !isFiniteVec3(camera.position)
    || !isFiniteVec3(camera.target)
    || !Number.isFinite(camera.fovDegrees)
  ) {
    issues.push({ code: 'camera_non_finite', message: 'Camera position, target, or FOV is non-finite.' });
  }

  if (camera.fovDegrees < 5 || camera.fovDegrees > 120) {
    issues.push({
      code: 'fov_out_of_bounds',
      message: `FOV ${camera.fovDegrees} is outside safe bounds (5–120).`,
    });
  }

  const resolved = resolveProjectForShot(project, shot);

  // Presence contracts are project-wide postconditions. Only invoke the
  // closed-world gate when this shot has an explicit contract so legacy shots
  // without production preparation retain their existing validation behavior.
  const presenceContract = getShotPresenceContract(project, shot);
  if (presenceContract) {
    const presence = verifyShotPresence(project, shot, presenceContract);
    for (const diagnostic of presence.diagnostics) {
      issues.push({
        code: diagnostic.code,
        message: diagnostic.message,
        subject: diagnostic.objectId,
        expected: {
          expectedVisibleObjectIds: presence.expectedVisibleObjectIds,
          expectedVisibleGroupIds: presence.expectedVisibleGroupIds,
        },
        measured: {
          actualVisibleObjectIds: presence.actualVisibleObjectIds,
          ...(diagnostic.sampleTimeSeconds !== undefined
            ? { sampleTimeSeconds: diagnostic.sampleTimeSeconds }
            : {}),
        },
      });
    }
  }

  // Reference-driven composition is a hard gate when a contract is present.
  // The ordinary template checks below remain useful for legacy shots, while
  // this comparison protects approved screen-space layout from generic bands.
  const compositionContract = getShotCompositionContract(project, shot);
  if (compositionContract) {
    const composition = verifyShotCompositionConstraints(project, shot, compositionContract);
    for (const diagnostic of composition.diagnostics) {
      issues.push({
        code: diagnostic.code,
        message: diagnostic.message,
        subject: diagnostic.entityId,
        expected: typeof diagnostic.expected === 'object' && diagnostic.expected !== null
          ? diagnostic.expected as Record<string, unknown>
          : { value: diagnostic.expected },
        measured: typeof diagnostic.measured === 'object' && diagnostic.measured !== null
          ? diagnostic.measured as Record<string, unknown>
          : { value: diagnostic.measured },
      });
    }
  }

  if (isCameraInsideSolidGeometry(camera.position, resolved)) {
    issues.push({
      code: 'camera_inside_geometry',
      message: 'Camera position appears to be inside solid set geometry.',
    });
  }

  if (!input.frameExists || (input.frameByteSize !== undefined && input.frameByteSize < 32)) {
    issues.push({
      code: 'frame_missing',
      message: 'Output PNG is missing or empty.',
    });
  }

  if (input.pixelStats) {
    if (input.pixelStats.width <= 0 || input.pixelStats.height <= 0) {
      issues.push({ code: 'frame_blank', message: 'Frame dimensions are zero.' });
    } else if (input.pixelStats.opaquePixelRatio < 0.02) {
      issues.push({ code: 'frame_blank', message: 'Frame is nearly fully transparent.' });
    } else if (
      input.pixelStats.luminanceVariance < 1e-6
      || input.pixelStats.sampledUniqueColorCount < 3
    ) {
      issues.push({ code: 'frame_blank', message: 'Frame has effectively zero pixel variance.' });
    }
  }

  const telemetry = input.telemetry ?? buildShotCompositionTelemetry({
    project,
    shot,
    definition,
    subjectNames: input.subjectNames,
  });

  const visibleRequired = definition.requirements?.visibleSubjects
    ?? definition.camera.subjects;

  for (const subjectId of visibleRequired) {
    const subject = telemetry.subjects[subjectId]
      ?? Object.entries(telemetry.subjects).find(([key]) => (
        key.toLowerCase() === subjectId.toLowerCase()
        || key.toLowerCase().includes(subjectId.toLowerCase())
      ))?.[1];

    if (!subject || !subject.visible) {
      const object = findSubjectObject(resolved, subjectId, definition, input.subjectNames);
      if (!object) {
        issues.push({
          code: 'required_subject_missing',
          message: `Required subject "${subjectId}" not found.`,
          subject: subjectId,
        });
      } else if (object.visible === false) {
        issues.push({
          code: 'required_subject_hidden',
          message: `Required subject "${subjectId}" is not visible in this shot.`,
          subject: subjectId,
        });
      } else {
        issues.push({
          code: 'subject_out_of_frame',
          message: `Required subject "${subjectId}" is not visible in frame.`,
          subject: subjectId,
        });
      }
      continue;
    }

    // Feet grounding (center Y ≈ height/2 for staged humans).
    const object = findSubjectObject(resolved, subjectId, definition, input.subjectNames);
    if (object?.type === 'human_dummy') {
      const height = object.dimensions[1] * object.transform.scale[1];
      const feetY = object.transform.position[1] - height / 2;
      if (Math.abs(feetY) > 0.35) {
        issues.push({
          code: 'character_underground',
          message: `Subject "${subjectId}" feet are ${feetY.toFixed(2)}m from ground.`,
          subject: subjectId,
        });
      }
    }

    if (subject.occlusionRatio !== undefined && subject.occlusionRatio > 0.45) {
      issues.push({
        code: 'subject_occluded',
        message: `Subject "${subjectId}" appears occluded (${(subject.occlusionRatio * 100).toFixed(0)}% of samples).`,
        subject: subjectId,
        measured: { occlusionRatio: subject.occlusionRatio },
      });
    }
    if (subject.faceOccluded) {
      issues.push({
        code: 'subject_face_occluded',
        message: `Subject "${subjectId}" face region is occluded.`,
        subject: subjectId,
      });
    }
  }

  for (const propId of definition.requirements?.visibleProps ?? []) {
    const object = findSubjectObject(resolved, propId, definition, input.subjectNames);
    if (!object) {
      issues.push({
        code: 'required_prop_missing',
        message: `Required prop "${propId}" not found.`,
        subject: propId,
      });
    } else if (object.visible === false) {
      issues.push({
        code: 'required_prop_hidden',
        message: `Required prop "${propId}" is not visible.`,
        subject: propId,
      });
    }
  }

  // Template-specific composition rules.
  issues.push(...validateTemplateComposition({
    template,
    definition,
    telemetry,
    subjectNames: input.subjectNames,
  }));

  // Wall dominance.
  const dominantWall = telemetry.blockers.find((blocker) => (
    blocker.projectedArea > 0.4 && blocker.nearCamera
  ));
  if (dominantWall) {
    issues.push({
      code: 'wall_dominant',
      message: `Foreground solid "${dominantWall.objectId}" dominates the frame.`,
      measured: { projectedArea: dominantWall.projectedArea },
    });
  }

  if (input.previousCamera && camerasNearlyIdentical(camera, input.previousCamera)) {
    issues.push({
      code: 'adjacent_cameras_identical',
      message: 'Camera is nearly identical to the previous shot.',
    });
  }

  // Character overlaps in world space.
  const people = resolved.scene.objects.filter((object) => (
    object.type === 'human_dummy' && object.visible !== false
  ));
  for (let i = 0; i < people.length; i += 1) {
    for (let j = i + 1; j < people.length; j += 1) {
      const a = people[i]!;
      const b = people[j]!;
      const dx = a.transform.position[0] - b.transform.position[0];
      const dz = a.transform.position[2] - b.transform.position[2];
      if (Math.hypot(dx, dz) < 0.45) {
        issues.push({
          code: 'subjects_overlapping',
          message: `Characters "${a.name}" and "${b.name}" are overlapping.`,
          subject: a.name,
        });
      }
    }
  }

  const hasFailure = issues.some((issue) => FAILURE_CODES.has(issue.code));
  const hasWarning = issues.length > 0;

  let status: FrameValidationStatus = 'passed';
  if (hasFailure) status = 'failed';
  else if (hasWarning) status = 'warning';

  return {
    shotNumber: definition.shotNumber,
    status,
    template,
    issues,
    telemetry,
  };
}

export const FAILURE_CODES = new Set<string>([
  'shot_missing',
  'camera_non_finite',
  'frame_missing',
  'frame_blank',
  'required_subject_missing',
  'render_not_ready',
  'unexpected_dynamic_object',
  'expected_dynamic_object_missing',
  'expected_dynamic_object_hidden',
  'partial_group_visibility',
  'unclassified_dynamic_object',
  'dynamic_presence_changed_over_time',
  'composition_entity_missing',
  'composition_constraint_out_of_tolerance',
]);

function isFiniteScreenLandmarkY(y: number): boolean {
  return Number.isFinite(y);
}

type CropLandmarkKey = 'shoulderY' | 'chestY' | 'waistY';

function validateCropLandmark(params: {
  id: string;
  landmarkKey: CropLandmarkKey;
  y: number | undefined;
  band: [number, number] | undefined;
  headY?: number;
  templateLabel: string;
}): FrameValidationIssue | undefined {
  const { id, landmarkKey, y, band, headY, templateLabel } = params;
  if (y === undefined || !band || !isFiniteScreenLandmarkY(y)) return undefined;

  const measured: Record<string, number | boolean | undefined> = {
    [landmarkKey]: y,
    headTopY: headY,
  };

  if (y < 0) {
    return {
      code: 'crop_landmark_clipped',
      message: `Subject "${id}" ${templateLabel} crop landmark is clipped above the frame.`,
      subject: id,
      expected: { [landmarkKey]: band },
      measured,
    };
  }

  if (y > 1.0) {
    return {
      code: 'framing_too_tight',
      message: `Subject "${id}" ${templateLabel} crop is below the frame (shot too tight).`,
      subject: id,
      expected: { [landmarkKey]: band },
      measured,
    };
  }

  if (y < band[0]) {
    return {
      code: 'framing_too_loose',
      message: `Subject "${id}" ${templateLabel} crop is outside band (too loose).`,
      subject: id,
      expected: { [landmarkKey]: band },
      measured,
    };
  }

  if (y > band[1]) {
    return {
      code: 'framing_too_tight',
      message: `Subject "${id}" ${templateLabel} crop is outside band (too tight).`,
      subject: id,
      expected: { [landmarkKey]: band },
      measured,
    };
  }

  return undefined;
}

function validateTemplateComposition(params: {
  template: PrevisShotDefinition['camera']['template'];
  definition: PrevisShotDefinition;
  telemetry: ShotCompositionTelemetry;
  subjectNames?: Record<string, string>;
}): FrameValidationIssue[] {
  const issues: FrameValidationIssue[] = [];
  const bands = templateFramingBands(params.template);
  const primaryIds = params.definition.camera.subjects;
  const foregroundId = params.definition.camera.foregroundSubject;

  const primarySubjects = primaryIds.map((id) => ({
    id,
    data: resolveSubjectTelemetry(params.telemetry, id),
  }));

  for (const { id, data } of primarySubjects) {
    if (!data || !data.visible) continue;

    const headY = landmarkScreenY(data, 'headTop');
    const shoulderY = landmarkScreenY(data, 'shoulders');
    const chestY = landmarkScreenY(data, 'chest');
    const waistY = landmarkScreenY(data, 'waist');
    const feetY = landmarkScreenY(data, 'feet');
    const kneesY = landmarkScreenY(data, 'knees');
    const landmarkConfidence = data.landmarkConfidence ?? 1;
    const lowConfidenceTolerance = landmarkConfidence < 0.5 ? 0.02 : 0;

    if (bands.headTopY && headY !== undefined) {
      if (headY < bands.headTopY[0] - 0.02) {
        issues.push({
          code: 'head_clipped',
          message: `Subject "${id}" head is clipped at top of frame.`,
          subject: id,
          expected: { headTopY: bands.headTopY },
          measured: { headTopY: headY, landmarkConfidence },
        });
      } else if (headY > bands.headTopY[1] + lowConfidenceTolerance) {
        issues.push({
          code: 'headroom_excessive',
          message: `Subject "${id}" has excessive headroom.`,
          subject: id,
          expected: { headTopY: bands.headTopY },
          measured: { headTopY: headY, landmarkConfidence },
        });
      }
    }

    if (bands.shoulderY) {
      const issue = validateCropLandmark({
        id,
        landmarkKey: 'shoulderY',
        y: shoulderY,
        band: bands.shoulderY,
        headY,
        templateLabel: 'shoulder',
      });
      if (issue) issues.push(issue);
    }

    if (bands.chestY) {
      const issue = validateCropLandmark({
        id,
        landmarkKey: 'chestY',
        y: chestY,
        band: bands.chestY,
        headY,
        templateLabel: 'chest',
      });
      if (issue) issues.push(issue);
    }

    if (bands.waistY) {
      const issue = validateCropLandmark({
        id,
        landmarkKey: 'waistY',
        y: waistY,
        band: bands.waistY,
        headY,
        templateLabel: 'waist',
      });
      if (issue) issues.push(issue);
    }

    if (bands.feetOutside && feetY !== undefined && feetY < 0.92 && isLandmarkInFrame(data, 'feet')) {
      issues.push({
        code: 'framing_too_loose',
        message: `Subject "${id}" feet are visible; expected crop above feet.`,
        subject: id,
        expected: { feetOutside: true },
        measured: { feetY, feetVisible: true },
      });
    }

    if (bands.kneesOutside && kneesY !== undefined && kneesY < 0.95 && isLandmarkInFrame(data, 'knees')) {
      issues.push({
        code: 'framing_too_loose',
        message: `Subject "${id}" knees are visible; expected tighter crop.`,
        subject: id,
        expected: { kneesOutside: true },
        measured: { kneesY },
      });
    }

    if (bands.waistOutside && waistY !== undefined && waistY < 0.98 && isLandmarkInFrame(data, 'waist')) {
      issues.push({
        code: 'framing_too_loose',
        message: `Subject "${id}" waist is visible; expected head-and-shoulders crop.`,
        subject: id,
        expected: { waistOutside: true },
        measured: { waistY },
      });
    }

    // Full-body AABB coverage — not used for OTS or landmark-crop templates (medium / MCU / close-up).
    const usesLandmarkCrop = Boolean(bands.waistY || bands.shoulderY || bands.chestY);
    if (params.template !== 'over_the_shoulder' && !usesLandmarkCrop) {
      if (bands.minHeightCoverage !== undefined && data.bounds.heightCoverage < bands.minHeightCoverage) {
        issues.push({
          code: 'framing_too_loose',
          message: `Subject "${id}" is too small in frame.`,
          subject: id,
          expectedShotSize: params.template,
          measuredCoverage: data.bounds.heightCoverage,
          expected: { minHeightCoverage: bands.minHeightCoverage },
          measured: { heightCoverage: data.bounds.heightCoverage },
        });
      }
      if (bands.maxHeightCoverage !== undefined && data.bounds.heightCoverage > bands.maxHeightCoverage) {
        issues.push({
          code: 'framing_too_tight',
          message: `Subject "${id}" is too large in frame.`,
          subject: id,
          expectedShotSize: params.template,
          measuredCoverage: data.bounds.heightCoverage,
          expected: { maxHeightCoverage: bands.maxHeightCoverage },
          measured: { heightCoverage: data.bounds.heightCoverage },
        });
      }
    }
    if (params.template === 'over_the_shoulder') {
      // OTS primary size: head→waist landmark span (or upper-body height).
      const crop = otsPrimaryCropCoverage({
        landmarks: data.landmarks,
        heightCoverage: data.upperBodyBounds?.heightCoverage,
        upperBodyHeightCoverage: data.upperBodyBounds?.heightCoverage,
      });
      if (crop !== undefined) {
        if (crop < 0.35) {
          issues.push({
            code: 'framing_too_loose',
            message: `OTS primary "${id}" head-to-waist crop is too small.`,
            subject: id,
            expectedShotSize: 'over_the_shoulder',
            measuredCoverage: crop,
            expected: { headToWaistCoverage: [0.35, 0.85] },
            measured: {
              headToWaistCoverage: crop,
              headTopY: headY,
              waistY,
              fullBodyHeightCoverage: data.bounds.heightCoverage,
            },
          });
        } else if (crop > 0.85) {
          issues.push({
            code: 'framing_too_tight',
            message: `OTS primary "${id}" head-to-waist crop is too large.`,
            subject: id,
            expectedShotSize: 'over_the_shoulder',
            measuredCoverage: crop,
            expected: { headToWaistCoverage: [0.35, 0.85] },
            measured: {
              headToWaistCoverage: crop,
              headTopY: headY,
              waistY,
              fullBodyHeightCoverage: data.bounds.heightCoverage,
            },
          });
        }
      }
    }

    // Primary off-center for singles (not two-shot / OTS).
    if (
      primaryIds.length === 1
      && params.template !== 'over_the_shoulder'
      && (data.bounds.centerX < 0.2 || data.bounds.centerX > 0.8)
    ) {
      issues.push({
        code: 'primary_off_center',
        message: `Primary subject "${id}" is off-center.`,
        subject: id,
        measured: { centerX: data.bounds.centerX },
      });
    }
  }

  // Secondary dominance for singles / mediums / close-ups.
  if (
    bands.maxSecondaryAreaRatio !== undefined
    && primaryIds.length >= 1
    && params.template !== 'two_shot'
    && params.template !== 'over_the_shoulder'
  ) {
    const primaryArea = Math.max(
      ...primarySubjects.map((item) => item.data?.bounds.areaCoverage ?? 0),
      0.001,
    );
    for (const [key, subject] of Object.entries(params.telemetry.subjects)) {
      if (primaryIds.includes(key) || key === foregroundId) continue;
      if (!subject.visible) continue;
      if (subject.bounds.areaCoverage > primaryArea * bands.maxSecondaryAreaRatio) {
        issues.push({
          code: 'unwanted_subject_dominant',
          message: `Secondary subject "${key}" dominates relative to primary.`,
          subject: key,
          measured: {
            secondaryArea: subject.bounds.areaCoverage,
            primaryArea,
          },
        });
      }
    }
  }

  // Two-shot
  if (params.template === 'two_shot' && primarySubjects.length >= 2) {
    const a = primarySubjects[0]!.data;
    const b = primarySubjects[1]!.data;
    if (a?.visible && b?.visible) {
      const sep = Math.abs(a.bounds.centerX - b.bounds.centerX);
      if (sep < 0.1) {
        issues.push({
          code: 'framing_too_tight',
          message: 'Two-shot subjects lack horizontal separation.',
          measured: { separation: sep },
        });
      }
      const ratio = Math.max(a.bounds.areaCoverage, b.bounds.areaCoverage)
        / Math.max(1e-4, Math.min(a.bounds.areaCoverage, b.bounds.areaCoverage));
      if (ratio > 2.8) {
        issues.push({
          code: 'unwanted_subject_dominant',
          message: 'One two-shot subject dominates the other.',
          measured: { areaRatio: ratio },
        });
      }
      if (
        a.bounds.centerX < 0.05 || a.bounds.centerX > 0.95
        || b.bounds.centerX < 0.05 || b.bounds.centerX > 0.95
      ) {
        issues.push({
          code: 'primary_off_center',
          message: 'Two-shot subject center outside safe margins.',
        });
      }
    }
  }

  // Over-the-shoulder — use visible head/shoulder occupancy, not unclipped full body.
  if (params.template === 'over_the_shoulder') {
    if (!foregroundId) {
      issues.push({
        code: 'ots_foreground_missing',
        message: 'OTS shot has no foregroundSubject declared.',
      });
    } else {
      const fg = resolveSubjectTelemetry(params.telemetry, foregroundId);
      const prim = primarySubjects[0]?.data;
      if (!fg || !fg.visible) {
        issues.push({
          code: 'ots_foreground_missing',
          message: `OTS foreground "${foregroundId}" is not visible.`,
          subject: foregroundId,
        });
      } else {
        const fgOcc = fg.upperBodyBounds ?? fg.bounds;
        const width = fgOcc.widthCoverage;
        if (width < 0.10) {
          issues.push({
            code: 'ots_foreground_too_small',
            message: 'OTS foreground occupies too little frame width.',
            subject: foregroundId,
            measured: {
              widthCoverage: width,
              unclippedWidth: fg.bounds.unclipped?.widthCoverage,
            },
          });
        } else if (width > 0.40) {
          issues.push({
            code: 'ots_foreground_too_large',
            message: 'OTS foreground occupies too much frame width.',
            subject: foregroundId,
            measured: {
              widthCoverage: width,
              unclippedWidth: fg.bounds.unclipped?.widthCoverage,
            },
          });
        }
        // Full-body centered foreground is wrong for OTS.
        if (
          fg.bounds.heightCoverage > 0.7
          && Math.abs(fgOcc.centerX - 0.5) < 0.18
        ) {
          issues.push({
            code: 'ots_foreground_too_large',
            message: 'OTS foreground reads as a centered full body.',
            subject: foregroundId,
            measured: {
              heightCoverage: fg.bounds.heightCoverage,
              centerX: fgOcc.centerX,
            },
          });
        }
        const touchesEdge = fgOcc.centerX < 0.28 || fgOcc.centerX > 0.72
          || fgOcc.pixels.left < params.telemetry.frameWidth * 0.05
          || fgOcc.pixels.right > params.telemetry.frameWidth * 0.95;
        if (!touchesEdge) {
          issues.push({
            code: 'ots_foreground_missing',
            message: 'OTS foreground does not read as an edge-hugging shoulder.',
            subject: foregroundId,
            measured: { centerX: fgOcc.centerX },
          });
        }
      }
      if (prim && fg && prim.faceOccluded) {
        issues.push({
          code: 'ots_primary_obstructed',
          message: 'OTS primary face is obstructed.',
          subject: primarySubjects[0]?.id,
        });
      }
      const primOcc = prim?.upperBodyBounds ?? prim?.bounds;
      const fgOcc = fg?.upperBodyBounds ?? fg?.bounds;
      if (primOcc && fgOcc && fgOcc.areaCoverage > primOcc.areaCoverage * 1.4) {
        issues.push({
          code: 'ots_primary_obstructed',
          message: 'OTS foreground covers the primary subject.',
          measured: {
            foregroundArea: fgOcc.areaCoverage,
            primaryArea: primOcc.areaCoverage,
          },
        });
      }
    }
  }

  // Insert
  if (params.template === 'insert' && primarySubjects[0]?.data) {
    const prop = primarySubjects[0].data;
    if (prop.bounds.areaCoverage < 0.25) {
      issues.push({
        code: 'framing_too_loose',
        message: 'Insert prop does not dominate the frame.',
        measured: { areaCoverage: prop.bounds.areaCoverage },
      });
    }
    if (prop.bounds.clipped) {
      issues.push({
        code: 'framing_too_tight',
        message: 'Insert prop is clipped unintentionally.',
      });
    }
  }

  return issues;
}

function resolveSubjectTelemetry(
  telemetry: ShotCompositionTelemetry,
  subjectId: string,
) {
  if (telemetry.subjects[subjectId]) return telemetry.subjects[subjectId];
  const lower = subjectId.toLowerCase();
  for (const [key, value] of Object.entries(telemetry.subjects)) {
    if (key.toLowerCase() === lower || key.toLowerCase().includes(lower)) {
      return value;
    }
  }
  return undefined;
}

function findSubjectObject(
  project: LocationProject,
  subjectId: string,
  _definition: PrevisShotDefinition,
  subjectNames?: Record<string, string>,
) {
  const mappedName = subjectNames?.[subjectId];
  const candidates = [mappedName, subjectId].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const exact = project.scene.objects.find((object) => (
      object.name === candidate
      || object.name.toLowerCase() === candidate.toLowerCase()
    ));
    if (exact) return exact;
  }
  return project.scene.objects.find((object) => (
    candidates.some((candidate) => object.name.toLowerCase().includes(candidate.toLowerCase()))
  ));
}

function camerasNearlyIdentical(a: CameraData, b: CameraData): boolean {
  const posDist = Math.hypot(
    a.position[0] - b.position[0],
    a.position[1] - b.position[1],
    a.position[2] - b.position[2],
  );
  const tgtDist = Math.hypot(
    a.target[0] - b.target[0],
    a.target[1] - b.target[1],
    a.target[2] - b.target[2],
  );
  return posDist < 0.05 && tgtDist < 0.05 && Math.abs(a.fovDegrees - b.fovDegrees) < 0.25;
}

function isFiniteVec3(value: Vec3): boolean {
  return value.every((component) => Number.isFinite(component));
}

const SOLID_TYPES = new Set([
  'wall', 'box', 'column', 'arch', 'doorway', 'stairs', 'terrain_mass', 'background_card',
]);

function isCameraInsideSolidGeometry(
  cameraPosition: Vec3,
  project: LocationProject,
): boolean {
  for (const object of project.scene.objects) {
    if (!SOLID_TYPES.has(object.type)) continue;
    if (object.visible === false) continue;
    const dims = object.dimensions;
    const scale = object.transform.scale;
    const hx = (dims[0] * scale[0]) / 2;
    const hy = (dims[1] * scale[1]) / 2;
    const hz = (dims[2] * scale[2]) / 2;
    const center = object.transform.position;
    const margin = 0.08;
    if (
      cameraPosition[0] > center[0] - hx + margin
      && cameraPosition[0] < center[0] + hx - margin
      && cameraPosition[1] > center[1] - hy + margin
      && cameraPosition[1] < center[1] + hy - margin
      && cameraPosition[2] > center[2] - hz + margin
      && cameraPosition[2] < center[2] + hz - margin
    ) {
      return true;
    }
  }
  return false;
}

export function isRepairableIssue(code: string): boolean {
  return [
    'subject_too_small',
    'subject_too_large',
    'subject_out_of_frame',
    'camera_inside_geometry',
    'character_underground',
    'subjects_overlapping',
    'framing_too_loose',
    'framing_too_tight',
    'headroom_excessive',
    'head_clipped',
    'crop_landmark_clipped',
    'primary_off_center',
    'unwanted_subject_dominant',
    'subject_occluded',
    'subject_face_occluded',
    'wall_dominant',
    'ots_foreground_missing',
    'ots_foreground_too_small',
    'ots_foreground_too_large',
    'ots_primary_obstructed',
    'render_not_ready',
    'frame_blank',
  ].includes(code);
}

function bandViolation(value: number, band: [number, number]): number {
  if (value < band[0]) return band[0] - value;
  if (value > band[1]) return value - band[1];
  return 0;
}

const HARD_REGRESSION_CODES = new Set([
  'camera_inside_geometry',
  'frame_blank',
  'subject_out_of_frame',
  'required_subject_hidden',
  'subject_face_occluded',
  'subject_occluded',
]);

const HIDDEN_OR_OCCLUDED_CODES = new Set([
  'subject_occluded',
  'subject_face_occluded',
  'subject_out_of_frame',
  'required_subject_hidden',
]);

export interface ValidationRank {
  hardFailureCount: number;
  hiddenOrOccludedCount: number;
  framingError: number;
}

function computeFramingError(result: FrameValidationResult): number {
  let score = 0;
  for (const issue of result.issues ?? []) {
    if (issue.code === 'repair_exhausted') continue;
    if (HARD_REGRESSION_CODES.has(issue.code) || HIDDEN_OR_OCCLUDED_CODES.has(issue.code)) {
      continue;
    }

    const measured = issue.measured ?? {};
    const expected = issue.expected ?? {};

    if (typeof measured.headTopY === 'number' && Array.isArray(expected.headTopY)) {
      score += bandViolation(measured.headTopY, expected.headTopY as [number, number]);
    }
    if (typeof measured.waistY === 'number' && Array.isArray(expected.waistY)) {
      score += bandViolation(measured.waistY, expected.waistY as [number, number]);
    }
    if (typeof measured.shoulderY === 'number' && Array.isArray(expected.shoulderY)) {
      score += bandViolation(measured.shoulderY, expected.shoulderY as [number, number]);
    }
    if (typeof measured.chestY === 'number' && Array.isArray(expected.chestY)) {
      score += bandViolation(measured.chestY, expected.chestY as [number, number]);
    }

    const coverage = issue.measuredCoverage
      ?? (typeof measured.heightCoverage === 'number' ? measured.heightCoverage : undefined);
    if (typeof coverage === 'number') {
      const min = expected.minHeightCoverage as number | undefined;
      const max = expected.maxHeightCoverage as number | undefined;
      if (typeof min === 'number' && coverage < min) score += min - coverage;
      if (typeof max === 'number' && coverage > max) score += coverage - max;
    }

    if (issue.code === 'crop_landmark_clipped') {
      const clipY = typeof measured.waistY === 'number'
        ? measured.waistY
        : typeof measured.shoulderY === 'number'
          ? measured.shoulderY
          : typeof measured.chestY === 'number'
            ? measured.chestY
            : undefined;
      if (typeof clipY === 'number' && clipY < 0) score += Math.abs(clipY);
    }
  }
  return score;
}

/** Lexicographic repair ranking (lower is better). */
export function rankFrameValidation(result: FrameValidationResult): ValidationRank {
  let hardFailureCount = 0;
  let hiddenOrOccludedCount = 0;
  for (const issue of result.issues ?? []) {
    if (issue.code === 'repair_exhausted') continue;
    if (HARD_REGRESSION_CODES.has(issue.code)) hardFailureCount += 1;
    if (HIDDEN_OR_OCCLUDED_CODES.has(issue.code)) hiddenOrOccludedCount += 1;
  }
  return {
    hardFailureCount,
    hiddenOrOccludedCount,
    framingError: computeFramingError(result),
  };
}

/** Negative when `after` is strictly better than `before`. */
export function compareValidationRank(before: ValidationRank, after: ValidationRank): number {
  if (after.hardFailureCount !== before.hardFailureCount) {
    return after.hardFailureCount - before.hardFailureCount;
  }
  if (after.hiddenOrOccludedCount !== before.hiddenOrOccludedCount) {
    return after.hiddenOrOccludedCount - before.hiddenOrOccludedCount;
  }
  return after.framingError - before.framingError;
}

export function isValidationRankImproved(
  before: ValidationRank,
  after: ValidationRank,
): boolean {
  return compareValidationRank(before, after) < 0;
}

/** Normalized composition error for monotonic repair scoring (lower is better). */
export function scoreFrameValidation(result: FrameValidationResult): number {
  const rank = rankFrameValidation(result);
  return rank.hardFailureCount * 10
    + rank.hiddenOrOccludedCount * 2
    + rank.framingError;
}

export function extractFramingMetrics(
  result: FrameValidationResult,
  subjectId?: string,
): Record<string, number> {
  const metrics: Record<string, number> = { score: scoreFrameValidation(result) };
  const telemetry = result.telemetry;
  if (!telemetry) return metrics;

  const subject = subjectId
    ? telemetry.subjects[subjectId]
      ?? Object.entries(telemetry.subjects).find(([key]) => (
        key.toLowerCase().includes(subjectId.toLowerCase())
      ))?.[1]
    : Object.values(telemetry.subjects)[0];
  if (!subject?.landmarks) return metrics;

  for (const [name, landmark] of Object.entries(subject.landmarks)) {
    metrics[`${name}Y`] = landmark.y;
  }
  return metrics;
}
