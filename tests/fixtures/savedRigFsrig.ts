import JSZip from 'jszip';
import type { PoseableRigAsset } from '../../src/domain/types';

/**
 * Tiny deterministic .fsrig fixture paired with preservedRigGlb(). It keeps
 * the package self-contained while matching the fixture's six mesh vertices.
 */
export async function savedRigFsrig(): Promise<Uint8Array> {
  const identity = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  const rig: PoseableRigAsset = {
    version: 1,
    id: 'saved_rig_fixture',
    skeletonJoints: ['hips'],
    bindMatrices: { hips: identity },
    skin: {
      influencesPerVertex: 4,
      indices: Array.from({ length: 24 }, () => 0),
      weights: Array.from({ length: 24 }, (_, index) => (index % 4 === 0 ? 1 : 0)),
    },
    requiresRerigging: false,
  };
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    format: 'forescene-poseable-rig',
    version: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    characterName: 'Joseph',
    rig,
  }));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
