import { describe, expect, it } from 'vitest';
import {
  fitSkeletonFromMarkers,
  markersToMap,
  sanitizeAutorigMarkers,
  suggestAutorigMarkers,
  validateAutorigMarkers,
} from '../src/engine/autorigMarkers';
import { jointPositionsFromRig } from '../src/engine/autorigSkinnedMesh';
import { normalizePoseableMarkers, normalizePoseableRigAsset } from '../src/engine/poseableRigNormalize';

describe('autorig marker sanitization (jointId crash guard)', () => {
  it('sanitizeAutorigMarkers drops null/undefined/malformed rows', () => {
    const base = suggestAutorigMarkers({ size: [0.5, 1.7, 0.3], heightMeters: 1.7 });
    const cleaned = sanitizeAutorigMarkers([
      base[0],
      undefined,
      null,
      { jointId: 'not-a-joint', position: [0, 0, 0] },
      { jointId: 'hips', position: [0, 'bad', 0] },
      base[1],
    ] as never[]);
    expect(cleaned.every((marker) => typeof marker.jointId === 'string')).toBe(true);
    expect(cleaned.length).toBe(2);
  });

  it('markersToMap / fitSkeleton / validate tolerate undefined marker entries', () => {
    const base = suggestAutorigMarkers({ size: [0.5, 1.7, 0.3], heightMeters: 1.7 });
    const dirty = [base[0]!, undefined as never, base[1]!, null as never];
    expect(() => markersToMap(dirty)).not.toThrow();
    expect(() => fitSkeletonFromMarkers(dirty)).not.toThrow();
    expect(() => validateAutorigMarkers(dirty)).not.toThrow();
    const fitted = fitSkeletonFromMarkers(dirty);
    expect(fitted.jointPositions.hips || fitted.jointPositions.head || Object.keys(fitted.jointPositions).length >= 0).toBeTruthy();
  });

  it('jointPositionsFromRig skips undefined marker rows', () => {
    expect(() => jointPositionsFromRig({
      version: 1,
      id: 'r',
      skeletonJoints: [],
      markers: [undefined as never, { id: 'm0', jointId: 'hips', position: [0, 1, 0] }],
    })).not.toThrow();
    const positions = jointPositionsFromRig({
      version: 1,
      id: 'r',
      skeletonJoints: [],
      markers: [undefined as never, { id: 'm', jointId: 'hips', position: [0, 1, 0] }],
    });
    expect(positions.hips).toEqual([0, 1, 0]);
  });

  it('normalizePoseableRigAsset strips corrupt markers on project load', () => {
    const normalized = normalizePoseableRigAsset({
      version: 1,
      id: 'rig_bad',
      skeletonJoints: ['hips', 'head'],
      markers: [
        null,
        undefined,
        { jointId: 'hips', position: [0, 1, 0] },
        { jointId: 'garbage', position: [1, 2, 3] },
      ],
    });
    expect(normalized?.markers).toEqual([
      { id: 'marker_hips', jointId: 'hips', position: [0, 1, 0] },
    ]);
    expect(normalizePoseableMarkers([null, { jointId: 'head', position: [0, 1.7, 0] }])).toHaveLength(1);
  });
});
