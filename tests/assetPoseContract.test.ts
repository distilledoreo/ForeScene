import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { inspectAssetPoseContract } from '../src/engine/agent/assetPoseContract';
import {
  extractProducedPackageManifest,
  isProducedPackageManifestPath,
  plannedProjectPackageAssetPath,
  PRODUCED_PACKAGE_MANIFEST_KIND,
} from '../src/engine/projectPackageInclusion';
import { encodeBinaryGrayboxMesh, MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMesh';
import { putModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { createProjectPackage } from '../src/engine/projectIO';
import { touchProject } from '../src/state/slices/touchProject';

function projectWithModel(uri: string, extras: { storageKey?: string } = {}) {
  const model = createSceneObject('imported_model', 1);
  model.name = 'Hero mesh';
  model.modelAssetId = 'mesh-1';
  const project = touchProject({
    ...createDefaultProject(),
    scene: { ...createDefaultProject().scene, objects: [model] },
  });
  project.assets.assets['mesh-1'] = {
    id: 'mesh-1',
    name: 'Hero.glb',
    originalFileName: 'Hero.glb',
    type: 'model',
    mimeType: 'model/gltf-binary',
    uri,
    storageKey: extras.storageKey,
    resolutionStatus: 'available',
    createdAt: new Date().toISOString(),
  };
  return { project, model };
}

describe('asset pose package inclusion contract', () => {
  afterEach(() => {
    resetModelAssetStoreForTests();
  });

  it('does not claim package inclusion for an available model without a produced manifest', () => {
    const { project, model } = projectWithModel('panoref-idb:model-key-1', { storageKey: 'model-key-1' });
    const contract = inspectAssetPoseContract(project);
    const entry = contract.objects.find((object) => object.objectId === model.id);
    expect(entry?.assetStatus).toBe('available');
    expect(entry?.includedInPackage).toBe('not_verified');
    expect(entry?.packagePath).toBe('model-assets/model-key-1.bin');
  });

  it('does not treat a fabricated matching path as proof that a ZIP contains bytes', () => {
    const { project, model } = projectWithModel('panoref-idb:model-key-1', { storageKey: 'model-key-1' });
    const planned = plannedProjectPackageAssetPath(project, project.assets.assets['mesh-1']!);
    expect(planned).toBe('model-assets/model-key-1.bin');
    const contract = inspectAssetPoseContract(project, undefined, {
      packageManifestPaths: [planned!],
    });
    const entry = contract.objects.find((object) => object.objectId === model.id);
    expect(entry?.includedInPackage).toBe('not_verified');
    expect(entry?.packagePath).toBe(planned);

    const fabricatedProof = inspectAssetPoseContract(project, undefined, {
      producedPackageManifest: {
        kind: PRODUCED_PACKAGE_MANIFEST_KIND,
        paths: [planned!],
      },
    });
    expect(fabricatedProof.objects.find((object) => object.objectId === model.id)?.includedInPackage)
      .toBe('not_verified');
  });

  it('does not treat a fabricated { files: { plannedPath } } object as a produced ZIP', async () => {
    const { project, model } = projectWithModel('panoref-idb:model-key-1', { storageKey: 'model-key-1' });
    const planned = plannedProjectPackageAssetPath(project, project.assets.assets['mesh-1']!);
    expect(planned).toBe('model-assets/model-key-1.bin');

    const fabricatedArchive = { files: { [planned!]: { dir: false } } };
    await expect(extractProducedPackageManifest(fabricatedArchive as never)).rejects.toThrow(/real ZIP archive/);

    const fakeZip = new JSZip();
    fakeZip.file(planned!, 'not-archive-bytes');
    await expect(extractProducedPackageManifest(fakeZip as never)).rejects.toThrow(/real ZIP archive/);

    const fromFilesObject = inspectAssetPoseContract(project, undefined, {
      producedPackageManifest: fabricatedArchive as never,
    });
    expect(fromFilesObject.objects.find((object) => object.objectId === model.id)?.includedInPackage)
      .toBe('not_verified');
  });

  it('reports an available model as omitted when packaging rules cannot include it', () => {
    const { project, model } = projectWithModel('blob:http://localhost/unpacked-model');
    const contract = inspectAssetPoseContract(project, undefined, {
      packageManifestPaths: ['model-assets/unrelated.bin'],
    });
    const entry = contract.objects.find((object) => object.objectId === model.id);
    expect(entry?.assetStatus).toBe('available');
    expect(entry?.includedInPackage).toBe(false);
    expect(entry?.packagePath).toBeUndefined();
  });

  it('marks an asset included only when the actual exported package ZIP contains the planned path', async () => {
    const packed = encodeBinaryGrayboxMesh(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      new Uint32Array([0, 1, 2]),
    );
    await putModelAsset('model-key-1', packed.buffer);
    const { project, model } = projectWithModel(`${MODEL_ASSET_URI_PREFIX}model-key-1`, {
      storageKey: 'model-key-1',
    });
    const planned = plannedProjectPackageAssetPath(project, project.assets.assets['mesh-1']!);
    expect(planned).toBe('model-assets/model-key-1.bin');

    const blob = await createProjectPackage(project);
    const proof = await extractProducedPackageManifest(blob);
    expect(proof.paths).toContain(planned);

    const verified = inspectAssetPoseContract(project, undefined, {
      producedPackageManifest: proof,
    });
    const included = verified.objects.find((object) => object.objectId === model.id);
    expect(included?.includedInPackage).toBe(true);
    expect(included?.packagePath).toBe(planned);
    expect(included?.packagePath).not.toBe(included?.modelAssetId);

    const omittedZip = new JSZip();
    omittedZip.file('project.json', '{}');
    omittedZip.file('shots/001.png', 'not-a-model');
    const omittedProof = await extractProducedPackageManifest(await omittedZip.generateAsync({ type: 'uint8array' }));
    expect(omittedProof.paths).not.toContain(planned);
    const omitted = inspectAssetPoseContract(project, undefined, {
      producedPackageManifest: omittedProof,
    });
    expect(omitted.objects.find((object) => object.objectId === model.id)?.includedInPackage).toBe(false);

    const artifactId = 'artifact_not_a_package_path';
    expect(isProducedPackageManifestPath(artifactId)).toBe(false);
    expect(isProducedPackageManifestPath('sha256:deadbeef')).toBe(false);
    const masquerade = inspectAssetPoseContract(project, undefined, {
      packageManifestPaths: [artifactId, 'sha256:deadbeef', planned!],
    });
    expect(masquerade.objects.find((object) => object.objectId === model.id)?.includedInPackage)
      .toBe('not_verified');
  });
});
