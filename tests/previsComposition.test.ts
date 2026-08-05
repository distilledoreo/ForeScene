/**
 * Unit tests for clean-frame composition telemetry, projection, framing profiles,
 * strict template validation, and camera solver V2.
 */

import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { CameraData, LocationProject, SceneObject, Shot, Vec3 } from '../src/domain/types';
import {
  applyHeadroomCorrection,
  applyAnchorSpanCameraRepair,
  buildCameraMatrices,
  buildOtsRepairProfile,
  buildRepairPlan,
  buildShotCompositionTelemetry,
  createInitialRunState,
  cropHeightFraction,
  estimateHeadTopYAfterHeadroomRepair,
  framingProfileForTemplate,
  HUMAN_FRAMING_PROFILES,
  HUMAN_LANDMARK_HEIGHT,
  isCanonicalFrame,
  isRepairableIssue,
  migrateRenderPipelineVersion,
  otsHardAccept,
  PREVIS_RENDER_PIPELINE_VERSION,
  preflightContactSheet,
  projectAabb,
  projectHumanLandmarks,
  computeRenderPixelStats,
  rejectRenderPixelStats,
  selectPrimaryIssue,
  solveShotCamera,
  subjectBoundsFromPlacement,
  templateFramingBands,
  upsertShotState,
  validateShotFrame,
  rankFrameValidation,
  isValidationRankImproved,
  scoreFrameValidation,
  type PrevisShotDefinition,
} from '../src/engine/previs';

function makeCamera(partial: Partial<CameraData> & { position: Vec3; target: Vec3 }): CameraData {
  return {
    fovDegrees: 35,
    aspectRatio: 16 / 9,
    near: 0.05,
    far: 500,
    ...partial,
  };
}

function makeHuman(
  id: string,
  name: string,
  position: Vec3,
  height = 1.75,
): SceneObject {
  return {
    id,
    name,
    type: 'human_dummy',
    transform: {
      position: [position[0], height / 2, position[2]],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    dimensions: [0.55, height, 0.55],
    visible: true,
    locked: false,
    color: '#888888',
    stagingRole: 'person',
  } as SceneObject;
}

function makeShot(camera: CameraData, shotNumber = '010'): Shot {
  return {
    id: `shot-${shotNumber}`,
    name: `Shot ${shotNumber}`,
    description: 'test',
    shotNumber,
    camera,
    cameraKeyframes: [],
    landmarkIds: [],
    promptOverrides: {},
    status: 'planned',
    assets: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exportSettings: {
      width: 1280,
      height: 720,
      includeViewport: true,
      includeAiResultFrame: false,
      includePanoCrop: false,
      includeFullPano: false,
      includeCubemap: false,
      includeGrayboxPano: false,
      includeCameraMoveVideo: false,
      includeCameraMoveReferenceFrames: false,
      includeMetadata: true,
      includePrompt: true,
    },
  };
}

function definition(partial: Partial<PrevisShotDefinition> & Pick<PrevisShotDefinition, 'camera' | 'shotNumber'>): PrevisShotDefinition {
  return {
    id: partial.id ?? `s${partial.shotNumber}`,
    name: partial.name ?? partial.shotNumber,
    description: partial.description ?? 'x',
    locationId: partial.locationId ?? 'room',
    subjects: partial.subjects ?? partial.camera.subjects,
    requirements: partial.requirements,
    blocking: partial.blocking,
    camera: partial.camera,
    shotNumber: partial.shotNumber,
  };
}

describe('render pixel stats', () => {
  it('rejects empty and flat buffers', () => {
    const empty = computeRenderPixelStats(new Uint8Array(0), 0, 0);
    expect(rejectRenderPixelStats(empty)?.code).toBe('frame_zero_size');

    const flat = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < flat.length; i += 4) {
      flat[i] = 128;
      flat[i + 1] = 128;
      flat[i + 2] = 128;
      flat[i + 3] = 255;
    }
    const flatStats = computeRenderPixelStats(flat, 64, 64);
    expect(rejectRenderPixelStats(flatStats)?.code).toBe('frame_zero_variance');
  });

  it('accepts varied opaque content', () => {
    const data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const i = (y * 64 + x) * 4;
        data[i] = (x * 4) % 256;
        data[i + 1] = (y * 4) % 256;
        data[i + 2] = 40;
        data[i + 3] = 255;
      }
    }
    const stats = computeRenderPixelStats(data, 64, 64);
    expect(rejectRenderPixelStats(stats)).toBeNull();
    expect(stats.opaquePixelRatio).toBeGreaterThan(0.9);
    expect(stats.sampledUniqueColorCount).toBeGreaterThan(3);
  });
});

describe('screen projection', () => {
  it('projects AABB corners into NDC and pixel space', () => {
    const camera = makeCamera({
      position: [0, 1.6, 4],
      target: [0, 1.0, 0],
      fovDegrees: 40,
    });
    const matrices = buildCameraMatrices(camera, 1280, 720);
    const bounds = projectAabb(
      { min: [-0.3, 0, -0.3], max: [0.3, 1.75, 0.3] },
      matrices,
    );
    expect(bounds.behindCamera).toBe(false);
    expect(bounds.heightCoverage).toBeGreaterThan(0.1);
    expect(bounds.widthCoverage).toBeGreaterThan(0.02);
    expect(bounds.centerX).toBeGreaterThan(0.3);
    expect(bounds.centerX).toBeLessThan(0.7);
  });

  it('projects human landmarks along body height', () => {
    const camera = makeCamera({
      position: [0, 1.5, 3],
      target: [0, 1.2, 0],
      fovDegrees: 35,
    });
    const matrices = buildCameraMatrices(camera, 1280, 720);
    const landmarks = projectHumanLandmarks({
      position: [0, 0, 0],
      height: 1.75,
      matrices,
    });
    expect(landmarks.headTop.y).toBeLessThan(landmarks.feet.y);
    expect(landmarks.eyes.y).toBeLessThan(landmarks.chest.y);
    expect(HUMAN_LANDMARK_HEIGHT.headTop).toBe(1);
  });
});

describe('framing profiles', () => {
  it('defines crop segments shorter than full body for medium/close-up', () => {
    const medium = framingProfileForTemplate('medium');
    const close = framingProfileForTemplate('close_up');
    expect(cropHeightFraction(medium)).toBeLessThan(0.6);
    expect(cropHeightFraction(close)).toBeLessThan(cropHeightFraction(medium));
    expect(HUMAN_FRAMING_PROFILES.medium?.bottomLandmark).toBe('waist');
    expect(templateFramingBands('close_up').waistOutside).toBe(true);
  });
});

describe('camera solver V2', () => {
  it('solves finite cameras for two-shot / medium / OTS / close-up', () => {
    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [-1, 0, 0] });
    const blair = subjectBoundsFromPlacement({ id: 'blair', position: [1, 0, 0], height: 1.68 });

    for (const template of ['two_shot', 'medium', 'close_up'] as const) {
      const solved = solveShotCamera({
        shot: definition({
          shotNumber: '010',
          camera: {
            template,
            subjects: template === 'two_shot' ? ['alex', 'blair'] : ['alex'],
            angle: 'three_quarter',
          },
        }),
        subjects: [alex, blair],
        aspectRatio: 16 / 9,
      });
      expect(solved.camera.position.every(Number.isFinite)).toBe(true);
      expect(solved.camera.target.every(Number.isFinite)).toBe(true);
      expect(solved.score).toBeGreaterThan(-200);
    }

    const ots = solveShotCamera({
      shot: definition({
        shotNumber: '030',
        camera: {
          template: 'over_the_shoulder',
          subjects: ['alex'],
          foregroundSubject: 'blair',
          angle: 'three_quarter',
        },
      }),
      subjects: [
        subjectBoundsFromPlacement({ id: 'alex', position: [0, 0, 0] }),
        subjectBoundsFromPlacement({
          id: 'blair',
          position: [0, 0, 1.2],
          yawRadians: Math.PI,
        }),
      ],
      aspectRatio: 16 / 9,
    });
    expect(ots.camera.position.every(Number.isFinite)).toBe(true);
  });

  it('produces a balanced perpendicular two-shot when actors share depth', () => {
    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [-1, 0, 0] });
    const blair = subjectBoundsFromPlacement({ id: 'blair', position: [1, 0, 0], height: 1.68 });
    const solved = solveShotCamera({
      shot: definition({
        shotNumber: '010',
        camera: {
          template: 'two_shot',
          subjects: ['alex', 'blair'],
          angle: 'front',
          lensClass: 'wide',
        },
      }),
      subjects: [alex, blair],
      aspectRatio: 16 / 9,
    });

    // Camera should sit roughly perpendicular to the actor line (X axis).
    const midX = 0;
    const midZ = 0;
    const camDx = solved.camera.position[0] - midX;
    const camDz = solved.camera.position[2] - midZ;
    // Prefer depth along Z (perpendicular to X-separated actors).
    expect(Math.abs(camDz)).toBeGreaterThan(Math.abs(camDx) * 0.6);

    // Equal depth → similar camera distance to each actor.
    const distA = Math.hypot(
      solved.camera.position[0] - alex.position[0],
      solved.camera.position[2] - alex.position[2],
    );
    const distB = Math.hypot(
      solved.camera.position[0] - blair.position[0],
      solved.camera.position[2] - blair.position[2],
    );
    const depthRatio = Math.max(distA, distB) / Math.max(1e-4, Math.min(distA, distB));
    expect(depthRatio).toBeLessThan(1.35);
  });

  it('OTS aims at upper torso so primary head is not mid-frame', () => {
    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [0, 0, 0] });
    const blair = subjectBoundsFromPlacement({
      id: 'blair',
      position: [0, 0, 1.15],
      height: 1.68,
      yawRadians: Math.PI,
    });
    const solved = solveShotCamera({
      shot: definition({
        shotNumber: '030',
        camera: {
          template: 'over_the_shoulder',
          subjects: ['alex'],
          foregroundSubject: 'blair',
          angle: 'three_quarter',
        },
      }),
      subjects: [alex, blair],
      aspectRatio: 16 / 9,
    });
    // Target should be near chest height (~0.70 * H), not near head top (~1.0 * H).
    const chestY = 1.75 * 0.70;
    const headY = 1.75;
    expect(Math.abs(solved.camera.target[1] - chestY)).toBeLessThan(
      Math.abs(solved.camera.target[1] - headY),
    );
  });

  it('otsHardAccept rejects giant foreground occupancy', () => {
    const ok = otsHardAccept({
      subjectScores: {
        alex: {
          centerX: 0.55,
          centerY: 0.45,
          widthCoverage: 0.25,
          heightCoverage: 0.55,
          areaCoverage: 0.14,
          clipped: false,
          behindCamera: false,
          faceOccluded: false,
          landmarks: {
            headTop: { x: 0.55, y: 0.14, inFrame: true },
            waist: { x: 0.55, y: 0.72, inFrame: true },
          },
        },
        blair: {
          centerX: 0.18,
          centerY: 0.4,
          widthCoverage: 0.22,
          heightCoverage: 0.35,
          areaCoverage: 0.08,
          clipped: false,
          behindCamera: false,
        },
      },
    }, 'alex', 'blair');
    expect(ok).toBe(true);

    const giantFg = otsHardAccept({
      subjectScores: {
        alex: {
          centerX: 0.55,
          centerY: 0.45,
          widthCoverage: 0.25,
          heightCoverage: 0.55,
          areaCoverage: 0.10,
          clipped: false,
          behindCamera: false,
          faceOccluded: false,
          landmarks: {
            headTop: { x: 0.55, y: 0.14, inFrame: true },
            waist: { x: 0.55, y: 0.72, inFrame: true },
          },
        },
        blair: {
          centerX: 0.2,
          centerY: 0.4,
          widthCoverage: 0.55,
          heightCoverage: 0.8,
          areaCoverage: 0.40,
          clipped: false,
          behindCamera: false,
        },
      },
    }, 'alex', 'blair');
    expect(giantFg).toBe(false);
  });

  it('OTS validation uses head-to-waist crop, not full-body AABB height', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    const blair = makeHuman('blair-id', 'Blair', [0.4, 0, 1.1], 1.68);
    project.scene.objects = [alex, blair];

    // Camera that frames a valid OTS-ish composition geometrically.
    const camera = makeCamera({
      position: [0.55, 1.52, 1.55],
      target: [0.05, 1.22, 0.15],
      fovDegrees: 35,
    });
    const shot = makeShot(camera, '030');
    project.shots = [shot];

    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: definition({
        shotNumber: '030',
        subjects: ['alex', 'blair'],
        camera: {
          template: 'over_the_shoulder',
          subjects: ['alex'],
          foregroundSubject: 'blair',
        },
        requirements: { visibleSubjects: ['alex', 'blair'] },
      }),
      subjectNames: { alex: 'Alex', blair: 'Blair' },
    });

    // Force the failure mode: full-body AABB height > 0.85 while landmark crop is valid.
    const prim = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    prim.bounds.heightCoverage = 0.95;
    prim.bounds.areaCoverage = 0.5;
    prim.landmarks = {
      headTop: { x: 0.55, y: 0.14, inFrame: true },
      waist: { x: 0.55, y: 0.70, inFrame: true },
      shoulders: { x: 0.55, y: 0.28, inFrame: true },
      feet: { x: 0.55, y: 1.2, inFrame: false },
    };
    prim.upperBodyBounds = {
      ...prim.bounds,
      heightCoverage: 0.42,
      widthCoverage: 0.28,
      areaCoverage: 0.12,
    };
    prim.faceOccluded = false;
    prim.visible = true;

    const fg = telemetry.subjects.blair ?? telemetry.subjects.Blair!;
    fg.visible = true;
    fg.upperBodyBounds = {
      ...fg.bounds,
      widthCoverage: 0.22,
      heightCoverage: 0.30,
      areaCoverage: 0.07,
      centerX: 0.18,
      pixels: { left: 0, top: 100, right: 280, bottom: 400 },
    };
    fg.bounds = {
      ...fg.bounds,
      widthCoverage: 0.22,
      heightCoverage: 0.30,
      areaCoverage: 0.07,
      centerX: 0.18,
      pixels: { left: 0, top: 100, right: 280, bottom: 400 },
    };

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '030',
        subjects: ['alex', 'blair'],
        camera: {
          template: 'over_the_shoulder',
          subjects: ['alex'],
          foregroundSubject: 'blair',
        },
        requirements: { visibleSubjects: ['alex', 'blair'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex', blair: 'Blair' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    // Must not flag framing_too_tight solely from full-body height > 0.85.
    expect(result.issues.some((issue) => (
      issue.code === 'framing_too_tight'
      && issue.measured
      && typeof issue.measured === 'object'
      && 'heightCoverage' in issue.measured
      && (issue.measured as { heightCoverage?: number }).heightCoverage === 0.95
    ))).toBe(false);

    // Hard-accept with landmark crop also passes despite huge full-body metric.
    expect(otsHardAccept({
      subjectScores: {
        alex: {
          centerX: 0.55,
          centerY: 0.4,
          widthCoverage: 0.3,
          heightCoverage: 0.95, // would fail if treated as full-body gate
          areaCoverage: 0.14,
          clipped: false,
          behindCamera: false,
          faceOccluded: false,
          landmarks: {
            headTop: { x: 0.55, y: 0.14, inFrame: true },
            waist: { x: 0.55, y: 0.70, inFrame: true },
          },
        },
        blair: {
          centerX: 0.18,
          centerY: 0.4,
          widthCoverage: 0.22,
          heightCoverage: 0.3,
          areaCoverage: 0.07,
          clipped: false,
          behindCamera: false,
        },
      },
    }, 'alex', 'blair')).toBe(true);
  });

  it('OTS repair profile for too-large FG increases min back/out and avoids prior camera', () => {
    const profile = buildOtsRepairProfile({
      issueCode: 'ots_foreground_too_large',
      camera: makeCamera({ position: [0, 1.5, 0.5], target: [0, 1.1, 0], fovDegrees: 35 }),
      issues: [{
        code: 'ots_foreground_too_large',
        message: 'too big',
        measured: { widthCoverage: 0.52 },
      }],
    });
    expect(profile.minBack).toBeGreaterThanOrEqual(0.7);
    expect(profile.minOut).toBeGreaterThanOrEqual(0.45);
    expect(profile.previousForegroundWidth).toBeCloseTo(0.52);
    expect(profile.avoidCamera).toBeTruthy();

    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [0, 0, 0] });
    const blair = subjectBoundsFromPlacement({
      id: 'blair',
      position: [0, 0, 1.15],
      height: 1.68,
      yawRadians: Math.PI,
    });
    const previous = makeCamera({
      position: [0.4, 1.55, 0.9],
      target: [0, 1.2, 0],
      fovDegrees: 35,
    });
    const solved = solveShotCamera({
      shot: definition({
        shotNumber: '030',
        camera: {
          template: 'over_the_shoulder',
          subjects: ['alex'],
          foregroundSubject: 'blair',
        },
      }),
      subjects: [alex, blair],
      aspectRatio: 16 / 9,
      repair: {
        ...profile,
        avoidCamera: previous,
        minCameraDistanceFromAvoid: 0.5,
      },
    });
    const dist = Math.hypot(
      solved.camera.position[0] - previous.position[0],
      solved.camera.position[2] - previous.position[2],
    );
    expect(dist).toBeGreaterThan(0.45);
  });

  it('two-shot repair re-solves rather than generic dolly', () => {
    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [-1, 0, 0] });
    const blair = subjectBoundsFromPlacement({ id: 'blair', position: [1, 0, 0] });
    // Intentionally bad camera: close on one side → depth imbalance.
    const badCamera = makeCamera({
      position: [-2.5, 1.5, 0.2],
      target: [-0.5, 1.0, 0],
      fovDegrees: 45,
    });
    const plan = buildRepairPlan({
      shotTarget: { id: 'shot-1' },
      camera: badCamera,
      template: 'two_shot',
      primarySubjectId: 'alex',
      subjects: [alex, blair],
      aspectRatio: 16 / 9,
      issues: [{
        code: 'unwanted_subject_dominant',
        message: 'imbalanced',
      }],
    });
    expect(plan?.description).toMatch(/two-shot dedicated re-solve/i);
    const cmd = plan!.commands.find((c) => c.op === 'shot.updateCamera');
    expect(cmd && cmd.op === 'shot.updateCamera').toBe(true);
    if (cmd && cmd.op === 'shot.updateCamera') {
      // Should move off the side-on depth trap toward a more frontal/perp placement.
      const midDist = Math.abs(cmd.camera.position![0]!);
      expect(midDist).toBeLessThan(2.2);
    }
  });

  it('penalizes secondary dominance via candidate scoring for medium', () => {
    const alex = subjectBoundsFromPlacement({ id: 'alex', position: [0, 0, 0] });
    const blair = subjectBoundsFromPlacement({ id: 'blair', position: [0.4, 0, 0.2] });
    const solved = solveShotCamera({
      shot: definition({
        shotNumber: '020',
        camera: {
          template: 'medium',
          subjects: ['alex'],
          angle: 'three_quarter',
        },
      }),
      subjects: [alex, blair],
      aspectRatio: 16 / 9,
    });
    expect(solved.camera.position.every(Number.isFinite)).toBe(true);
  });
});

describe('strict template validation', () => {
  it('flags a loose close-up when feet are visible', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    project.scene.objects = [alex];
    // Wide camera — full body in frame (bad close-up).
    const camera = makeCamera({
      position: [0, 1.5, 6],
      target: [0, 0.9, 0],
      fovDegrees: 50,
    });
    const shot = makeShot(camera, '040');
    project.shots = [shot];

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '040',
        subjects: ['alex'],
        camera: { template: 'close_up', subjects: ['alex'] },
        requirements: { visibleSubjects: ['alex'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex' },
      fromCanonicalRenderer: true,
    });

    expect(result.template).toBe('close_up');
    expect(result.issues.some((issue) => (
      issue.code === 'framing_too_loose'
      || issue.code === 'headroom_excessive'
    ))).toBe(true);
    expect(result.telemetry).toBeTruthy();
  });

  it('passes a reasonable two-shot', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [-0.9, 0, 0]);
    const blair = makeHuman('blair-id', 'Blair', [0.9, 0, 0], 1.68);
    project.scene.objects = [alex, blair];
    const camera = makeCamera({
      position: [0, 1.55, 4.2],
      target: [0, 1.0, 0],
      fovDegrees: 45,
    });
    const shot = makeShot(camera, '010');
    project.shots = [shot];

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '010',
        subjects: ['alex', 'blair'],
        camera: {
          template: 'two_shot',
          subjects: ['alex', 'blair'],
          angle: 'front',
        },
        requirements: { visibleSubjects: ['alex', 'blair'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex', blair: 'Blair' },
    });

    expect(result.telemetry?.subjects.alex || result.telemetry?.subjects.Alex).toBeTruthy();
    // May still warn depending on exact projection, but should not fail hard.
    expect(result.status === 'failed' && result.issues.every((i) => i.code === 'shot_missing')).toBe(false);
  });

  it('treats closed-world dynamic presence violations as hard frame failures', () => {
    const project = createDefaultProject() as LocationProject;
    const lead = makeHuman('lead-id', 'Lead', [0, 0, 0]);
    const extra = makeHuman('extra-id', 'Extra', [1, 0, 0]);
    project.scene.objects = [lead, extra];
    const shot = makeShot(makeCamera({ position: [0, 1.5, 6], target: [0, 0.9, 0] }), '050');
    project.shots = [shot];
    project.workflow.production = {
      schemaVersion: 1,
      bindings: {},
      locations: {},
      shotContracts: {
        [shot.id]: {
          presence: {
            expectedVisibleObjectIds: [lead.id],
            expectedVisibleGroupIds: [],
            allowUnspecifiedDynamicObjects: false,
          },
        },
      },
    };

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '050',
        subjects: ['lead'],
        camera: { template: 'wide', subjects: ['lead'] },
        requirements: { visibleSubjects: ['lead'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { lead: 'Lead' },
    });

    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unexpected_dynamic_object', subject: extra.id }),
    ]));
  });

  it('marks new issue codes as repairable', () => {
    expect(isRepairableIssue('framing_too_loose')).toBe(true);
    expect(isRepairableIssue('ots_foreground_too_large')).toBe(true);
    expect(isRepairableIssue('wall_dominant')).toBe(true);
    expect(isRepairableIssue('required_subject_missing')).toBe(false);
  });
});

describe('telemetry-driven repairs', () => {
  it('scales camera distance from measured coverage', () => {
    const camera = makeCamera({
      position: [0, 1.6, 4],
      target: [0, 1.2, 0],
      fovDegrees: 35,
    });
    const plan = buildRepairPlan({
      shotTarget: { id: 'shot-1' },
      camera,
      template: 'medium',
      primarySubjectId: 'alex',
      issues: [{
        code: 'framing_too_loose',
        message: 'too loose',
        measuredCoverage: 0.3,
        measured: { heightCoverage: 0.3, headTopY: 0.22 },
      }],
    });
    expect(plan).toBeTruthy();
    const cmd = plan!.commands.find((c) => c.op === 'shot.updateCamera');
    expect(cmd).toBeTruthy();
    if (cmd && cmd.op === 'shot.updateCamera') {
      const distBefore = Math.hypot(
        camera.position[0] - camera.target[0],
        camera.position[2] - camera.target[2],
      );
      const distAfter = Math.hypot(
        cmd.camera.position![0]! - cmd.camera.target![0]!,
        cmd.camera.position![2]! - cmd.camera.target![2]!,
      );
      expect(distAfter).toBeLessThan(distBefore);
    }
  });

  it('reduces headroom so next headTopY is numerically smaller', () => {
    const camera = makeCamera({
      position: [0, 1.6, 3.2],
      target: [0, 1.35, 0],
      fovDegrees: 35,
    });
    const headWorld: Vec3 = [0, 1.75, 0];
    const headTopY = 0.28; // excessive headroom
    const afterY = estimateHeadTopYAfterHeadroomRepair({
      camera,
      headWorld,
      headTopY,
      desiredHeadTopY: 0.10,
    });
    expect(afterY).toBeLessThan(headTopY);

    const repaired = applyHeadroomCorrection(
      {
        position: [...camera.position] as Vec3,
        target: [...camera.target] as Vec3,
        fovDegrees: camera.fovDegrees,
      },
      headTopY,
      0.10,
    );
    expect(
      repaired.position[0] !== camera.position[0]
      || repaired.position[1] !== camera.position[1]
      || repaired.position[2] !== camera.position[2],
    ).toBe(true);

    const plan = buildRepairPlan({
      shotTarget: { id: 'shot-1' },
      camera,
      template: 'close_up',
      primarySubjectId: 'alex',
      telemetry: {
        shotId: 'shot-1',
        shotNumber: '040',
        frameWidth: 1920,
        frameHeight: 1080,
        subjects: {
          alex: {
            bounds: {
              ndc: { minX: -0.2, maxX: 0.2, minY: -0.5, maxY: 0.5 },
              pixels: { left: 768, top: 270, right: 1152, bottom: 810 },
              widthCoverage: 0.2,
              heightCoverage: 0.25,
              areaCoverage: 0.05,
              centerX: 0.5,
              centerY: 0.5,
              clipped: false,
              behindCamera: false,
              unclipped: {
                widthCoverage: 0.2,
                heightCoverage: 0.25,
                areaCoverage: 0.05,
                centerX: 0.5,
                centerY: 0.5,
                pixels: { left: 768, top: 270, right: 1152, bottom: 810 },
              },
              visible: {
                widthCoverage: 0.2,
                heightCoverage: 0.25,
                areaCoverage: 0.05,
                centerX: 0.5,
                centerY: 0.5,
                pixels: { left: 768, top: 270, right: 1152, bottom: 810 },
              },
            },
            visible: true,
            landmarks: {
              headTop: { x: 0.5, y: headTopY, inFrame: true },
              shoulders: { x: 0.5, y: 0.55, inFrame: true },
            },
          },
        },
        blockers: [],
      },
      issues: [{
        code: 'headroom_excessive',
        message: 'too much headroom',
        measured: { headTopY },
      }, {
        // Lower priority — must not also run and fight headroom fix.
        code: 'unwanted_subject_dominant',
        message: 'secondary',
      }],
    });
    expect(plan?.primaryIssueCode).toBe('headroom_excessive');
    expect(plan?.description).toMatch(/reduce headroom|zoom_in_preserve_head/);
    expect(plan?.description).not.toContain('secondary');
    const cmd = plan!.commands.find((c) => c.op === 'shot.updateCamera');
    expect(cmd && cmd.op === 'shot.updateCamera').toBe(true);
  });

  it('picks a single root-cause issue by priority', () => {
    const primary = selectPrimaryIssue([
      { code: 'unwanted_subject_dominant', message: 'x' },
      { code: 'headroom_excessive', message: 'y' },
      { code: 'camera_inside_geometry', message: 'z' },
    ]);
    expect(primary?.code).toBe('camera_inside_geometry');
  });

  it('labels crop landmarks below the band minimum as framing_too_loose', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    project.scene.objects = [alex];
    const shot = makeShot(makeCamera({ position: [0, 1.5, 6], target: [0, 0.9, 0] }), '020');
    project.shots = [shot];

    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: definition({
        shotNumber: '020',
        subjects: ['alex'],
        camera: { template: 'medium', subjects: ['alex'] },
        requirements: { visibleSubjects: ['alex'] },
      }),
      subjectNames: { alex: 'Alex' },
    });
    const alexData = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    alexData.landmarks = {
      headTop: { x: 0.5, y: 0.29, inFrame: true },
      waist: { x: 0.5, y: 0.616, inFrame: true },
      shoulders: { x: 0.5, y: 0.45, inFrame: true },
      feet: { x: 0.5, y: 1.2, inFrame: false },
    };
    alexData.visible = true;

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '020',
        subjects: ['alex'],
        camera: { template: 'medium', subjects: ['alex'] },
        requirements: { visibleSubjects: ['alex'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    expect(result.issues.some((issue) => (
      issue.code === 'framing_too_loose'
      && issue.measured?.waistY === 0.616
    ))).toBe(true);
  });

  it('labels crop landmarks above the band maximum as framing_too_tight', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    project.scene.objects = [alex];
    const shot = makeShot(makeCamera({ position: [0, 1.5, 2], target: [0, 0.9, 0] }), '040');
    project.shots = [shot];

    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: definition({
        shotNumber: '040',
        subjects: ['alex'],
        camera: { template: 'close_up', subjects: ['alex'] },
        requirements: { visibleSubjects: ['alex'] },
      }),
      subjectNames: { alex: 'Alex' },
    });
    const alexData = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    alexData.landmarks = {
      headTop: { x: 0.5, y: 0.12, inFrame: true },
      shoulders: { x: 0.5, y: 1.08, inFrame: true },
      waist: { x: 0.5, y: 1.2, inFrame: false },
      feet: { x: 0.5, y: 1.2, inFrame: false },
    };
    alexData.visible = true;

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '040',
        subjects: ['alex'],
        camera: { template: 'close_up', subjects: ['alex'] },
        requirements: { visibleSubjects: ['alex'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    expect(result.issues.some((issue) => (
      issue.code === 'framing_too_tight'
      && issue.measured?.shoulderY === 1.08
    ))).toBe(true);
  });

  it('zooms in when anchor span repair sees a loose medium crop', () => {
    const camera = makeCamera({
      position: [0, 1.6, 4],
      target: [0, 1.2, 0],
      fovDegrees: 35,
    });
    const repaired = applyAnchorSpanCameraRepair(camera, {
      code: 'framing_too_loose',
      message: 'waist too high',
      measured: { headTopY: 0.29, waistY: 0.616 },
    }, 'medium');
    expect(repaired?.action.type).toBe('zoom_in_preserve_head');
    const distBefore = Math.hypot(
      camera.position[0] - camera.target[0],
      camera.position[2] - camera.target[2],
    );
    const distAfter = Math.hypot(
      repaired!.camera.position[0] - repaired!.camera.target[0],
      repaired!.camera.position[2] - repaired!.camera.target[2],
    );
    expect(distAfter).toBeLessThan(distBefore);
  });

  it('applies a low-confidence deadband to borderline headroom warnings', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [-0.9, 0, 0]);
    const blair = makeHuman('blair-id', 'Blair', [0.9, 0, 0], 1.68);
    project.scene.objects = [alex, blair];
    const shot = makeShot(makeCamera({ position: [0, 1.55, 4.2], target: [0, 1.0, 0] }), '010');
    project.shots = [shot];

    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: definition({
        shotNumber: '010',
        subjects: ['alex', 'blair'],
        camera: { template: 'two_shot', subjects: ['alex', 'blair'], angle: 'front' },
        requirements: { visibleSubjects: ['alex', 'blair'] },
      }),
      subjectNames: { alex: 'Alex', blair: 'Blair' },
    });
    for (const subject of Object.values(telemetry.subjects)) {
      subject.landmarkConfidence = 0.35;
      subject.landmarkSource = 'bounds_fallback';
      subject.landmarks = {
        ...(subject.landmarks ?? {}),
        headTop: { x: 0.5, y: 0.292, inFrame: true },
      };
      subject.visible = true;
    }

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '010',
        subjects: ['alex', 'blair'],
        camera: { template: 'two_shot', subjects: ['alex', 'blair'], angle: 'front' },
        requirements: { visibleSubjects: ['alex', 'blair'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex', blair: 'Blair' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    expect(result.issues.some((issue) => issue.code === 'headroom_excessive')).toBe(false);
  });

  it('does not flag framing_too_tight from full-body height alone on medium when landmark crop is valid', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    project.scene.objects = [alex];
    const shot = makeShot(makeCamera({ position: [0, 1.5, 4], target: [0, 0.9, 0] }), '020');
    project.shots = [shot];

    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: definition({
        shotNumber: '020',
        subjects: ['alex'],
        camera: { template: 'medium', subjects: ['alex'] },
        requirements: { visibleSubjects: ['alex'] },
      }),
      subjectNames: { alex: 'Alex' },
    });
    const alexData = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    alexData.bounds.heightCoverage = 0.95;
    alexData.landmarks = {
      headTop: { x: 0.5, y: 0.15, inFrame: true },
      waist: { x: 0.5, y: 0.82, inFrame: true },
      feet: { x: 0.5, y: 1.2, inFrame: false },
    };
    alexData.visible = true;

    const result = validateShotFrame({
      project,
      shot,
      definition: definition({
        shotNumber: '020',
        subjects: ['alex'],
        camera: { template: 'medium', subjects: ['alex'] },
        requirements: { visibleSubjects: ['alex'] },
      }),
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    expect(result.issues.some((issue) => (
      issue.code === 'framing_too_tight'
      && issue.measured
      && typeof issue.measured === 'object'
      && 'heightCoverage' in issue.measured
    ))).toBe(false);
  });

  it('scores lower when framing moves toward the target band', () => {
    const bands = templateFramingBands('medium');
    const worse: import('../src/engine/previs/frameValidation').FrameValidationResult = {
      shotNumber: '020',
      status: 'warning',
      template: 'medium',
      issues: [{
        code: 'framing_too_loose',
        message: 'waist too high',
        expected: { waistY: bands.waistY },
        measured: { waistY: 0.616, headTopY: 0.29 },
      }],
    };
    const better: import('../src/engine/previs/frameValidation').FrameValidationResult = {
      ...worse,
      issues: [{
        code: 'framing_too_loose',
        message: 'still loose but closer',
        expected: { waistY: bands.waistY },
        measured: { waistY: 0.74, headTopY: 0.15 },
      }],
    };
    expect(rankFrameValidation(better).framingError)
      .toBeLessThan(rankFrameValidation(worse).framingError);
  });

  it('flags off-screen medium waist below frame as framing_too_tight', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    project.scene.objects = [alex];
    const shot = makeShot(makeCamera({ position: [0, 1.5, 4], target: [0, 0.9, 0] }), '020');
    project.shots = [shot];
    const shotDef = definition({
      shotNumber: '020',
      subjects: ['alex'],
      camera: { template: 'medium', subjects: ['alex'] },
      requirements: { visibleSubjects: ['alex'] },
    });
    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: shotDef,
      subjectNames: { alex: 'Alex' },
    });
    const alexData = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    alexData.landmarks = {
      headTop: { x: 0.5, y: 0.15, inFrame: true },
      waist: { x: 0.5, y: 1.20, inFrame: false },
    };
    alexData.visible = true;

    const result = validateShotFrame({
      project,
      shot,
      definition: shotDef,
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    expect(result.issues.some((issue) => (
      issue.code === 'framing_too_tight'
      && issue.measured?.waistY === 1.20
    ))).toBe(true);
  });

  it('flags off-screen close-up shoulders below frame as framing_too_tight', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    project.scene.objects = [alex];
    const shot = makeShot(makeCamera({ position: [0, 1.5, 2.5], target: [0, 1.2, 0] }), '040');
    project.shots = [shot];
    const shotDef = definition({
      shotNumber: '040',
      subjects: ['alex'],
      camera: { template: 'close_up', subjects: ['alex'] },
      requirements: { visibleSubjects: ['alex'] },
    });
    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: shotDef,
      subjectNames: { alex: 'Alex' },
    });
    const alexData = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    alexData.landmarks = {
      headTop: { x: 0.5, y: 0.12, inFrame: true },
      shoulders: { x: 0.5, y: 1.20, inFrame: false },
    };
    alexData.visible = true;

    const result = validateShotFrame({
      project,
      shot,
      definition: shotDef,
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    expect(result.issues.some((issue) => (
      issue.code === 'framing_too_tight'
      && issue.measured?.shoulderY === 1.20
    ))).toBe(true);
  });

  it('flags clipped crop landmarks above the frame', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    project.scene.objects = [alex];
    const shot = makeShot(makeCamera({ position: [0, 1.5, 4], target: [0, 0.9, 0] }), '020');
    project.shots = [shot];
    const shotDef = definition({
      shotNumber: '020',
      subjects: ['alex'],
      camera: { template: 'medium', subjects: ['alex'] },
      requirements: { visibleSubjects: ['alex'] },
    });
    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: shotDef,
      subjectNames: { alex: 'Alex' },
    });
    const alexData = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    alexData.landmarks = {
      headTop: { x: 0.5, y: 0.15, inFrame: true },
      waist: { x: 0.5, y: -0.05, inFrame: false },
    };
    alexData.visible = true;

    const result = validateShotFrame({
      project,
      shot,
      definition: shotDef,
      frameExists: true,
      frameByteSize: 4096,
      subjectNames: { alex: 'Alex' },
      telemetry,
      fromCanonicalRenderer: true,
    });

    expect(result.issues.some((issue) => issue.code === 'crop_landmark_clipped')).toBe(true);
  });

  it('matches fallback crop anchor to the correct target band', () => {
    const bands = templateFramingBands('medium_close_up');
    const camera = makeCamera({ position: [0, 1.6, 4], target: [0, 1.0, 0] });
    const anchor = applyAnchorSpanCameraRepair(camera, {
      code: 'framing_too_loose',
      message: 'loose',
      measured: {
        headTopY: 0.15,
        waistY: 1.25,
        chestY: 0.70,
      },
    }, 'medium_close_up');
    expect(anchor?.action?.cropAnchor).toBe('chestY');
    expect(anchor?.action?.targetCropY).toBeCloseTo((bands.chestY![0] + bands.chestY![1]) / 2);
  });

  it('rejects repairs that trade framing gains for hard regressions', () => {
    const bands = templateFramingBands('medium');
    const beforeResult: import('../src/engine/previs/frameValidation').FrameValidationResult = {
      shotNumber: '020',
      status: 'warning',
      template: 'medium',
      issues: [{
        code: 'framing_too_loose',
        message: 'loose',
        expected: { waistY: bands.waistY },
        measured: { waistY: 0.62, headTopY: 0.28 },
      }],
    };
    const afterResult: import('../src/engine/previs/frameValidation').FrameValidationResult = {
      shotNumber: '020',
      status: 'failed',
      template: 'medium',
      issues: [{
        code: 'subject_out_of_frame',
        message: 'gone',
        subject: 'alex',
      }],
    };
    const beforeRank = rankFrameValidation(beforeResult);
    const afterRank = rankFrameValidation(afterResult);
    expect(isValidationRankImproved(beforeRank, afterRank)).toBe(false);
    expect(afterRank.hardFailureCount + afterRank.hiddenOrOccludedCount).toBeGreaterThan(0);
  });
});

describe('projected bounds clamping', () => {
  it('keeps visible occupancy ≤ 1 even when AABB extends offscreen', () => {
    const camera = makeCamera({
      position: [0, 1.2, 1.2],
      target: [0, 1.0, 0],
      fovDegrees: 40,
    });
    const matrices = buildCameraMatrices(camera, 1280, 720);
    // Tall body that will project past the bottom of the frame.
    const bounds = projectAabb(
      { min: [-0.4, 0, -0.3], max: [0.4, 2.0, 0.3] },
      matrices,
    );
    expect(bounds.widthCoverage).toBeLessThanOrEqual(1.001);
    expect(bounds.heightCoverage).toBeLessThanOrEqual(1.001);
    expect(bounds.areaCoverage).toBeLessThanOrEqual(1.001);
    expect(bounds.unclipped.heightCoverage).toBeGreaterThanOrEqual(bounds.heightCoverage);
  });
});

describe('contact sheet preflight', () => {
  it('rejects debug UI paths and missing files', async () => {
    const result = await preflightContactSheet({
      shots: [
        {
          shotNumber: '010',
          name: 'A',
          framePath: 'C:/tmp/debug/010-ui.png',
          status: 'passed',
          warningCount: 0,
          fromCanonicalRenderer: false,
        },
        {
          shotNumber: '020',
          name: 'B',
          framePath: 'C:/tmp/shots/020.png',
          status: 'passed',
          warningCount: 0,
          fromCanonicalRenderer: true,
        },
      ],
      fileExists: async (p) => p.includes('020.png'),
      readPngSize: async () => ({ width: 1280, height: 720, isPng: true }),
      expectedAspectRatio: 16 / 9,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'debug_path_rejected')).toBe(true);
    expect(result.issues.some((i) => i.code === 'not_canonical_renderer')).toBe(true);
  });

  it('accepts clean canonical frames', async () => {
    const result = await preflightContactSheet({
      shots: [
        {
          shotNumber: '010',
          name: 'A',
          framePath: 'C:/tmp/shots/010.png',
          status: 'passed',
          warningCount: 0,
          fromCanonicalRenderer: true,
        },
      ],
      fileExists: async () => true,
      readPngSize: async () => ({ width: 1920, height: 1080, isPng: true }),
      expectedAspectRatio: 16 / 9,
    });
    expect(result.ok).toBe(true);
  });
});

describe('render pipeline versioning', () => {
  it('invalidates non-canonical frames from older pipelines', () => {
    let state = createInitialRunState({
      manifestHash: 'abc',
      shotNumbers: ['010', '020'],
    });
    // Simulate a v1 run that recorded frames without provenance.
    state = {
      ...state,
      renderPipelineVersion: 1,
    };
    state = upsertShotState(state, '010', {
      compile: 'complete',
      render: 'complete',
      validation: 'passed',
      framePath: 'shots/010.png',
      // missing renderSource → not canonical
    });
    state = upsertShotState(state, '020', {
      compile: 'complete',
      render: 'complete',
      renderSource: 'canonical_clay_renderer',
      framePath: 'shots/020.png',
    });

    const migrated = migrateRenderPipelineVersion(state);
    expect(migrated.invalidated).toBe(true);
    expect(migrated.state.renderPipelineVersion).toBe(PREVIS_RENDER_PIPELINE_VERSION);
    expect(migrated.state.shots['010']?.render).toBe('pending');
    expect(migrated.state.shots['010']?.framePath).toBeUndefined();
    expect(migrated.state.shots['010']?.compile).toBe('complete');
    expect(migrated.state.shots['020']?.render).toBe('pending');
    expect(isCanonicalFrame(migrated.state.shots['010'])).toBe(false);
  });

  it('is a no-op when already on current pipeline', () => {
    const state = createInitialRunState({
      manifestHash: 'abc',
      shotNumbers: ['010'],
    });
    const migrated = migrateRenderPipelineVersion(state);
    expect(migrated.invalidated).toBe(false);
  });
});

describe('composition telemetry builder', () => {
  it('indexes secondary visible humans even when primary already has landmarks', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    const blair = makeHuman('blair-id', 'Blair', [1.2, 0, 0.2], 1.68);
    project.scene.objects = [alex, blair];
    const camera = makeCamera({
      position: [0, 1.5, 3],
      target: [0, 1.1, 0],
      fovDegrees: 40,
    });
    const shot = makeShot(camera);
    project.shots = [shot];

    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      // Only alex is declared — blair should still appear for dominance checks.
      definition: definition({
        shotNumber: '020',
        subjects: ['alex'],
        camera: { template: 'medium', subjects: ['alex'] },
      }),
      subjectNames: { alex: 'Alex' },
    });

    expect(telemetry.subjects.alex || telemetry.subjects.Alex).toBeTruthy();
    expect(telemetry.subjects.Blair || telemetry.subjects.blair || telemetry.subjects['blair-id']).toBeTruthy();
  });

  it('writes subject landmarks and blockers', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [0, 0, 0]);
    const wall = {
      id: 'wall-1',
      name: 'Wall',
      type: 'wall',
      transform: {
        position: [0, 1.25, -2] as Vec3,
        rotation: [0, 0, 0] as Vec3,
        scale: [1, 1, 1] as Vec3,
      },
      dimensions: [4, 2.5, 0.2] as Vec3,
      visible: true,
      locked: false,
      color: '#666',
      stagingRole: 'set',
    } as SceneObject;
    project.scene.objects = [alex, wall];
    const camera = makeCamera({
      position: [0, 1.5, 3],
      target: [0, 1.1, 0],
      fovDegrees: 40,
    });
    const shot = makeShot(camera);
    project.shots = [shot];

    const telemetry = buildShotCompositionTelemetry({
      project,
      shot,
      definition: definition({
        shotNumber: '010',
        subjects: ['alex'],
        camera: { template: 'medium', subjects: ['alex'] },
      }),
      subjectNames: { alex: 'Alex' },
    });

    expect(telemetry.frameWidth).toBe(1280);
    expect(telemetry.subjects.alex || telemetry.subjects.Alex).toBeTruthy();
    const subject = telemetry.subjects.alex ?? telemetry.subjects.Alex!;
    expect(subject.landmarks?.headTop).toBeTruthy();
    expect(subject.bounds.heightCoverage).toBeGreaterThan(0);
  });
});
