import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  areAutorigMarkersSuspiciouslyPlanar,
  centerAutorigMarkersDepth,
  completeAutorigMarkers,
  fitSkeletonFromMarkers,
  suggestAutorigMarkers,
  validateAutorigMarkers,
} from '../src/engine/autorigMarkers';
import { buildSkinBoneSegments, generateDeterministicSkinWeights } from '../src/engine/autorigSkinWeights';
import { CURRENT_AUTORIG_RIG_GENERATION_VERSION } from '../src/engine/poseableRigNormalize';

// Re-export path sanity: hips/terminals/planar/depth/poseHint/fallback for P0 acceptance.

describe('P0 autorig skeleton correctness', () => {
  it('places hip sockets near pelvis height with lateral offset, not mid-thigh', () => {
    const size: [number, number, number] = [0.55, 1.75, 0.32];
    const markers = suggestAutorigMarkers({ size, heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const hips = fitted.jointPositions.hips!;
    const leftHip = fitted.jointPositions.leftUpperLeg!;
    const rightHip = fitted.jointPositions.rightUpperLeg!;
    const leftKnee = fitted.jointPositions.leftLowerLeg!;
    const rightKnee = fitted.jointPositions.rightLowerLeg!;

    // Lateral sockets (significant |X|).
    expect(leftHip[0]).toBeGreaterThan(0.05);
    expect(rightHip[0]).toBeLessThan(-0.05);
    // Near pelvis Y — not halfway to the knee.
    expect(Math.abs(leftHip[1] - hips[1])).toBeLessThan(0.08);
    expect(Math.abs(rightHip[1] - hips[1])).toBeLessThan(0.08);
    const midThighY = (hips[1] + leftKnee[1]) / 2;
    expect(Math.abs(leftHip[1] - midThighY)).toBeGreaterThan(0.12);
    expect(Math.abs(rightHip[1] - (hips[1] + rightKnee[1]) / 2)).toBeGreaterThan(0.12);

    // Editable in full marker set.
    expect(validateAutorigMarkers([], 'full').some((i) => i.jointIds?.includes('leftUpperLeg'))).toBe(true);
    expect(markers.some((m) => m.jointId === 'leftUpperLeg')).toBe(true);
  });

  it('hand and foot bone segments aim through palm and toes, not a pure +Y stub', () => {
    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    expect(fitted.jointPositions.leftHandEnd).toBeDefined();
    expect(fitted.jointPositions.leftToeBase).toBeDefined();
    expect(fitted.jointPositions.rightHandEnd).toBeDefined();
    expect(fitted.jointPositions.rightToeBase).toBeDefined();

    const segments = buildSkinBoneSegments(fitted.jointPositions);
    const leftHand = segments.find((s) => s.jointId === 'leftHand');
    const leftFoot = segments.find((s) => s.jointId === 'leftFoot');
    expect(leftHand).toBeDefined();
    expect(leftFoot).toBeDefined();

    const handLen = Math.hypot(
      leftHand!.end[0] - leftHand!.start[0],
      leftHand!.end[1] - leftHand!.start[1],
      leftHand!.end[2] - leftHand!.start[2],
    );
    const footLen = Math.hypot(
      leftFoot!.end[0] - leftFoot!.start[0],
      leftFoot!.end[1] - leftFoot!.start[1],
      leftFoot!.end[2] - leftFoot!.start[2],
    );
    expect(handLen).toBeGreaterThan(0.05);
    expect(footLen).toBeGreaterThan(0.05);

    // Hand continues roughly along forearm (end is handEnd, not a fixed +Y stub).
    const elbow = fitted.jointPositions.leftLowerArm!;
    const wrist = fitted.jointPositions.leftHand!;
    const tip = fitted.jointPositions.leftHandEnd!;
    const forearm = [wrist[0] - elbow[0], wrist[1] - elbow[1], wrist[2] - elbow[2]] as const;
    const handDir = [
      leftHand!.end[0] - leftHand!.start[0],
      leftHand!.end[1] - leftHand!.start[1],
      leftHand!.end[2] - leftHand!.start[2],
    ] as const;
    const fLen = Math.hypot(...forearm) || 1;
    const hLen = Math.hypot(...handDir) || 1;
    const handDot = (forearm[0] * handDir[0] + forearm[1] * handDir[1] + forearm[2] * handDir[2]) / (fLen * hLen);
    expect(handDot).toBeGreaterThan(0.7);
    // Endpoint equals fitted handEnd (not wrist+[0,0.08,0]).
    expect(leftHand!.end[0]).toBeCloseTo(tip[0], 5);
    expect(leftHand!.end[1]).toBeCloseTo(tip[1], 5);
    expect(leftHand!.end[2]).toBeCloseTo(tip[2], 5);
    const stubEnd = [wrist[0], wrist[1] + 0.08, wrist[2]] as const;
    expect(Math.hypot(tip[0] - stubEnd[0], tip[1] - stubEnd[1], tip[2] - stubEnd[2])).toBeGreaterThan(0.02);

    // Foot points primarily forward (+Z), not pure +Y.
    const footDirY = (leftFoot!.end[1] - leftFoot!.start[1]) / footLen;
    const footDirZ = (leftFoot!.end[2] - leftFoot!.start[2]) / footLen;
    expect(footDirZ).toBeGreaterThan(0.5);
    expect(Math.abs(footDirY)).toBeLessThan(0.5);
  });

  it('does not hard-fail near-planar complete marker sets for validation or weights', () => {
    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    // Flatten Z deliberately (classic T-pose plane).
    const planar = markers.map((m) => ({ ...m, position: [m.position[0], m.position[1], 0] as [number, number, number] }));
    expect(areAutorigMarkersSuspiciouslyPlanar(planar)).toBe(true);
    const issues = validateAutorigMarkers(planar, 'full');
    expect(issues.some((i) => i.code === 'planar')).toBe(false);
    expect(issues.some((i) => i.code === 'missing')).toBe(false);

    const fitted = fitSkeletonFromMarkers(planar, 'full');
    const buffers = generateDeterministicSkinWeights({
      positions: Float32Array.from([0, 1, 0, 0.2, 1.2, 0]),
      jointPositions: fitted.jointPositions,
      heightMeters: 1.75,
      meshSize: [0.6, 1.75, 0.35],
    });
    expect(buffers.weights.length).toBeGreaterThan(0);
    expect(typeof buffers.fallbackVertexCount).toBe('number');
  });

  it('depth centering uses local bidirectional surfaces, not coat-to-back extremes', () => {
    // Body torso box + far clothing plane in front (unrelated component).
    const root = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.25));
    torso.position.set(0, 1.0, 0);
    const coat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.02));
    coat.position.set(0, 1.0, 0.45); // floating far in front
    root.add(torso, coat);
    root.updateMatrixWorld(true);

    const markers = suggestAutorigMarkers({ size: [0.5, 1.75, 0.3], heightMeters: 1.75 }).map((m) => (
      m.jointId === 'hips'
        ? { ...m, position: [0, 1.0, 0] as [number, number, number] }
        : m
    ));
    const result = centerAutorigMarkersDepth(markers, root, 'front', 'hips');
    const hips = result.markers.find((m) => m.jointId === 'hips')!;
    // Mid of torso (~0) — not average of coat front (0.45) and torso back (−0.125).
    expect(Math.abs(hips.position[2])).toBeLessThan(0.12);
  });

  it('suggestions honour mesh width and A/T-pose hint for arm laterals', () => {
    const narrow = suggestAutorigMarkers({ size: [0.4, 1.7, 0.25], heightMeters: 1.7, poseHint: 'a-pose' });
    const wide = suggestAutorigMarkers({ size: [0.9, 1.7, 0.3], heightMeters: 1.7, poseHint: 'a-pose' });
    const aPose = suggestAutorigMarkers({ size: [0.7, 1.75, 0.3], heightMeters: 1.75, poseHint: 'a-pose' });
    const tPose = suggestAutorigMarkers({ size: [0.7, 1.75, 0.3], heightMeters: 1.75, poseHint: 't-pose' });

    const handX = (markers: typeof narrow) => markers.find((m) => m.jointId === 'leftHand')!.position[0];
    const handY = (markers: typeof narrow) => markers.find((m) => m.jointId === 'leftHand')!.position[1];
    expect(handX(wide)).toBeGreaterThan(handX(narrow) + 0.05);
    // T-pose wrists higher and farther out than A-pose.
    expect(handX(tPose)).toBeGreaterThan(handX(aPose));
    expect(handY(tPose)).toBeGreaterThan(handY(aPose) + 0.1);
  });

  it('completeAutorigMarkers infers hip sockets (not midpoints) and terminals', () => {
    const base = suggestAutorigMarkers({ size: [0.55, 1.75, 0.3], heightMeters: 1.75 })
      .filter((m) => !['leftUpperLeg', 'rightUpperLeg', 'leftHandEnd', 'rightHandEnd', 'leftToeBase', 'rightToeBase'].includes(m.jointId));
    const completed = completeAutorigMarkers(base, 'full', { heightMeters: 1.75, widthMeters: 0.55 });
    const leftHip = completed.find((m) => m.jointId === 'leftUpperLeg')!.position;
    const hips = completed.find((m) => m.jointId === 'hips')!.position;
    const knee = completed.find((m) => m.jointId === 'leftLowerLeg')!.position;
    expect(Math.abs(leftHip[1] - hips[1])).toBeLessThan(0.08);
    expect(Math.abs(leftHip[1] - (hips[1] + knee[1]) / 2)).toBeGreaterThan(0.1);
    expect(completed.some((m) => m.jointId === 'leftHandEnd')).toBe(true);
    expect(completed.some((m) => m.jointId === 'leftToeBase')).toBe(true);
  });

  it('bumps rig generation version for regenerated weights', () => {
    expect(CURRENT_AUTORIG_RIG_GENERATION_VERSION).toBeGreaterThanOrEqual(6);
  });
});
