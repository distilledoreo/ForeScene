import JSZip from 'jszip';
import type { PoseableRigAsset } from '../../src/domain/types';

/**
 * Tiny deterministic .fsrig fixture paired with the saved-rig GLB fixtures.
 * The optional vertex count also makes a valid-but-incompatible package for
 * preflight regression coverage.
 */
export async function savedRigFsrig(options: { vertexCount?: number; characterName?: string } = {}): Promise<Uint8Array> {
  const vertexCount = options.vertexCount ?? 6;
  const influenceCount = vertexCount * 4;
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
      indices: Array.from({ length: influenceCount }, () => 0),
      weights: Array.from({ length: influenceCount }, (_, index) => (index % 4 === 0 ? 1 : 0)),
    },
    requiresRerigging: false,
  };
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    format: 'forescene-poseable-rig',
    version: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    characterName: options.characterName ?? 'Joseph',
    rig,
  }));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
