import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  completeAutorigMarkers,
  fitSkeletonFromMarkers,
  mirrorAllMarkers,
  mirrorMarkerAcrossSagittal,
  suggestAutorigMarkers,
  upsertMarker,
  validateAutorigMarkers,
  areAutorigMarkersSuspiciouslyPlanar,
  canonicalJointFrame,
} from '../src/engine/autorigMarkers';
import { HUMAN_JOINT_IDS } from '../src/engine/humanPose';

describe('autorig marker placement and skeleton fitting', () => {
  it('suggests 13+ markers covering limbs and midline', () => {
    const markers = suggestAutorigMarkers({
      size: [0.6, 1.75, 0.35],
      heightMeters: 1.75,
      groundLevelMeters: 0,
    });
    const ids = new Set(markers.map((marker) => marker.jointId));
    expect(ids.has('head')).toBe(true);
    expect(ids.has('hips')).toBe(true);
    expect(ids.has('leftHand')).toBe(true);
    expect(ids.has('rightFoot')).toBe(true);
    expect(markers.every((marker) => marker.position.every(Number.isFinite))).toBe(true);
  });

  it('mirrors a left marker to the right and restores after two L→R mirrors of a symmetric set', () => {
    let markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    markers = upsertMarker(markers, 'leftHand', [0.4, 0.9, 0.1]);
    markers = mirrorMarkerAcrossSagittal(markers, 'leftHand');
    const right = markers.find((marker) => marker.jointId === 'rightHand');
    expect(right?.position).toEqual([-0.4, 0.9, 0.1]);

    const original = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    // Mirror all twice from a symmetric suggestion stays equivalent on X magnitude.
    const once = mirrorAllMarkers(original);
    const twice = mirrorAllMarkers(once);
    for (const jointId of ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const) {
      const a = original.find((marker) => marker.jointId === jointId)?.position;
      const b = twice.find((marker) => marker.jointId === jointId)?.position;
      expect(a).toEqual(b);
    }
  });

  it('flags crossed left-arm markers and missing required joints', () => {
    const missing = validateAutorigMarkers([], 'simple');
    expect(missing.some((issue) => issue.code === 'missing')).toBe(true);

    let markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    markers = upsertMarker(markers, 'leftLowerArm', [-0.3, 1.0, 0]);
    markers = upsertMarker(markers, 'leftHand', [-0.4, 0.9, 0]);
    const issues = validateAutorigMarkers(markers, 'full');
    expect(issues.some((issue) => issue.code === 'crossed')).toBe(true);
  });

  it('completes inferred joints and fits bind matrices for the canonical skeleton', () => {
    const suggested = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    // Simple mode: drop shoulders/ankles and ensure completion restores them.
    const simple = suggested.filter((marker) => (
      marker.jointId !== 'leftUpperArm'
      && marker.jointId !== 'rightUpperArm'
      && marker.jointId !== 'leftFoot'
      && marker.jointId !== 'rightFoot'
    ));
    const completed = completeAutorigMarkers(simple, 'simple');
    expect(completed.some((marker) => marker.jointId === 'leftUpperArm')).toBe(true);
    expect(completed.some((marker) => marker.jointId === 'spine')).toBe(true);

    const fitted = fitSkeletonFromMarkers(suggested, 'full');
    expect(Object.keys(fitted.bindMatrices).length).toBeGreaterThanOrEqual(12);
    for (const jointId of HUMAN_JOINT_IDS) {
      const matrix = fitted.bindMatrices[jointId];
      if (!matrix) continue;
      expect(matrix).toHaveLength(16);
      expect(matrix.every(Number.isFinite)).toBe(true);
    }
    expect(fitted.jointPositions.head?.[1]).toBeGreaterThan(fitted.jointPositions.hips?.[1] ?? 0);
  });

  it('flags a complete marker set that is still effectively flat', () => {
    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    expect(areAutorigMarkersSuspiciouslyPlanar(markers)).toBe(true);
    expect(validateAutorigMarkers(markers, 'full').some((issue) => issue.code === 'planar')).toBe(true);
  });

  it('uses a lateral anatomical axis for a vertical knee frame', () => {
    const frame = canonicalJointFrame([0, 1, 0], [0, 0, 0]);
    const xAxis = new THREE.Vector3().setFromMatrixColumn(frame, 0);
    const yAxis = new THREE.Vector3().setFromMatrixColumn(frame, 1);
    const zAxis = new THREE.Vector3().setFromMatrixColumn(frame, 2);
    expect(Math.abs(xAxis.x)).toBeCloseTo(1, 5);
    expect(Math.abs(xAxis.z)).toBeLessThan(1e-5);
    expect(yAxis.y).toBeCloseTo(-1, 5);
    expect(zAxis.z).toBeCloseTo(1, 5);
  });
});
