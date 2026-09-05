import type {
  LocationProject,
  ProductionEntityBinding,
  Shot,
  ShotActionContract,
  ShotActionSample,
  Vec3,
} from '../../domain/types';
import {
  getProductionConfiguration,
  resolveProductionBindingObjectIds,
} from '../previs/productionConfiguration';
import { getShotEffectiveState } from './spatialShotState';

const TIME_EPSILON_SECONDS = 1e-4;
const POSITION_EPSILON_METERS = 0.03;
const ROTATION_EPSILON_DEGREES = 0.25;

export interface ShotActionContinuityInspection {
  expectedCount: number;
  matchedCount: number;
  missingBindingCount: number;
  poseMismatchCount: number;
  trajectoryMismatchCount: number;
  visibilityMismatchCount: number;
  reviewRequiredCount: number;
  ok: boolean;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function angleDeltaDegrees(a: number, b: number): number {
  return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
}

function bindingObjectsAtTime(input: {
  project: LocationProject;
  shot: Shot;
  binding: ProductionEntityBinding;
  timeSeconds: number;
}) {
  const effective = getShotEffectiveState(input.project, input.shot.id, input.timeSeconds);
  if (!effective) return [];
  const objectIds = new Set(resolveProductionBindingObjectIds(input.project, input.binding));
  return effective.objects.filter((object) => objectIds.has(object.id));
}

function entityCenterAtTime(input: {
  project: LocationProject;
  shot: Shot;
  binding: ProductionEntityBinding;
  timeSeconds: number;
}): Vec3 | undefined {
  const objects = bindingObjectsAtTime(input);
  if (objects.length === 0) return undefined;
  return objects.reduce<Vec3>((sum, object) => [
    sum[0] + object.transform.position[0] / objects.length,
    sum[1] + object.transform.position[1] / objects.length,
    sum[2] + object.transform.position[2] / objects.length,
  ], [0, 0, 0]);
}

function sampleAtTime(action: ShotActionContract, timeSeconds: number): ShotActionSample | undefined {
  // Static blocking is durable shot intent, not a zero-duration event. It must
  // hold at every camera sample in a moving shot.
  if (action.mode === 'static_pose') return action.samples[0];
  return action.samples.find((sample) => (
    Math.abs(sample.timeSeconds - timeSeconds) <= TIME_EPSILON_SECONDS
  ));
}

export function inspectShotActionContinuity(input: {
  project: LocationProject;
  shot: Shot;
  timeSeconds: number;
}): ShotActionContinuityInspection | undefined {
  const configuration = getProductionConfiguration(input.project);
  const actions = configuration.shotContracts[input.shot.id]?.actions ?? [];
  if (actions.length === 0) return undefined;

  let expectedCount = 0;
  let matchedCount = 0;
  let missingBindingCount = 0;
  let poseMismatchCount = 0;
  let trajectoryMismatchCount = 0;
  let visibilityMismatchCount = 0;
  let reviewRequiredCount = 0;

  for (const action of actions) {
    const sample = sampleAtTime(action, input.timeSeconds);
    if (!sample) continue;
    expectedCount += 1;
    const binding = configuration.bindings[action.entityId];
    if (!binding) {
      missingBindingCount += 1;
      continue;
    }
    const objects = bindingObjectsAtTime({ ...input, binding });
    if (objects.length === 0) {
      missingBindingCount += 1;
      continue;
    }

    let matches = true;
    if (sample.requiresReview) {
      reviewRequiredCount += 1;
      matches = false;
    }
    if (sample.visible !== undefined) {
      const visible = objects.some((object) => object.visible !== false);
      if (visible !== sample.visible) {
        visibilityMismatchCount += 1;
        matches = false;
      }
    }
    if (sample.resolvedPose) {
      const poseMatches = objects.some((object) => object.humanPose?.presetId === sample.resolvedPose);
      if (!poseMatches) {
        poseMismatchCount += 1;
        matches = false;
      }
    }
    if (sample.position) {
      const baseline = action.samples.find((candidate) => candidate.position);
      const baselineExpected = baseline?.position;
      const baselineActual = baseline && entityCenterAtTime({
        project: input.project,
        shot: input.shot,
        binding,
        timeSeconds: baseline.timeSeconds,
      });
      const currentActual = entityCenterAtTime({ ...input, binding });
      const expectedDelta = baselineExpected ? subtract(sample.position, baselineExpected) : undefined;
      const actualDelta = baselineActual && currentActual ? subtract(currentActual, baselineActual) : undefined;
      if (!expectedDelta || !actualDelta || distance(expectedDelta, actualDelta) > POSITION_EPSILON_METERS) {
        trajectoryMismatchCount += 1;
        matches = false;
      }
    }
    if (sample.rotation && binding.kind === 'object') {
      const baseline = action.samples.find((candidate) => candidate.rotation);
      const baseObject = baseline
        ? bindingObjectsAtTime({
            project: input.project,
            shot: input.shot,
            binding,
            timeSeconds: baseline.timeSeconds,
          })[0]
        : undefined;
      const currentObject = objects[0];
      if (!baseline?.rotation || !baseObject || !currentObject || sample.rotation.some((value, axis) => {
        const expectedDelta = angleDeltaDegrees(value, baseline.rotation![axis]!);
        const actualDelta = angleDeltaDegrees(
          currentObject.transform.rotation[axis]!,
          baseObject.transform.rotation[axis]!,
        );
        return Math.abs(expectedDelta - actualDelta) > ROTATION_EPSILON_DEGREES;
      })) {
        trajectoryMismatchCount += 1;
        matches = false;
      }
    }
    if (matches) matchedCount += 1;
  }

  return {
    expectedCount,
    matchedCount,
    missingBindingCount,
    poseMismatchCount,
    trajectoryMismatchCount,
    visibilityMismatchCount,
    reviewRequiredCount,
    ok: expectedCount > 0 && matchedCount === expectedCount,
  };
}
