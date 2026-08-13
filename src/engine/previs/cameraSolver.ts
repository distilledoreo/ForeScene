/**
 * Camera Solver V2 — template → finite position/target/FOV using real
 * screen-space projection scoring (not height/distance approximations alone).
 */

import type { CameraData, Vec3 } from '../../domain/types';
import type {
  PrevisCameraAngle,
  PrevisCameraTemplate,
  PrevisLensClass,
  PrevisShotDefinition,
} from './manifest';
import {
  aimHeightFraction,
  defaultLensClassForTemplate,
  FRAMING_COVERAGE,
  verticalFovForLens,
} from './framing';
import {
  cropHeightFraction,
  framingProfileForTemplate,
  HUMAN_LANDMARK_HEIGHT,
  landmarkWorldY,
  type FramingProfile,
} from './framingProfiles';
import {
  buildCameraMatrices,
  projectAabb,
  projectHumanLandmarks,
  projectUpperBodyRegion,
  projectWorldPoint,
  sampleSubjectOcclusion,
  shoulderWorldPoints,
  type WorldAabb,
} from './screenProjection';

export interface SubjectBounds {
  id: string;
  /** Axis-aligned world bounds. */
  min: Vec3;
  max: Vec3;
  /** Floor-contact position. */
  position: Vec3;
  /** Optional facing yaw in radians (0 = +Z). */
  yawRadians?: number;
}

/**
 * Issue-aware repair guidance for dedicated template re-solves.
 * Prefer this over generic dolly/orbit nudges.
 */
export interface CameraSolveRepairProfile {
  /** Exclude candidates near this camera (previous failed attempt). */
  avoidCamera?: CameraData;
  /** Minimum distance from avoidCamera position (meters). */
  minCameraDistanceFromAvoid?: number;
  /** Hard max foreground upper-body width coverage. */
  foregroundWidthMax?: number;
  /** Hard min foreground upper-body width coverage. */
  foregroundWidthMin?: number;
  /** Require FG width strictly below this (previous measurement). */
  previousForegroundWidth?: number;
  primaryHeightMax?: number;
  primaryHeightMin?: number;
  /** Prefer the opposite OTS shoulder from avoidCamera. */
  preferOppositeShoulder?: boolean;
  /** Minimum back offset from shoulder (meters). */
  minBack?: number;
  /** Minimum outward offset from shoulder (meters). */
  minOut?: number;
  /** Prefer wider FOV / wider lens class. */
  preferWiderLens?: boolean;
  /** Require FG area ≤ primary upper-body area (stricter than 1.5×). */
  requireLowerFgPrimaryOverlap?: boolean;
}

export interface CameraSolveInput {
  shot: PrevisShotDefinition;
  subjects: SubjectBounds[];
  aspectRatio: number;
  /** Optional solid blockers (AABB) for inside-geometry rejection / occlusion. */
  blockers?: Array<{ id?: string; min: Vec3; max: Vec3 }>;
  frameWidth?: number;
  frameHeight?: number;
  /** Optional repair profile for issue-aware re-solves. */
  repair?: CameraSolveRepairProfile;
}

export interface CameraSolveResult {
  camera: CameraData;
  score: number;
  warnings: string[];
  measuredCoverage?: number;
  /** Walls / solids to hide when no clear camera exists. */
  hideBlockerIds?: string[];
  notes?: string[];
  /** True when a hard-acceptance candidate was selected. */
  hardPass?: boolean;
}

const FRAME_W = 1280;
const FRAME_H = 720;

export function solveShotCamera(input: CameraSolveInput): CameraSolveResult {
  const template = input.shot.camera.template;
  if (template === 'over_the_shoulder') {
    return solveOverTheShoulder(input);
  }
  if (template === 'two_shot') {
    return solveTwoShot(input);
  }

  return solveGenericTemplate(input);
}

/**
 * Template-specific re-solve for repairs. Prefer this over generic dolly nudges
 * for two_shot and over_the_shoulder.
 */
export function reSolveTemplateCamera(input: CameraSolveInput): CameraSolveResult {
  return solveShotCamera(input);
}

function solveGenericTemplate(input: CameraSolveInput): CameraSolveResult {
  const template = input.shot.camera.template;
  const lensClass = input.shot.camera.lensClass ?? defaultLensClassForTemplate(template);
  const angle = input.shot.camera.angle ?? defaultAngleForTemplate(template);
  const fovDegrees = verticalFovForLens(lensClass, input.aspectRatio);
  const profile = framingProfileForTemplate(template);
  const warnings: string[] = [];
  const notes: string[] = [];
  const frameWidth = input.frameWidth ?? FRAME_W;
  const frameHeight = input.frameHeight ?? Math.round(frameWidth / input.aspectRatio);

  const subjectIds = new Set(input.shot.camera.subjects);
  let primary = input.subjects.filter((subject) => subjectIds.has(subject.id));
  if (primary.length === 0) {
    primary = [...input.subjects];
    warnings.push('No camera subjects matched; framing all provided subjects.');
  }

  const foreground = input.shot.camera.foregroundSubject
    ? input.subjects.find((subject) => subject.id === input.shot.camera.foregroundSubject)
    : undefined;

  const group = boundsUnion(primary.map((subject) => ({ min: subject.min, max: subject.max })));
  const centroid = centerOf(group);
  const subjectHeight = Math.max(0.4, group.max[1] - group.min[1]);
  const aimY = group.min[1] + subjectHeight * aimHeightFraction(template);
  const target: Vec3 = [centroid[0], aimY, centroid[2]];

  const cropFrac = cropHeightFraction(profile);
  const cropHeight = subjectHeight * cropFrac;
  const distance = distanceForCrop({
    cropHeight,
    targetScreenSpan: Math.max(0.15, profile.targetScreenBottom - profile.targetScreenTop),
    fovDegrees,
    template,
  });

  const candidates = buildCandidates({
    template,
    angle,
    target,
    distance,
    centroid,
    foreground,
    subjectHeight,
    primary,
    profile,
  });

  const lensOptions: PrevisLensClass[] = uniqueLenses(lensClass, template);
  let best: ScoredCandidate | undefined;
  let bestHardPass: ScoredCandidate | undefined;
  const blockerBoxes = (input.blockers ?? []).map((box, index) => ({
    objectId: box.id ?? `blocker_${index}`,
    min: box.min,
    max: box.max,
  }));

  for (const lens of lensOptions) {
    const fov = verticalFovForLens(lens, input.aspectRatio);
    for (const candidate of candidates) {
      const camera = makeCamera(candidate.position, candidate.target, fov, input.aspectRatio);
      if (!isFiniteVec3(camera.position) || !isFiniteVec3(camera.target)) continue;
      if (isInsideAny(camera.position, blockerBoxes)) continue;

      const scored = scoreCandidate({
        camera,
        template,
        profile,
        primary,
        allSubjects: input.subjects,
        foregroundId: foreground?.id,
        blockers: blockerBoxes,
        frameWidth,
        frameHeight,
        declaredSubjectIds: subjectIds,
      });
      if (!best || scored.score > best.score) {
        best = { ...scored, camera };
      }
      if (scored.hardPass && (!bestHardPass || scored.score > bestHardPass.score)) {
        bestHardPass = { ...scored, camera };
      }
    }
  }

  if (bestHardPass) best = bestHardPass;

  if (!best) {
    const fallbackPos: Vec3 = [target[0], target[1] + 0.3, target[2] + Math.max(2, distance)];
    warnings.push('All camera candidates rejected; using fallback.');
    return {
      camera: makeCamera(fallbackPos, target, fovDegrees, input.aspectRatio),
      score: -50,
      warnings,
      measuredCoverage: FRAMING_COVERAGE[template].target,
    };
  }

  let hideBlockerIds: string[] | undefined;
  if (best.wallBlocked && blockerBoxes.length > 0) {
    const wallIds = best.blockingWallIds ?? [];
    if (wallIds.length > 0) {
      hideBlockerIds = wallIds;
      notes.push('wall_hidden_for_camera');
      warnings.push(`Hiding ${wallIds.length} wall(s) for camera clarity.`);
      const remaining = blockerBoxes.filter((box) => !wallIds.includes(box.objectId));
      const rescored = scoreCandidate({
        camera: best.camera,
        template,
        profile,
        primary,
        allSubjects: input.subjects,
        foregroundId: foreground?.id,
        blockers: remaining,
        frameWidth,
        frameHeight,
        declaredSubjectIds: subjectIds,
      });
      best = { ...rescored, camera: best.camera };
    }
  }

  return {
    camera: best.camera,
    score: best.score,
    warnings,
    measuredCoverage: best.primaryHeightCoverage,
    hideBlockerIds,
    notes: notes.length > 0 ? notes : undefined,
  };
}

// ---------------------------------------------------------------------------
// Dedicated two-shot solver
// ---------------------------------------------------------------------------

/**
 * Deterministic balanced two-shot:
 * midpoint → perpendicular to actor line → distance fit → target height last.
 * Never falls back to unbalanced soft scoring when actors share depth.
 */
function solveTwoShot(input: CameraSolveInput): CameraSolveResult {
  const template = 'two_shot' as const;
  const lensClass = input.shot.camera.lensClass ?? defaultLensClassForTemplate(template);
  const profile = framingProfileForTemplate(template);
  const warnings: string[] = [];
  const notes: string[] = [];
  const frameWidth = input.frameWidth ?? FRAME_W;
  const frameHeight = input.frameHeight ?? Math.round(frameWidth / input.aspectRatio);
  const subjectIds = new Set(input.shot.camera.subjects);
  let primary = input.subjects.filter((subject) => subjectIds.has(subject.id));
  if (primary.length < 2) {
    primary = [...input.subjects].slice(0, 2);
  }
  if (primary.length < 2) {
    warnings.push('two_shot requires two subjects; falling back to generic solve.');
    return solveGenericTemplate({
      ...input,
      shot: { ...input.shot, camera: { ...input.shot.camera, template: 'wide' } },
    });
  }

  const a = primary[0]!;
  const b = primary[1]!;
  const dx = b.position[0] - a.position[0];
  const dz = b.position[2] - a.position[2];
  const len = Math.hypot(dx, dz) || 1;
  const perps: Array<[number, number]> = [
    [-dz / len, dx / len],
    [dz / len, -dx / len],
  ];

  const heightA = Math.max(0.4, a.max[1] - a.min[1]);
  const heightB = Math.max(0.4, b.max[1] - b.min[1]);
  const subjectHeight = Math.max(heightA, heightB);
  const floorY = Math.min(a.position[1], b.position[1]);
  // Balance first at mid-chest; refine headroom after.
  const balanceAimY = floorY + subjectHeight * 0.62;
  const midXZ: Vec3 = [
    (a.position[0] + b.position[0]) / 2,
    balanceAimY,
    (a.position[2] + b.position[2]) / 2,
  ];

  const blockerBoxes = (input.blockers ?? []).map((box, index) => ({
    objectId: box.id ?? `blocker_${index}`,
    min: box.min,
    max: box.max,
  }));

  const lensOptions = uniqueLenses(lensClass, template);
  let bestHard: ScoredCandidate | undefined;
  let bestAny: ScoredCandidate | undefined;

  // Distance band: start near enough to fill, then pull back until both fit.
  const baseDist = Math.max(2.2, len * 1.1 + subjectHeight * 1.4);

  for (const lens of lensOptions) {
    const fov = verticalFovForLens(lens, input.aspectRatio);
    for (const [px, pz] of perps) {
      for (let distScale = 0.75; distScale <= 1.85; distScale += 0.08) {
        const distance = baseDist * distScale;
        // Slight lateral bias keeps both subjects off the exact center line.
        for (const lateral of [0, 0.12, -0.12]) {
          const latX = (-pz) * lateral;
          const latZ = px * lateral;
          const position: Vec3 = [
            midXZ[0] + px * distance + latX,
            balanceAimY + subjectHeight * 0.06,
            midXZ[2] + pz * distance + latZ,
          ];
          if (isInsideAny(position, blockerBoxes)) continue;

          // Pass 1: balance aim only.
          let target: Vec3 = [midXZ[0], balanceAimY, midXZ[2]];
          let camera = makeCamera(position, target, fov, input.aspectRatio);
          let scored = scoreCandidate({
            camera,
            template,
            profile,
            primary: [a, b],
            allSubjects: input.subjects,
            blockers: blockerBoxes,
            frameWidth,
            frameHeight,
            declaredSubjectIds: subjectIds,
          });

          // Pass 2: only after area balance, nudge target height for headroom.
          if (scored.hardPass || twoShotAreaRatio(scored, a.id, b.id) <= 2.4) {
            const headA = scored.subjectScores[a.id]?.landmarks?.headTop?.y;
            const headB = scored.subjectScores[b.id]?.landmarks?.headTop?.y;
            if (headA !== undefined && headB !== undefined) {
              const meanHead = (headA + headB) / 2;
              const desired = 0.10;
              // Look down when heads too low (large Y).
              const excess = meanHead - desired;
              target = [midXZ[0], balanceAimY - excess * subjectHeight * 0.55, midXZ[2]];
              camera = makeCamera(position, target, fov, input.aspectRatio);
              scored = scoreCandidate({
                camera,
                template,
                profile,
                primary: [a, b],
                allSubjects: input.subjects,
                blockers: blockerBoxes,
                frameWidth,
                frameHeight,
                declaredSubjectIds: subjectIds,
              });
            }
          }

          const ratio = twoShotAreaRatio(scored, a.id, b.id);
          if (ratio > 2.4) {
            // Hard reject unbalanced depth.
            scored = { ...scored, hardPass: false, score: scored.score - 200 };
          }

          if (!bestAny || scored.score > bestAny.score) {
            bestAny = { ...scored, camera };
          }
          if (scored.hardPass && ratio <= 2.4 && (!bestHard || scored.score > bestHard.score)) {
            bestHard = { ...scored, camera };
          }
        }
      }
    }
  }

  if (!bestHard) {
    // Deterministic fallback: force perpendicular at a distance that equalizes scale.
    const forced = forceBalancedTwoShotCamera({
      a,
      b,
      midXZ,
      perps,
      subjectHeight,
      balanceAimY,
      fovDegrees: verticalFovForLens(lensClass, input.aspectRatio),
      aspectRatio: input.aspectRatio,
      blockerBoxes,
      frameWidth,
      frameHeight,
      subjectIds,
      allSubjects: input.subjects,
      profile,
    });
    if (forced) {
      bestHard = forced;
      notes.push('two_shot_deterministic_fallback');
    } else {
      warnings.push('two_shot deterministic fallback could not hard-pass; using best candidate.');
    }
  }

  const best = bestHard ?? bestAny;
  if (!best) {
    const fallbackPos: Vec3 = [midXZ[0], balanceAimY + 0.3, midXZ[2] + baseDist];
    warnings.push('two_shot: no candidates; emergency fallback.');
    return {
      camera: makeCamera(fallbackPos, [midXZ[0], balanceAimY, midXZ[2]], verticalFovForLens(lensClass, input.aspectRatio), input.aspectRatio),
      score: -50,
      warnings,
      measuredCoverage: FRAMING_COVERAGE.two_shot.target,
    };
  }

  let hideBlockerIds: string[] | undefined;
  if (best.wallBlocked && best.blockingWallIds?.length) {
    hideBlockerIds = best.blockingWallIds;
    notes.push('wall_hidden_for_camera');
  }

  return {
    camera: best.camera,
    score: best.score,
    warnings,
    measuredCoverage: best.primaryHeightCoverage,
    hideBlockerIds,
    notes: notes.length > 0 ? notes : undefined,
  };
}

function twoShotAreaRatio(
  scored: ScoredCandidate,
  idA: string,
  idB: string,
): number {
  const a = scored.subjectScores[idA]?.areaCoverage ?? 0;
  const b = scored.subjectScores[idB]?.areaCoverage ?? 0;
  return Math.max(a, b) / Math.max(1e-4, Math.min(a, b));
}

function forceBalancedTwoShotCamera(params: {
  a: SubjectBounds;
  b: SubjectBounds;
  midXZ: Vec3;
  perps: Array<[number, number]>;
  subjectHeight: number;
  balanceAimY: number;
  fovDegrees: number;
  aspectRatio: number;
  blockerBoxes: Array<{ objectId: string; min: Vec3; max: Vec3 }>;
  frameWidth: number;
  frameHeight: number;
  subjectIds: Set<string>;
  allSubjects: SubjectBounds[];
  profile: FramingProfile;
}): ScoredCandidate | undefined {
  // Equal depth: both actors at same distance from a pure perpendicular camera.
  let best: ScoredCandidate | undefined;
  for (const [px, pz] of params.perps) {
    for (let distance = 2.0; distance <= 10; distance += 0.15) {
      const position: Vec3 = [
        params.midXZ[0] + px * distance,
        params.balanceAimY + params.subjectHeight * 0.05,
        params.midXZ[2] + pz * distance,
      ];
      if (isInsideAny(position, params.blockerBoxes)) continue;
      let target: Vec3 = [params.midXZ[0], params.balanceAimY, params.midXZ[2]];
      let camera = makeCamera(position, target, params.fovDegrees, params.aspectRatio);
      let scored = scoreCandidate({
        camera,
        template: 'two_shot',
        profile: params.profile,
        primary: [params.a, params.b],
        allSubjects: params.allSubjects,
        blockers: params.blockerBoxes,
        frameWidth: params.frameWidth,
        frameHeight: params.frameHeight,
        declaredSubjectIds: params.subjectIds,
      });
      const ratio = twoShotAreaRatio(scored, params.a.id, params.b.id);
      if (ratio > 2.4) continue;

      // Headroom after balance.
      const headA = scored.subjectScores[params.a.id]?.landmarks?.headTop?.y;
      const headB = scored.subjectScores[params.b.id]?.landmarks?.headTop?.y;
      if (headA !== undefined && headB !== undefined) {
        const meanHead = (headA + headB) / 2;
        const excess = meanHead - 0.10;
        target = [params.midXZ[0], params.balanceAimY - excess * params.subjectHeight * 0.55, params.midXZ[2]];
        camera = makeCamera(position, target, params.fovDegrees, params.aspectRatio);
        scored = scoreCandidate({
          camera,
          template: 'two_shot',
          profile: params.profile,
          primary: [params.a, params.b],
          allSubjects: params.allSubjects,
          blockers: params.blockerBoxes,
          frameWidth: params.frameWidth,
          frameHeight: params.frameHeight,
          declaredSubjectIds: params.subjectIds,
        });
      }
      if (twoShotAreaRatio(scored, params.a.id, params.b.id) > 2.4) continue;
      if (!scored.hardPass) continue;
      if (!best || scored.score > best.score) {
        best = { ...scored, camera };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// OTS dedicated solver
// ---------------------------------------------------------------------------

/**
 * OTS primary framing size: preferred head→waist landmark span, else upper-body
 * height coverage. Never full-body AABB (legs off-frame inflate that metric).
 */
export function otsPrimaryCropCoverage(subject: {
  heightCoverage?: number;
  landmarks?: Record<string, { x?: number; y?: number; inFrame?: boolean }>;
  upperBodyHeightCoverage?: number;
}): number | undefined {
  const headY = subject.landmarks?.headTop?.y;
  const waistY = subject.landmarks?.waist?.y;
  if (typeof headY === 'number' && typeof waistY === 'number') {
    return waistY - headY;
  }
  if (typeof subject.upperBodyHeightCoverage === 'number') {
    return subject.upperBodyHeightCoverage;
  }
  // subjectScores for OTS already store upper-body occupancy as heightCoverage.
  if (typeof subject.heightCoverage === 'number') {
    return subject.heightCoverage;
  }
  return undefined;
}

/** Hard OTS acceptance — only hard-pass candidates may be selected silently. */
export function otsHardAccept(
  scored: {
    subjectScores: Record<string, SubjectScore>;
  },
  primaryId: string,
  foregroundId: string,
  repair?: CameraSolveRepairProfile,
): boolean {
  const prim = scored.subjectScores[primaryId];
  const fg = scored.subjectScores[foregroundId];
  if (!prim || !fg || prim.behindCamera || fg.behindCamera) return false;

  const headY = prim.landmarks?.headTop?.y;
  if (headY === undefined || headY < 0.08 || headY > 0.24) return false;

  // Landmark span / upper-body — not full-body AABB height.
  const primCrop = otsPrimaryCropCoverage(prim);
  const primHMin = repair?.primaryHeightMin ?? 0.35;
  const primHMax = repair?.primaryHeightMax ?? 0.85;
  if (primCrop === undefined || primCrop < primHMin || primCrop > primHMax) return false;

  const fgWMin = repair?.foregroundWidthMin ?? 0.12;
  const fgWMax = repair?.foregroundWidthMax ?? 0.40;
  if (fg.widthCoverage < fgWMin || fg.widthCoverage > fgWMax) return false;
  if (
    repair?.previousForegroundWidth !== undefined
    && fg.widthCoverage >= repair.previousForegroundWidth - 1e-4
  ) {
    return false;
  }

  if (!(fg.centerX < 0.32 || fg.centerX > 0.68)) return false;

  const areaCap = repair?.requireLowerFgPrimaryOverlap ? 1.0 : 1.5;
  if (fg.areaCoverage > prim.areaCoverage * areaCap + 1e-4) return false;

  if (prim.faceOccluded) return false;
  return true;
}

function solveOverTheShoulder(input: CameraSolveInput): CameraSolveResult {
  const template = 'over_the_shoulder' as const;
  const lensClass = input.shot.camera.lensClass ?? defaultLensClassForTemplate(template);
  const profile = framingProfileForTemplate(template);
  const repair = input.repair;
  const warnings: string[] = [];
  const notes: string[] = [];
  const frameWidth = input.frameWidth ?? FRAME_W;
  const frameHeight = input.frameHeight ?? Math.round(frameWidth / input.aspectRatio);

  const subjectIds = new Set(input.shot.camera.subjects);
  let primary = input.subjects.filter((subject) => subjectIds.has(subject.id));
  if (primary.length === 0) {
    primary = [...input.subjects];
    warnings.push('OTS: no primary subjects matched.');
  }
  const foreground = input.shot.camera.foregroundSubject
    ? input.subjects.find((subject) => subject.id === input.shot.camera.foregroundSubject)
    : undefined;
  if (!foreground) {
    warnings.push('OTS missing foreground subject bounds; approximating.');
    return solveGenericWithOtsBias(input, warnings);
  }

  const primarySubject = primary[0] ?? input.subjects.find((s) => s.id !== foreground.id);
  if (!primarySubject) {
    warnings.push('OTS missing primary subject.');
    return solveGenericWithOtsBias(input, warnings);
  }

  const fgHeight = Math.max(0.4, foreground.max[1] - foreground.min[1]);
  const primHeight = Math.max(0.4, primarySubject.max[1] - primarySubject.min[1]);
  const fgYaw = foreground.yawRadians
    ?? yawToward(foreground.position, primarySubject.position);

  const shoulders = shoulderWorldPoints({
    position: foreground.position,
    height: fgHeight,
    width: foreground.max[0] - foreground.min[0],
    yawRadians: fgYaw,
  });

  // Aim at primary upper torso/chest so primary head lands near Y 0.10–0.22.
  const primaryAim: Vec3 = [
    primarySubject.position[0],
    primarySubject.position[1] + primHeight * (
      HUMAN_LANDMARK_HEIGHT.chest * 0.7 + HUMAN_LANDMARK_HEIGHT.shoulders * 0.3
    ),
    primarySubject.position[2],
  ];

  // Infer previous shoulder side from avoidCamera for opposite-shoulder repairs.
  const preferredSideOrder = otsSideOrder({
    preferOpposite: repair?.preferOppositeShoulder === true,
    avoidCamera: repair?.avoidCamera,
    foreground,
    shoulders,
  });

  const minBack = repair?.minBack ?? 0.3;
  const minOut = repair?.minOut ?? 0.25;
  const backValues = [0.3, 0.5, 0.7, 0.9, 1.2].filter((v) => v + 1e-6 >= minBack);
  const outValues = [0.25, 0.45, 0.65, 0.85, 1.1].filter((v) => v + 1e-6 >= minOut);
  // Always keep at least the farthest samples if filters empty.
  if (backValues.length === 0) backValues.push(1.2);
  if (outValues.length === 0) outValues.push(1.1);

  const candidates: Array<{ position: Vec3; target: Vec3; side: 'left' | 'right' }> = [];
  for (const side of preferredSideOrder) {
    const shoulder = side === 'left' ? shoulders.left : shoulders.right;
    const awayFromPrimary: Vec3 = [
      foreground.position[0] - primarySubject.position[0],
      0,
      foreground.position[2] - primarySubject.position[2],
    ];
    const awayLen = Math.hypot(awayFromPrimary[0], awayFromPrimary[2]) || 1;
    const backX = awayFromPrimary[0] / awayLen;
    const backZ = awayFromPrimary[2] / awayLen;
    const outX = side === 'left' ? -Math.cos(fgYaw) : Math.cos(fgYaw);
    const outZ = side === 'left' ? -Math.sin(fgYaw) : Math.sin(fgYaw);

    // Farther back/out so only head/shoulder edge remains visible.
    for (const back of backValues) {
      for (const out of outValues) {
        for (const elev of [-0.02, 0.02, 0.06, 0.10]) {
          const position: Vec3 = [
            shoulder[0] + backX * back + outX * out,
            shoulder[1] + elev,
            shoulder[2] + backZ * back + outZ * out,
          ];
          if (repair?.avoidCamera && tooCloseToCamera(position, repair.avoidCamera, repair.minCameraDistanceFromAvoid ?? 0.4)) {
            continue;
          }
          for (const tOff of [0, -0.06, -0.12, 0.05, -0.18]) {
            candidates.push({
              position,
              target: [primaryAim[0], primaryAim[1] + tOff, primaryAim[2]],
              side,
            });
          }
        }
      }
    }
  }

  const blockerBoxes = (input.blockers ?? []).map((box, index) => ({
    objectId: box.id ?? `blocker_${index}`,
    min: box.min,
    max: box.max,
  }));

  let bestHard: (ScoredCandidate & { side?: 'left' | 'right' }) | undefined;
  let bestSoft: (ScoredCandidate & { side?: 'left' | 'right' }) | undefined;
  let lensOptions = uniqueLenses(lensClass, template);
  if (repair?.preferWiderLens) {
    lensOptions = uniqueLenses('wide', template);
  }

  for (const lens of lensOptions) {
    const fov = verticalFovForLens(lens, input.aspectRatio);
    for (const candidate of candidates) {
      if (isInsideAny(candidate.position, blockerBoxes)) continue;
      const camera = makeCamera(candidate.position, candidate.target, fov, input.aspectRatio);
      if (repair?.avoidCamera && tooCloseToCamera(camera.position, repair.avoidCamera, repair.minCameraDistanceFromAvoid ?? 0.4)) {
        continue;
      }

      const scored = scoreCandidate({
        camera,
        template,
        profile,
        primary: [primarySubject],
        allSubjects: input.subjects,
        foregroundId: foreground.id,
        blockers: blockerBoxes,
        frameWidth,
        frameHeight,
        declaredSubjectIds: subjectIds,
        otsSide: candidate.side,
      });

      const hard = otsHardAccept(scored, primarySubject.id, foreground.id, repair);
      const fg = scored.subjectScores[foreground.id];
      const prim = scored.subjectScores[primarySubject.id];
      let score = scored.score;

      const headY = prim?.landmarks?.headTop?.y;
      if (headY !== undefined) {
        if (headY >= 0.10 && headY <= 0.22) score += 50;
        else if (headY > 0.22) score -= (headY - 0.22) * 200;
        else score -= (0.10 - headY) * 150;
      }

      if (fg) {
        if (fg.widthCoverage >= 0.12 && fg.widthCoverage <= 0.32) score += 40;
        else score -= Math.abs(fg.widthCoverage - 0.20) * 100;
        const edge = candidate.side === 'left' ? fg.centerX : 1 - fg.centerX;
        if (edge < 0.28) score += 25;
        else score -= (edge - 0.28) * 80;
        if (Math.abs(fg.centerX - 0.5) < 0.18) score -= 45;
      }
      if (prim && fg && prim.areaCoverage > fg.areaCoverage * 0.9) score += 25;
      if (prim?.faceOccluded) score -= 60;
      if (hard) score += 80;
      // Prefer opposite shoulder when requested.
      if (repair?.preferOppositeShoulder && preferredSideOrder[0] === candidate.side) {
        score += 20;
      }

      const entry = { ...scored, score, camera, side: candidate.side, hardPass: hard };
      if (hard && (!bestHard || score > bestHard.score)) {
        bestHard = entry;
      }
      if (!bestSoft || score > bestSoft.score) {
        bestSoft = entry;
      }
    }
  }

  let best = bestHard;
  if (!best && bestSoft) {
    best = bestSoft;
    warnings.push(
      'OTS: no candidate met hard acceptance constraints; using soft fallback.',
    );
    notes.push('ots_soft_fallback');
  }

  if (!best) {
    warnings.push('OTS solver found no candidates; falling back.');
    return solveGenericWithOtsBias(input, warnings);
  }

  // Reapply OTS framing profile after hard selection: fix residual headroom via aim.
  if (best.hardPass) {
    const headY = best.subjectScores[primarySubject.id]?.landmarks?.headTop?.y;
    if (headY !== undefined && (headY < 0.08 || headY > 0.24)) {
      const excess = headY - 0.14;
      const adjusted = makeCamera(
        best.camera.position,
        [
          best.camera.target[0],
          best.camera.target[1] - excess * primHeight * 0.45,
          best.camera.target[2],
        ],
        best.camera.fovDegrees,
        input.aspectRatio,
      );
      const rescored = scoreCandidate({
        camera: adjusted,
        template,
        profile,
        primary: [primarySubject],
        allSubjects: input.subjects,
        foregroundId: foreground.id,
        blockers: blockerBoxes,
        frameWidth,
        frameHeight,
        declaredSubjectIds: subjectIds,
        otsSide: best.side,
      });
      if (otsHardAccept(rescored, primarySubject.id, foreground.id, repair)) {
        best = {
          ...rescored,
          camera: adjusted,
          side: best.side,
          score: rescored.score + 10,
          hardPass: true,
        };
        notes.push('ots_headroom_reprofile');
      }
    }
  }

  let hideBlockerIds: string[] | undefined;
  if (best.wallBlocked && best.blockingWallIds?.length) {
    hideBlockerIds = best.blockingWallIds;
    notes.push('wall_hidden_for_camera');
    const remaining = blockerBoxes.filter((box) => !hideBlockerIds!.includes(box.objectId));
    const rescored = scoreCandidate({
      camera: best.camera,
      template,
      profile,
      primary: [primarySubject],
      allSubjects: input.subjects,
      foregroundId: foreground.id,
      blockers: remaining,
      frameWidth,
      frameHeight,
      declaredSubjectIds: subjectIds,
      otsSide: best.side,
    });
    const hard = otsHardAccept(rescored, primarySubject.id, foreground.id, repair);
    best = {
      ...best,
      ...rescored,
      camera: best.camera,
      side: best.side,
      hardPass: hard,
    };
    notes.push('ots_reprofile_after_wall_hide');
  }

  return {
    camera: best.camera,
    score: best.score,
    warnings,
    measuredCoverage: best.primaryHeightCoverage,
    hideBlockerIds,
    notes: notes.length > 0 ? notes : undefined,
    hardPass: best.hardPass === true,
  };
}

function tooCloseToCamera(
  position: Vec3,
  avoid: CameraData,
  minDistance: number,
): boolean {
  const d = Math.hypot(
    position[0] - avoid.position[0],
    position[1] - avoid.position[1],
    position[2] - avoid.position[2],
  );
  return d < minDistance;
}

function otsSideOrder(params: {
  preferOpposite: boolean;
  avoidCamera?: CameraData;
  foreground: SubjectBounds;
  shoulders: { left: Vec3; right: Vec3 };
}): Array<'left' | 'right'> {
  if (!params.preferOpposite || !params.avoidCamera) {
    return ['left', 'right'];
  }
  const cam = params.avoidCamera.position;
  const dLeft = Math.hypot(
    cam[0] - params.shoulders.left[0],
    cam[2] - params.shoulders.left[2],
  );
  const dRight = Math.hypot(
    cam[0] - params.shoulders.right[0],
    cam[2] - params.shoulders.right[2],
  );
  // Prefer the side farther from the previous camera (opposite shoulder).
  return dLeft < dRight ? ['right', 'left'] : ['left', 'right'];
}

function solveGenericWithOtsBias(
  input: CameraSolveInput,
  warnings: string[],
): CameraSolveResult {
  const result = solveShotCamera({
    ...input,
    shot: {
      ...input.shot,
      camera: {
        ...input.shot.camera,
        template: 'medium',
      },
    },
  });
  return { ...result, warnings: [...warnings, ...result.warnings] };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function buildCandidates(params: {
  template: PrevisCameraTemplate;
  angle: PrevisCameraAngle;
  target: Vec3;
  distance: number;
  centroid: Vec3;
  foreground?: SubjectBounds;
  subjectHeight: number;
  primary: SubjectBounds[];
  profile: FramingProfile;
}): Array<{ position: Vec3; target: Vec3 }> {
  const yawOffsets = yawOffsetsForAngle(params.angle);
  const candidates: Array<{ position: Vec3; target: Vec3 }> = [];

  if (params.template === 'overhead') {
    for (const d of [params.distance * 0.85, params.distance, params.distance * 1.2]) {
      candidates.push({
        position: [params.target[0], params.target[1] + d, params.target[2]],
        target: params.target,
      });
      candidates.push({
        position: [params.target[0] + 0.5, params.target[1] + d * 0.9, params.target[2] + 0.5],
        target: params.target,
      });
    }
    return candidates;
  }

  const heightBiases = [
    heightBiasForTemplate(params.template, params.subjectHeight),
    heightBiasForTemplate(params.template, params.subjectHeight) + params.subjectHeight * 0.08,
  ];
  const targetHeightOffsets = [0, params.subjectHeight * 0.05, -params.subjectHeight * 0.04];
  const horizontalOffsets = [0, 0.2, -0.2];
  const distScales = [0.8, 1.0, 1.2, 1.4];

  for (const yawDeg of yawOffsets) {
    for (const distScale of distScales) {
      for (const heightBias of heightBiases) {
        for (const tOff of targetHeightOffsets) {
          for (const hOff of horizontalOffsets) {
            const distance = params.distance * distScale;
            const yaw = (yawDeg * Math.PI) / 180;
            let origin = params.target;
            if (params.template === 'over_the_shoulder' && params.foreground) {
              origin = [
                params.foreground.position[0],
                params.target[1],
                params.foreground.position[2],
              ];
            }
            // Horizontal target offset perpendicular to camera yaw.
            const perpX = Math.cos(yaw) * hOff;
            const perpZ = -Math.sin(yaw) * hOff;
            const target: Vec3 = [
              params.target[0] + perpX,
              params.target[1] + tOff,
              params.target[2] + perpZ,
            ];
            const position: Vec3 = [
              origin[0] + Math.sin(yaw) * distance,
              origin[1] + heightBias,
              origin[2] + Math.cos(yaw) * distance,
            ];
            candidates.push({ position, target });
          }
        }
      }
    }
  }

  // Two-shot: prioritize cameras perpendicular to the actor line so both sit
  // at similar depth (balanced scale).
  if (params.template === 'two_shot' && params.primary.length >= 2) {
    const a = params.primary[0]!;
    const b = params.primary[1]!;
    const dx = b.position[0] - a.position[0];
    const dz = b.position[2] - a.position[2];
    const len = Math.hypot(dx, dz) || 1;
    // Perpendicular directions in XZ.
    const perpDirs: Array<[number, number]> = [
      [-dz / len, dx / len],
      [dz / len, -dx / len],
    ];
    const mid: Vec3 = [
      (a.position[0] + b.position[0]) / 2,
      params.target[1],
      (a.position[2] + b.position[2]) / 2,
    ];
    for (const [px, pz] of perpDirs) {
      for (const distScale of [0.9, 1.1, 1.3]) {
        const d = params.distance * distScale;
        candidates.push({
          position: [
            mid[0] + px * d,
            mid[1] + heightBiasForTemplate(params.template, params.subjectHeight),
            mid[2] + pz * d,
          ],
          target: mid,
        });
      }
    }
  }

  // Cap combinatorial explosion for establishing/wide (fewer needed).
  if (params.template === 'establishing' || params.template === 'wide') {
    return candidates.filter((_, index) => index % 3 === 0);
  }

  return candidates;
}

function yawOffsetsForAngle(angle: PrevisCameraAngle): number[] {
  switch (angle) {
    case 'front':
      return [0, 8, -8, 15, -15];
    case 'profile':
      return [90, 85, 95, -90, 80, 100];
    case 'rear':
      return [180, 170, 190];
    case 'three_quarter':
    default:
      return [25, 35, 45, 55, -25, -35, -45, -55, 15, -15];
  }
}

function heightBiasForTemplate(template: PrevisCameraTemplate, subjectHeight: number): number {
  switch (template) {
    case 'low_angle':
      return -subjectHeight * 0.25;
    case 'high_angle':
      return subjectHeight * 0.45;
    case 'overhead':
      return subjectHeight;
    case 'close_up':
    case 'extreme_close_up':
      return subjectHeight * 0.12;
    case 'medium':
    case 'medium_close_up':
      return subjectHeight * 0.08;
    default:
      return subjectHeight * 0.05;
  }
}

function distanceForCrop(params: {
  cropHeight: number;
  targetScreenSpan: number;
  fovDegrees: number;
  template: PrevisCameraTemplate;
}): number {
  const fovRad = (params.fovDegrees * Math.PI) / 180;
  // screenSpan ≈ cropHeight / (2 * d * tan(fov/2))
  const denom = 2 * Math.tan(fovRad / 2) * Math.max(0.08, params.targetScreenSpan);
  let distance = params.cropHeight / denom;
  if (params.template === 'establishing') distance *= 1.35;
  if (params.template === 'insert') distance *= 0.45;
  if (params.template === 'close_up') distance *= 0.78;
  if (params.template === 'medium_close_up') distance *= 0.9;
  return Math.min(40, Math.max(0.45, distance));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface SubjectScore {
  centerX: number;
  centerY: number;
  widthCoverage: number;
  heightCoverage: number;
  areaCoverage: number;
  clipped: boolean;
  behindCamera: boolean;
  faceOccluded?: boolean;
  landmarks?: Record<string, { x: number; y: number; inFrame: boolean }>;
}

interface ScoredCandidate {
  camera: CameraData;
  score: number;
  primaryHeightCoverage: number;
  wallBlocked: boolean;
  blockingWallIds?: string[];
  subjectScores: Record<string, SubjectScore>;
  /** False when hard template constraints fail (e.g. two-shot balance). */
  hardPass: boolean;
}

function scoreCandidate(params: {
  camera: CameraData;
  template: PrevisCameraTemplate;
  profile: FramingProfile;
  primary: SubjectBounds[];
  allSubjects: SubjectBounds[];
  foregroundId?: string;
  blockers: Array<{ objectId: string; min: Vec3; max: Vec3 }>;
  frameWidth: number;
  frameHeight: number;
  declaredSubjectIds: Set<string>;
  otsSide?: 'left' | 'right';
}): ScoredCandidate {
  const matrices = buildCameraMatrices(params.camera, params.frameWidth, params.frameHeight);
  let score = 0;
  const subjectScores: Record<string, SubjectScore> = {};
  const blockingWallIds = new Set<string>();
  let wallBlocked = false;
  let primaryHeightCoverage = 0;
  let hardPass = true;

  const primaryIds = new Set(params.primary.map((s) => s.id));

  for (const subject of params.allSubjects) {
    const aabb: WorldAabb = { min: subject.min, max: subject.max };
    const bounds = projectAabb(aabb, matrices);
    const height = Math.max(0.01, subject.max[1] - subject.min[1]);
    const landmarks = projectHumanLandmarks({
      position: subject.position,
      height,
      matrices,
    });
    const landmarkMap: Record<string, { x: number; y: number; inFrame: boolean }> = {};
    for (const [name, point] of Object.entries(landmarks)) {
      landmarkMap[name] = {
        x: point.x / params.frameWidth,
        y: point.y / params.frameHeight,
        inFrame: point.inFrame,
      };
    }

    const samples = [
      { id: 'head', point: [subject.position[0], landmarkWorldY(subject.position[1], height, 'headTop'), subject.position[2]] as Vec3 },
      { id: 'chest', point: [subject.position[0], landmarkWorldY(subject.position[1], height, 'chest'), subject.position[2]] as Vec3 },
      { id: 'waist', point: [subject.position[0], landmarkWorldY(subject.position[1], height, 'waist'), subject.position[2]] as Vec3 },
      { id: 'center', point: centerOf(aabb) },
    ];
    const occlusion = sampleSubjectOcclusion({
      cameraPosition: params.camera.position,
      subjectSamples: samples,
      blockers: params.blockers,
    });
    if (occlusion.wallDominant || occlusion.occludedSampleRatio > 0.4) {
      wallBlocked = true;
      for (const hit of occlusion.hits) {
        blockingWallIds.add(hit.objectId);
      }
    }

    // For OTS foreground / close-ups prefer upper-body occupancy so offscreen
    // legs do not inflate coverage.
    const useUpper = params.template === 'over_the_shoulder'
      || params.template === 'close_up'
      || params.template === 'extreme_close_up'
      || params.template === 'medium_close_up';
    const upper = useUpper
      ? projectUpperBodyRegion({
        position: subject.position,
        height,
        width: Math.max(0.2, subject.max[0] - subject.min[0]),
        depth: Math.max(0.2, subject.max[2] - subject.min[2]),
        matrices,
      })
      : undefined;
    const occ = upper ?? bounds;

    subjectScores[subject.id] = {
      centerX: occ.centerX,
      centerY: occ.centerY,
      widthCoverage: occ.widthCoverage,
      heightCoverage: occ.heightCoverage,
      areaCoverage: occ.areaCoverage,
      clipped: bounds.clipped,
      behindCamera: bounds.behindCamera,
      faceOccluded: occlusion.faceOccluded,
      landmarks: landmarkMap,
    };

    const isPrimary = primaryIds.has(subject.id);
    const isForeground = subject.id === params.foregroundId;

    if (isPrimary) {
      primaryHeightCoverage = Math.max(primaryHeightCoverage, bounds.heightCoverage);

      // Framing accuracy vs profile landmarks.
      const head = landmarkMap.headTop;
      const bottomKey = params.profile.bottomLandmark;
      const bottom = landmarkMap[bottomKey];
      if (head && !head.inFrame && head.y > 0 && head.y < 1) {
        // partially ok
      }
      if (head) {
        const err = Math.abs(head.y - params.profile.targetScreenTop);
        score += 40 - err * 120;
        if (head.y < 0.02) score -= 35; // clipped head
        if (head.y > 0.35 && params.template !== 'establishing' && params.template !== 'wide') {
          score -= 20;
        }
      }
      if (bottom) {
        const err = Math.abs(bottom.y - params.profile.targetScreenBottom);
        score += 30 - err * 80;
      }

      // Coverage band.
      const range = FRAMING_COVERAGE[params.template];
      const cov = bounds.heightCoverage;
      if (cov >= range.min && cov <= range.max) {
        score += 50 - Math.abs(cov - range.target) * 60;
      } else if (cov < range.min) {
        score -= (range.min - cov) * 100;
      } else {
        score -= (cov - range.max) * 80;
      }

      if (bounds.behindCamera) score -= 100;
      if (bounds.clipped && params.template !== 'close_up' && params.template !== 'extreme_close_up') {
        score -= 15;
      }
      if (occlusion.faceOccluded) score -= 45;
      if (occlusion.occludedSampleRatio > 0.3) score -= 30;

      // Look-room / direction preference: slight bias toward frame center for singles.
      if (params.primary.length === 1) {
        score += 10 - Math.abs(bounds.centerX - 0.5) * 20;
      }
    } else if (!isForeground) {
      // Unwanted secondary dominance.
      const primaryArea = Math.max(
        ...params.primary.map((p) => subjectScores[p.id]?.areaCoverage ?? 0),
        0.001,
      );
      if (
        params.declaredSubjectIds.size > 0
        && !params.declaredSubjectIds.has(subject.id)
        && bounds.areaCoverage > primaryArea * 0.35
      ) {
        score -= 40 + (bounds.areaCoverage / primaryArea) * 20;
      }
    }
  }

  // Two-shot balance — hard constraints, not soft penalties alone.
  if (params.template === 'two_shot' && params.primary.length >= 2) {
    const a = subjectScores[params.primary[0]!.id];
    const b = subjectScores[params.primary[1]!.id];
    if (!a || !b || a.behindCamera || b.behindCamera || !a.areaCoverage || !b.areaCoverage) {
      hardPass = false;
      score -= 200;
    } else {
      const sep = Math.abs(a.centerX - b.centerX);
      const ratio = Math.max(a.areaCoverage, b.areaCoverage)
        / Math.max(1e-4, Math.min(a.areaCoverage, b.areaCoverage));
      const headA = a.landmarks?.headTop?.y;
      const headB = b.landmarks?.headTop?.y;
      const headDelta = (headA !== undefined && headB !== undefined)
        ? Math.abs(headA - headB)
        : 0;
      const safeMargins = a.centerX > 0.08 && a.centerX < 0.92
        && b.centerX > 0.08 && b.centerX < 0.92;
      const bothVisible = a.areaCoverage > 0.01 && b.areaCoverage > 0.01
        && !a.behindCamera && !b.behindCamera;

      // Hard gates for a conventional balanced two-shot.
      if (!bothVisible) hardPass = false;
      if (ratio > 2.4) hardPass = false;
      if (sep < 0.12 || sep > 0.65) hardPass = false;
      if (!safeMargins) hardPass = false;
      if (headDelta > 0.18) hardPass = false;

      if (hardPass) {
        score += 40;
        score += 25 - Math.abs(sep - 0.32) * 40;
        score += 20 - (ratio - 1) * 15;
        score += 10 - headDelta * 40;
      } else {
        score -= 150 + Math.max(0, ratio - 2.4) * 40;
      }
    }
  }

  // Insert: prop should dominate (primary[0] treated as prop).
  if (params.template === 'insert' && params.primary[0]) {
    const p = subjectScores[params.primary[0].id];
    if (p && p.areaCoverage > 0.2) score += 30;
  }

  // Blocker screen occupancy.
  for (const blocker of params.blockers) {
    const bounds = projectAabb({ min: blocker.min, max: blocker.max }, matrices);
    if (bounds.areaCoverage > 0.45 && bounds.centerX > 0.2 && bounds.centerX < 0.8) {
      score -= 25;
      wallBlocked = true;
      blockingWallIds.add(blocker.objectId);
    }
  }

  // Camera inside geometry already filtered; slight reward for clear freestanding.
  if (!wallBlocked) score += 8;

  return {
    camera: params.camera,
    score,
    primaryHeightCoverage,
    wallBlocked,
    blockingWallIds: [...blockingWallIds],
    subjectScores,
    hardPass,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultAngleForTemplate(template: PrevisCameraTemplate): PrevisCameraAngle {
  switch (template) {
    case 'profile':
      return 'profile';
    case 'over_the_shoulder':
      return 'three_quarter';
    default:
      return 'three_quarter';
  }
}

function uniqueLenses(primary: PrevisLensClass, template: PrevisCameraTemplate): PrevisLensClass[] {
  const set = new Set<PrevisLensClass>([primary]);
  if (template === 'close_up' || template === 'extreme_close_up') {
    set.add('long');
    set.add('normal');
  } else if (template === 'wide' || template === 'establishing' || template === 'two_shot') {
    set.add('wide');
    set.add('normal');
  } else {
    set.add('normal');
    set.add(primary === 'long' ? 'normal' : 'long');
  }
  return [...set];
}

function makeCamera(
  position: Vec3,
  target: Vec3,
  fovDegrees: number,
  aspectRatio: number,
): CameraData {
  return {
    position: [...position] as Vec3,
    target: [...target] as Vec3,
    fovDegrees,
    aspectRatio,
    near: 0.05,
    far: 500,
  };
}

function boundsUnion(boxes: Array<{ min: Vec3; max: Vec3 }>): { min: Vec3; max: Vec3 } {
  if (boxes.length === 0) {
    return { min: [0, 0, 0], max: [0, 1.7, 0] };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    min[0] = Math.min(min[0], box.min[0]);
    min[1] = Math.min(min[1], box.min[1]);
    min[2] = Math.min(min[2], box.min[2]);
    max[0] = Math.max(max[0], box.max[0]);
    max[1] = Math.max(max[1], box.max[1]);
    max[2] = Math.max(max[2], box.max[2]);
  }
  return { min, max };
}

function centerOf(box: { min: Vec3; max: Vec3 }): Vec3 {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
}

function isFiniteVec3(value: Vec3): boolean {
  return value.every((component) => Number.isFinite(component));
}

function isInsideAny(
  point: Vec3,
  blockers: Array<{ min: Vec3; max: Vec3 }>,
): boolean {
  const margin = 0.08;
  return blockers.some((box) => (
    point[0] >= box.min[0] + margin && point[0] <= box.max[0] - margin
    && point[1] >= box.min[1] + margin && point[1] <= box.max[1] - margin
    && point[2] >= box.min[2] + margin && point[2] <= box.max[2] - margin
  ));
}

function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

export function subjectBoundsFromPlacement(params: {
  id: string;
  position: Vec3;
  height?: number;
  width?: number;
  depth?: number;
  yawRadians?: number;
}): SubjectBounds {
  const height = params.height ?? 1.75;
  const width = params.width ?? 0.55;
  const depth = params.depth ?? 0.55;
  const min: Vec3 = [
    params.position[0] - width / 2,
    params.position[1],
    params.position[2] - depth / 2,
  ];
  const max: Vec3 = [
    params.position[0] + width / 2,
    params.position[1] + height,
    params.position[2] + depth / 2,
  ];
  return {
    id: params.id,
    min,
    max,
    position: params.position,
    yawRadians: params.yawRadians,
  };
}

// Re-export landmark height for tests / tooling.
export { HUMAN_LANDMARK_HEIGHT };
