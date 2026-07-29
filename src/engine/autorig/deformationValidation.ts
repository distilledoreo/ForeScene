import type { HumanJointId, Vec3 } from '../../domain/types';
import {
  AUTORIG_REGION_CODE,
  AUTORIG_REGION_ID_BY_CODE,
  type AutorigBodyRegionId,
  type AutorigRegionCode,
  isValidRegionCode,
} from './regions';
import type { CanonicalAutorigTopology } from './topology';
import type { SkinWeightBuffers } from '../autorigSkinWeights';

/** Plain-language issues shown in the Check Pose step. */
export interface AutorigDeformationIssue {
  id: string;
  /** User-facing sentence — no solver jargon. */
  message: string;
  /** Broad region to focus on when relabeling. */
  region?: AutorigBodyRegionId;
  /** Vertex indices worth highlighting (optional). */
  vertexIndices?: Uint32Array;
  severity: 'warning' | 'blocking';
}

export interface DeformationValidationInput {
  restPositions: ArrayLike<number>;
  posedPositions: ArrayLike<number>;
  regionLabels?: Uint8Array | null;
  topology?: CanonicalAutorigTopology | null;
  jointPositions?: Partial<Record<HumanJointId, Vec3>>;
  heightMeters?: number;
  buffers?: SkinWeightBuffers | null;
}

const REGION_LABEL: Record<AutorigBodyRegionId, string> = {
  head: 'head',
  torso: 'torso',
  leftArm: 'left arm',
  rightArm: 'right arm',
  leftLeg: 'left leg',
  rightLeg: 'right leg',
};

function regionOf(code: number): AutorigBodyRegionId | null {
  if (!isValidRegionCode(code)) return null;
  return AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode];
}

/**
 * Validate skeleton / region / weight buffers before enabling Apply.
 * Warnings do not block; only clearly impossible states are blocking.
 */
export function validateAutorigRigReady(params: {
  hasRequiredMarkers: boolean;
  headAboveHips: boolean;
  kneesBelowHips: boolean;
  anklesBelowKnees: boolean;
  limbsNotCrossed: boolean;
  regionLabels?: Uint8Array | null;
  buffers?: SkinWeightBuffers | null;
}): AutorigDeformationIssue[] {
  const issues: AutorigDeformationIssue[] = [];
  if (!params.hasRequiredMarkers) {
    issues.push({
      id: 'missing-markers',
      message: 'Some joints are still missing. Place every marker before applying the rig.',
      severity: 'blocking',
    });
  }
  if (!params.headAboveHips) {
    issues.push({
      id: 'head-below-hips',
      message: 'The head marker should sit above the hips.',
      severity: 'blocking',
    });
  }
  if (!params.kneesBelowHips || !params.anklesBelowKnees) {
    issues.push({
      id: 'leg-order',
      message: 'Check that knees sit below the hips and ankles sit below the knees.',
      severity: 'warning',
    });
  }
  if (!params.limbsNotCrossed) {
    issues.push({
      id: 'limbs-crossed',
      message: 'Left and right limb markers look crossed. Mirror or adjust them before continuing.',
      severity: 'warning',
    });
  }
  if (params.regionLabels) {
    const counts = new Uint32Array(7);
    for (let i = 0; i < params.regionLabels.length; i += 1) {
      const code = params.regionLabels[i]!;
      if (isValidRegionCode(code)) counts[code]! += 1;
    }
    for (const region of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'head'] as AutorigBodyRegionId[]) {
      const code = AUTORIG_REGION_CODE[region];
      if (counts[code]! < 3) {
        issues.push({
          id: `tiny-region-${region}`,
          message: `Very little of the model is labeled as the ${REGION_LABEL[region]}. Check that area.`,
          region,
          severity: 'warning',
        });
      }
    }
  }
  if (params.buffers) {
    const { indices, weights, jointOrder } = params.buffers;
    const ipv = params.buffers.influencesPerVertex || 4;
    const vertexCount = Math.floor(weights.length / ipv);
    for (let v = 0; v < Math.min(vertexCount, 64); v += 1) {
      let sum = 0;
      for (let i = 0; i < ipv; i += 1) {
        const w = weights[v * ipv + i]!;
        if (!Number.isFinite(w) || w < -1e-6) {
          issues.push({
            id: 'bad-weights',
            message: 'Some skin weights look invalid. Turn on Fix deformation and try again.',
            severity: 'blocking',
          });
          return issues;
        }
        sum += w;
        const jointIndex = indices[v * ipv + i]!;
        if (jointIndex >= jointOrder.length) {
          issues.push({
            id: 'bad-bone-index',
            message: 'The rig refers to a missing joint. Adjust joints and regenerate.',
            severity: 'blocking',
          });
          return issues;
        }
      }
      if (Math.abs(sum - 1) > 0.05) {
        issues.push({
          id: 'weight-sum',
          message: 'Some skin weights do not add up correctly. Turn on Fix deformation and try again.',
          severity: 'warning',
        });
        break;
      }
    }
  }
  return issues;
}

/**
 * Compare rest vs posed vertex positions and produce plain-language warnings.
 */
export function analyzeDiagnosticPose(params: DeformationValidationInput): AutorigDeformationIssue[] {
  const issues: AutorigDeformationIssue[] = [];
  const height = params.heightMeters ?? 1.75;
  const explodeThreshold = height * 1.75;
  const farThreshold = height * 0.85;
  const vertexCount = Math.floor(Math.min(params.restPositions.length, params.posedPositions.length) / 3);
  if (vertexCount === 0) return issues;

  const explodeVerts: number[] = [];
  const farVerts: number[] = [];
  let restMinY = Infinity;
  let restMaxY = -Infinity;
  let poseMinY = Infinity;
  let poseMaxY = -Infinity;

  for (let v = 0; v < vertexCount; v += 1) {
    const i = v * 3;
    const rx = params.restPositions[i]!;
    const ry = params.restPositions[i + 1]!;
    const rz = params.restPositions[i + 2]!;
    const px = params.posedPositions[i]!;
    const py = params.posedPositions[i + 1]!;
    const pz = params.posedPositions[i + 2]!;
    if (![rx, ry, rz, px, py, pz].every(Number.isFinite)) {
      issues.push({
        id: 'nan-vertex',
        message: 'Part of the model became invalid while posing. Turn on Fix deformation and relabel.',
        severity: 'blocking',
      });
      return issues;
    }
    restMinY = Math.min(restMinY, ry);
    restMaxY = Math.max(restMaxY, ry);
    poseMinY = Math.min(poseMinY, py);
    poseMaxY = Math.max(poseMaxY, py);
    const dist = Math.hypot(px - rx, py - ry, pz - rz);
    if (dist > explodeThreshold) explodeVerts.push(v);
    else if (dist > farThreshold) farVerts.push(v);
  }

  const restSpan = Math.max(restMaxY - restMinY, 1e-3);
  const poseSpan = Math.max(poseMaxY - poseMinY, 1e-3);
  if (poseSpan > restSpan * 3.5) {
    issues.push({
      id: 'bounds-explode',
      message: 'The posed character stretched much taller than the rest pose. Check limb labels.',
      severity: 'warning',
    });
  }

  const pickRegionMessage = (verts: number[], template: string): AutorigDeformationIssue | null => {
    if (verts.length === 0 || !params.regionLabels) return null;
    const counts = new Map<AutorigBodyRegionId, number>();
    for (const v of verts) {
      const region = regionOf(params.regionLabels[v]!);
      if (!region) continue;
      counts.set(region, (counts.get(region) ?? 0) + 1);
    }
    let best: AutorigBodyRegionId | undefined;
    let bestCount = 0;
    for (const [region, count] of counts) {
      if (count > bestCount) {
        best = region;
        bestCount = count;
      }
    }
    if (!best) return null;
    return {
      id: `region-${best}-${template}`,
      message: template.replace('{region}', REGION_LABEL[best]),
      region: best,
      vertexIndices: Uint32Array.from(verts.slice(0, 256)),
      severity: 'warning',
    };
  };

  if (explodeVerts.length > 0) {
    issues.push(pickRegionMessage(
      explodeVerts,
      'The {region} may be assigned incorrectly — it moves too far in this pose. Check the highlighted area.',
    ) ?? {
      id: 'explode',
      message: 'Some parts move too far in this pose. Turn on Fix deformation and paint the problem area.',
      vertexIndices: Uint32Array.from(explodeVerts.slice(0, 256)),
      severity: 'warning',
    });
  } else if (farVerts.length > Math.max(8, vertexCount * 0.02)) {
    issues.push(pickRegionMessage(
      farVerts,
      'The {region} may be bending with the wrong limb. Check the highlighted area.',
    ) ?? {
      id: 'far-motion',
      message: 'Some areas bend farther than expected. Try relabeling that body part.',
      vertexIndices: Uint32Array.from(farVerts.slice(0, 256)),
      severity: 'warning',
    });
  }

  // Opposite-limb drag heuristic: left-labeled verts that move strongly toward right chain.
  if (params.regionLabels && params.jointPositions?.rightUpperArm && params.jointPositions.leftUpperArm) {
    const rightArm = params.jointPositions.rightUpperArm;
    const leftArm = params.jointPositions.leftUpperArm;
    const suspicious: number[] = [];
    for (let v = 0; v < vertexCount; v += 1) {
      if (params.regionLabels[v] !== AUTORIG_REGION_CODE.leftArm) continue;
      const i = v * 3;
      const px = params.posedPositions[i]!;
      const py = params.posedPositions[i + 1]!;
      const pz = params.posedPositions[i + 2]!;
      const toRight = Math.hypot(px - rightArm[0], py - rightArm[1], pz - rightArm[2]);
      const toLeft = Math.hypot(px - leftArm[0], py - leftArm[1], pz - leftArm[2]);
      if (toRight + 0.08 < toLeft) suspicious.push(v);
    }
    if (suspicious.length > Math.max(4, vertexCount * 0.01)) {
      issues.push({
        id: 'left-arm-dragged-right',
        message: 'The left arm may be assigned to the right side. Check the highlighted area.',
        region: 'leftArm',
        vertexIndices: Uint32Array.from(suspicious.slice(0, 256)),
        severity: 'warning',
      });
    }
  }

  return issues;
}

/** Neutral pose must reproduce rest positions within tolerance. */
export function validateNeutralDeformation(params: {
  restPositions: ArrayLike<number>;
  posedPositions: ArrayLike<number>;
  tolerance?: number;
}): AutorigDeformationIssue[] {
  const tolerance = params.tolerance ?? 1e-3;
  const vertexCount = Math.floor(Math.min(params.restPositions.length, params.posedPositions.length) / 3);
  let worst = 0;
  let bad = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    const i = v * 3;
    const dx = params.posedPositions[i]! - params.restPositions[i]!;
    const dy = params.posedPositions[i + 1]! - params.restPositions[i + 1]!;
    const dz = params.posedPositions[i + 2]! - params.restPositions[i + 2]!;
    const dist = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(dist)) {
      return [{
        id: 'neutral-nan',
        message: 'The neutral pose broke the model. Adjust joints or body parts and try again.',
        severity: 'blocking',
      }];
    }
    worst = Math.max(worst, dist);
    if (dist > tolerance) bad += 1;
  }
  if (bad > 0 && worst > tolerance * 10) {
    return [{
      id: 'neutral-drift',
      message: 'The resting pose no longer matches the imported shape. Regenerate the rig.',
      severity: 'blocking',
    }];
  }
  return [];
}
