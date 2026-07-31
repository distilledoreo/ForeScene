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

const FAILURE_CODES = new Set([
  'shot_missing',
  'camera_non_finite',
  'frame_missing',
  'frame_blank',
  'required_subject_missing',
  'render_not_ready',
]);

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

    if (bands.headTopY && headY !== undefined) {
      if (headY < bands.headTopY[0] - 0.02) {
        issues.push({
          code: 'head_clipped',
          message: `Subject "${id}" head is clipped at top of frame.`,
          subject: id,
          expected: { headTopY: bands.headTopY },
          measured: { headTopY: headY },
        });
      } else if (headY > bands.headTopY[1]) {
        issues.push({
          code: 'headroom_excessive',
          message: `Subject "${id}" has excessive headroom.`,
          subject: id,
          expected: { headTopY: bands.headTopY },
          measured: { headTopY: headY },
        });
      }
    }

    if (bands.shoulderY && shoulderY !== undefined) {
      if (shoulderY < bands.shoulderY[0] || shoulderY > bands.shoulderY[1]) {
        issues.push({
          code: shoulderY < bands.shoulderY[0] ? 'framing_too_tight' : 'framing_too_loose',
          message: `Subject "${id}" shoulder crop is outside close-up band.`,
          subject: id,
          expected: { shoulderY: bands.shoulderY },
          measured: { shoulderY, headTopY: headY, feetVisible: isLandmarkInFrame(data, 'feet') },
        });
      }
    }

    if (bands.chestY && chestY !== undefined) {
      if (chestY < bands.chestY[0] || chestY > bands.chestY[1]) {
        issues.push({
          code: chestY < bands.chestY[0] ? 'framing_too_tight' : 'framing_too_loose',
          message: `Subject "${id}" chest crop is outside MCU band.`,
          subject: id,
          expected: { chestY: bands.chestY },
          measured: { chestY, headTopY: headY },
        });
      }
    }

    if (bands.waistY && waistY !== undefined) {
      if (waistY < bands.waistY[0] || waistY > bands.waistY[1]) {
        issues.push({
          code: waistY < bands.waistY[0] ? 'framing_too_tight' : 'framing_too_loose',
          message: `Subject "${id}" waist crop is outside medium band.`,
          subject: id,
          expected: { waistY: bands.waistY },
          measured: { waistY, headTopY: headY, feetVisible: isLandmarkInFrame(data, 'feet') },
        });
      }
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

  // Over-the-shoulder
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
        if (fg.bounds.widthCoverage < 0.10) {
          issues.push({
            code: 'ots_foreground_too_small',
            message: 'OTS foreground occupies too little frame width.',
            subject: foregroundId,
            measured: { widthCoverage: fg.bounds.widthCoverage },
          });
        } else if (fg.bounds.widthCoverage > 0.40) {
          issues.push({
            code: 'ots_foreground_too_large',
            message: 'OTS foreground occupies too much frame width.',
            subject: foregroundId,
            measured: { widthCoverage: fg.bounds.widthCoverage },
          });
        }
        // Full-body centered foreground is wrong for OTS.
        if (
          fg.bounds.heightCoverage > 0.7
          && Math.abs(fg.bounds.centerX - 0.5) < 0.18
        ) {
          issues.push({
            code: 'ots_foreground_too_large',
            message: 'OTS foreground reads as a centered full body.',
            subject: foregroundId,
            measured: {
              heightCoverage: fg.bounds.heightCoverage,
              centerX: fg.bounds.centerX,
            },
          });
        }
        const touchesEdge = fg.bounds.centerX < 0.28 || fg.bounds.centerX > 0.72
          || fg.bounds.pixels.left < params.telemetry.frameWidth * 0.05
          || fg.bounds.pixels.right > params.telemetry.frameWidth * 0.95;
        if (!touchesEdge) {
          issues.push({
            code: 'ots_foreground_missing',
            message: 'OTS foreground does not read as an edge-hugging shoulder.',
            subject: foregroundId,
            measured: { centerX: fg.bounds.centerX },
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
      if (prim && fg && fg.bounds.areaCoverage > prim.bounds.areaCoverage * 1.4) {
        issues.push({
          code: 'ots_primary_obstructed',
          message: 'OTS foreground covers the primary subject.',
          measured: {
            foregroundArea: fg.bounds.areaCoverage,
            primaryArea: prim.bounds.areaCoverage,
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
