import { describe, expect, it, vi } from 'vitest';
import type { PoseableRigAsset } from '../src/domain/types';
import {
  buildPoseableRigPackage,
  canApplyPoseableRigPackage,
  detachPoseableRigForPackage,
  mergeImportedRigOntoTarget,
  parsePoseableRigPackageFile,
  POSEABLE_RIG_PACKAGE_FORMAT,
} from '../src/engine/poseableRigPackage';
import { putModelAsset } from '../src/engine/modelAssetStore';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';

function sampleRig(overrides: Partial<PoseableRigAsset> = {}): PoseableRigAsset {
  return {
    version: 1,
    id: 'rig_source',
    skeletonJoints: ['hips', 'spine', 'chest', 'neck', 'head'],
    bindMatrices: {
      hips: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
    },
    skin: {
      influencesPerVertex: 4,
      skinAssetId: 'skin_source',
    },
    regionMap: {
      version: 1,
      regionAssetId: 'region_source',
      vertexCount: 4,
      topologyHash: 'topo-abc',
      sourceAssetId: 'mesh_source',
    },
    markers: [{ id: 'marker_hips', jointId: 'hips', position: [0, 1, 0] }],
    originalSourceAssetId: 'mesh_source',
    sourceMeshAssetId: 'mesh_source',
    binderVersion: 2,
    rigGenerationVersion: 7,
    ...overrides,
  };
}

describe('poseable rig package IO', () => {
  it('detaches project-local asset ids while keeping topology metadata', () => {
    const detached = detachPoseableRigForPackage(sampleRig());
    expect(detached.originalSourceAssetId).toBeUndefined();
    expect(detached.sourceMeshAssetId).toBeUndefined();
    expect(detached.skin?.skinAssetId).toBeUndefined();
    expect(detached.regionMap?.topologyHash).toBe('topo-abc');
    expect(detached.regionMap?.regionAssetId).toBe('package');
  });

  it('round-trips a .panorig zip and remaps binary assets', async () => {
    const skinBytes = new Uint8Array([1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
    const regionBytes = new Uint8Array([80, 78, 82, 71, 2, 0, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 97, 98, 99, 1, 1, 1, 1, 0, 0, 0, 0]).buffer;
    await putModelAsset('poseable-skin-skin_source', skinBytes);
    await putModelAsset('poseable-region-region_source', regionBytes);

    const assets = {
      assets: {
        skin_source: {
          id: 'skin_source',
          name: 'skin',
          type: 'other' as const,
          uri: `${MODEL_ASSET_URI_PREFIX}poseable-skin-skin_source`,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        region_source: {
          id: 'region_source',
          name: 'region',
          type: 'other' as const,
          uri: `${MODEL_ASSET_URI_PREFIX}poseable-region-region_source`,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };

    const built = await buildPoseableRigPackage({
      rig: sampleRig(),
      assets,
      characterName: 'Hero',
    });
    expect(built.fileName).toBe('hero-rig.panorig');
    expect(built.manifest.format).toBe(POSEABLE_RIG_PACKAGE_FORMAT);
    expect(built.manifest.skinFile).toBe('skin.bin');
    expect(built.manifest.regionFile).toBe('region.bin');

    const file = new File([built.blob], built.fileName, { type: 'application/zip' });
    const imported = await parsePoseableRigPackageFile(file);
    expect(imported.rig.id).not.toBe('rig_source');
    expect(imported.skinAsset?.id).toBeTruthy();
    expect(imported.regionAsset?.id).toBeTruthy();
    expect(imported.rig.skin?.skinAssetId).toBe(imported.skinAsset?.id);
    expect(imported.rig.regionMap?.topologyHash).toBe('topo-abc');

    const target = sampleRig({ id: 'rig_target', originalSourceAssetId: 'keep-source' });
    expect(canApplyPoseableRigPackage({ targetRig: target, imported }).ok).toBe(true);
    const merged = mergeImportedRigOntoTarget({ targetRig: target, imported });
    expect(merged.id).toBe('rig_target');
    expect(merged.originalSourceAssetId).toBe('keep-source');
    expect(merged.requiresRerigging).toBe(false);

    const mismatched = canApplyPoseableRigPackage({
      targetRig: sampleRig({
        regionMap: {
          version: 1,
          regionAssetId: 'x',
          vertexCount: 4,
          topologyHash: 'other-topo',
          sourceAssetId: 'mesh_source',
        },
      }),
      imported,
    });
    expect(mismatched.ok).toBe(false);
  });

  it('rejects incomplete packages missing binds or skin', () => {
    const incompleteRig = sampleRig({ bindMatrices: undefined, skin: undefined });
    const imported = {
      manifest: {
        format: POSEABLE_RIG_PACKAGE_FORMAT,
        version: 1 as const,
        exportedAt: '2026-01-01T00:00:00.000Z',
        topologyHash: 'topo-abc',
        rig: incompleteRig,
      },
      rig: incompleteRig,
    };
    const result = canApplyPoseableRigPackage({
      targetRig: sampleRig(),
      imported,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects packages whose vertex count does not match the target mesh', () => {
    const imported = {
      manifest: {
        format: POSEABLE_RIG_PACKAGE_FORMAT,
        version: 1 as const,
        exportedAt: '2026-01-01T00:00:00.000Z',
        topologyHash: 'topo-abc',
        rig: sampleRig(),
      },
      rig: sampleRig(),
    };
    const mismatch = canApplyPoseableRigPackage({
      targetRig: sampleRig({ regionMap: undefined }),
      imported,
      meshVertexCount: 999,
    });
    expect(mismatch.ok).toBe(false);
    const match = canApplyPoseableRigPackage({
      targetRig: sampleRig({ regionMap: undefined }),
      imported,
      meshVertexCount: 4,
    });
    expect(match.ok).toBe(true);
  });
});

describe('geometry-based gizmo bounds for skinned roots', () => {
  it('anchors gizmos using geometry AABBs even when setFromObject would skew skinned meshes', async () => {
    const THREE = await import('three');
    const { computeObjectBoundsForGizmo, updateTransformGizmo, createGizmoGroup, createSelectionOutline } = await import('../src/engine/transformGizmo');
    const { createSceneObject } = await import('../src/domain/defaults');

    const root = new THREE.Group();
    root.position.set(4, 0, -2);
    const geo = new THREE.BoxGeometry(0.5, 1.7, 0.4);
    geo.translate(0, 0.85, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    root.add(mesh);
    root.updateMatrixWorld(true);

    const box = computeObjectBoundsForGizmo(root, createSceneObject('human_dummy', 1));
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(4, 5);
    expect(box.getCenter(new THREE.Vector3()).z).toBeCloseTo(-2, 5);

    const gizmo = createGizmoGroup('translate');
    const outline = createSelectionOutline(root);
    updateTransformGizmo(gizmo, outline, root, createSceneObject('human_dummy', 1));
    expect(gizmo.visible).toBe(true);
    expect(Number.isFinite(gizmo.position.x)).toBe(true);
    expect(gizmo.position.x).toBeCloseTo(4, 5);
  });
});

// Silence unused vi in case of future stubs
void vi;
