import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDefaultProject, createPanoAsset, createPanoReference, createShot, createTransform } from '../src/domain/defaults';
import { encodeBinaryGrayboxMesh, MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMesh';
import { getModelAsset, putModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import {
  compareDurableProjectEvidence,
  inspectProjectBackupBytes,
  persistAndVerifyProject,
  rawShotPanoramaBinding,
  shotPanoramaBinding,
  verifyBackupMatchesProject,
  type DurableProjectEvidence,
} from '../src/engine/projectDurability';
import { createProjectPackage, readProjectFile } from '../src/engine/projectIO';
import {
  ProjectPersistenceController,
} from '../src/engine/projectPersistenceController';
import { recoverLatestProject } from '../src/engine/projectSafety';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { useProjectStore } from '../src/state/useProjectStore';

const PANO_A = 'pano_durability_a';
const ASSET_A = 'asset_durability_a';
const MESH_KEY = 'project/durability/ordinary-cube';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function resetStores() {
  resetProjectAssetStoreForTests();
  resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
}

async function createAuthoredProject() {
  const packed = encodeBinaryGrayboxMesh(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Uint32Array([0, 1, 2]),
  );
  await putModelAsset(MESH_KEY, packed.buffer);
  const project = createDefaultProject();
  project.id = 'project_durability_two_boundary';
  project.name = 'Durability two-boundary';
  const panoAsset = createPanoAsset({
    name: 'canonical.png',
    uri: TINY_PNG,
    width: 16,
    height: 8,
  });
  panoAsset.id = ASSET_A;
  const pano = createPanoReference({
    name: 'Canonical',
    assetId: ASSET_A,
    type: 'ai_global_reference',
    origin: project.scene.panoOrigin,
    width: 16,
    height: 8,
    isCanonical: true,
  });
  pano.id = PANO_A;
  project.assets.assets[ASSET_A] = panoAsset;
  project.assets.assets.mesh = {
    id: 'mesh',
    type: 'model',
    name: 'ordinary-cube.glb',
    uri: `${MODEL_ASSET_URI_PREFIX}${MESH_KEY}`,
    storageKey: MESH_KEY,
    createdAt: new Date(0).toISOString(),
  };
  project.panoRefs = [pano];
  const shotA = project.shots[0]!;
  shotA.id = 'shot_a';
  shotA.shotNumber = '01';
  shotA.linkedPanoId = PANO_A;
  const shotB = createShot({
    index: 2,
    camera: shotA.camera,
    linkedPanoId: null,
    exportDefaults: project.exportConfiguration?.defaults,
  });
  shotB.id = 'shot_b';
  shotB.shotNumber = '02';
  shotB.linkedPanoId = null;
  project.shots = [shotA, shotB];
  project.scene.objects.push({
    id: 'ordinary-cube',
    name: 'Ordinary cube',
    type: 'imported_model',
    transform: createTransform(),
    dimensions: [1, 1, 1],
    category: 'architecture',
    locked: false,
    visible: true,
    modelAssetId: 'mesh',
  });
  return project;
}

describe('project persist and backup durability', () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it('distinguishes explicit null from an omitted linkedPanoId', () => {
    expect(shotPanoramaBinding({ linkedPanoId: null })).toBe('explicit_null');
    expect(shotPanoramaBinding({})).toBe('omitted');
    expect(shotPanoramaBinding({ linkedPanoId: PANO_A })).toBe('linked');
    expect(rawShotPanoramaBinding({ id: 'x', linkedPanoId: null })).toBe('explicit_null');
    expect(rawShotPanoramaBinding({ id: 'x' })).toBe('omitted');
  });

  it('persists, rehydrates, and package-inspects A linked / B explicit null / imported_model binary', async () => {
    const project = await createAuthoredProject();
    expect(project.shots[1]?.linkedPanoId).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(project.shots[1]!, 'linkedPanoId')).toBe(true);
    expect(project.scene.objects.some((object) => object.type === 'imported_model')).toBe(true);

    const controller = new ProjectPersistenceController({
      debounceMs: 1,
      onStateChange: () => undefined,
    });
    controller.start(project);
    const persistResult = await persistAndVerifyProject({
      liveProject: project,
      persist: async () => {
        const flushed = await controller.flush('Durability persist');
        if (!flushed) return undefined;
        return { project: flushed.project, revisionId: flushed.revision.id };
      },
    });
    expect(persistResult.ok, persistResult.mismatches.join('; ')).toBe(true);
    expect(persistResult.project).toBeTruthy();
    const rehydratedB = persistResult.project!.shots.find((shot) => shot.id === 'shot_b');
    expect(rehydratedB).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(rehydratedB!, 'linkedPanoId')).toBe(true);
    expect(rehydratedB!.linkedPanoId).toBeNull();
    expect(shotPanoramaBinding(rehydratedB!)).toBe('explicit_null');
    expect(persistResult.project!.shots.find((shot) => shot.id === 'shot_a')?.linkedPanoId).toBe(PANO_A);
    expect(
      persistResult.project!.scene.objects.find((object) => object.id === 'ordinary-cube')?.type,
    ).toBe('imported_model');

    useProjectStore.getState().setProject(persistResult.project!);
    const afterSet = useProjectStore.getState().project;
    expect(afterSet.shots.find((shot) => shot.id === 'shot_b')?.linkedPanoId).toBeNull();
    expect(afterSet.scene.objects.find((object) => object.id === 'ordinary-cube')?.type).toBe('imported_model');

    const recovered = await recoverLatestProject();
    expect(recovered).toBeTruthy();
    expect(recovered!.project.shots.find((shot) => shot.id === 'shot_b')?.linkedPanoId).toBeNull();
    expect(recovered!.project.scene.objects.find((object) => object.id === 'ordinary-cube')?.type).toBe('imported_model');

    const blob = await createProjectPackage(persistResult.project!);
    const inspect = await inspectProjectBackupBytes(await blob.arrayBuffer());
    const rawShots = (inspect.rawProject.shots as Array<Record<string, unknown>>) ?? [];
    const rawB = rawShots.find((shot) => shot.id === 'shot_b');
    expect(rawB).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(rawB!, 'linkedPanoId')).toBe(true);
    expect(rawB!.linkedPanoId).toBeNull();
    expect(rawShotPanoramaBinding(rawB!)).toBe('explicit_null');
    expect(inspect.evidence.shots.find((shot) => shot.id === 'shot_b')?.panoramaBinding).toBe('explicit_null');
    expect(inspect.evidence.shots.find((shot) => shot.id === 'shot_a')?.panoramaBinding).toBe('linked');
    expect(inspect.evidence.objects.find((object) => object.id === 'ordinary-cube')?.type).toBe('imported_model');
    const mesh = inspect.evidence.modelAssets.find((asset) => asset.id === 'mesh');
    expect(mesh?.present).toBe(true);
    expect(mesh?.byteLength).toBeGreaterThan(0);
    expect(inspect.zipEntries.some((entry) => entry.startsWith('model-assets/'))).toBe(true);

    const identity = verifyBackupMatchesProject(inspect, project);
    expect(identity.ok, identity.mismatches.join('; ')).toBe(true);

    resetModelAssetStoreForTests();
    const opened = await readProjectFile(new File([blob], 'durability-backup.fsp'));
    expect(opened.shots.find((shot) => shot.id === 'shot_b')?.linkedPanoId).toBeNull();
    expect(opened.shots.find((shot) => shot.id === 'shot_a')?.linkedPanoId).toBe(PANO_A);
    const imported = opened.scene.objects.find((object) => object.id === 'ordinary-cube');
    expect(imported?.type).toBe('imported_model');
    const openedKey = opened.assets.assets.mesh.uri.startsWith(MODEL_ASSET_URI_PREFIX)
      ? opened.assets.assets.mesh.uri.slice(MODEL_ASSET_URI_PREFIX.length)
      : opened.assets.assets.mesh.storageKey;
    expect(openedKey).toBeTruthy();
    expect(await getModelAsset(openedKey!)).toBeTruthy();
    expect(opened.assets.assets.mesh.resolutionStatus).not.toBe('missing');

    const scratch = process.env.FORESCENE_DURABILITY_INSPECT_OUT;
    if (scratch) {
      await writeFile(scratch, `${JSON.stringify({
        zipEntries: inspect.zipEntries,
        evidence: inspect.evidence,
        rawShotB: rawB,
        compare: identity,
      }, null, 2)}\n`, 'utf8');
    }
  });

  it('fails closed when a required model binary is omitted from the zip evidence', () => {
    const expected: DurableProjectEvidence = {
      projectId: 'p',
      shots: [],
      objects: [{ id: 'ordinary-cube', type: 'imported_model', modelAssetId: 'mesh' }],
      modelAssets: [{ id: 'mesh', present: true }],
    };
    const actual: DurableProjectEvidence = {
      ...expected,
      modelAssets: [{ id: 'mesh', present: false }],
    };
    const compared = compareDurableProjectEvidence(expected, actual);
    expect(compared.ok).toBe(false);
    expect(compared.mismatches.join(' ')).toMatch(/model binary/);
  });

  it('fails closed on extra inventory or a rebound imported-model asset', () => {
    const expected: DurableProjectEvidence = {
      projectId: 'p',
      shots: [{ id: 'shot_a', panoramaBinding: 'linked', linkedPanoId: 'pano' }],
      objects: [{ id: 'ordinary-cube', type: 'imported_model', modelAssetId: 'mesh' }],
      modelAssets: [{ id: 'mesh', present: true }],
    };
    const extraShot = compareDurableProjectEvidence(expected, {
      ...expected,
      shots: [
        ...expected.shots,
        { id: 'shot_extra', panoramaBinding: 'omitted', linkedPanoId: undefined },
      ],
    });
    expect(extraShot.ok).toBe(false);
    expect(extraShot.mismatches.join(' ')).toMatch(/unexpected shot shot_extra/);

    const rebound = compareDurableProjectEvidence(expected, {
      ...expected,
      objects: [{ id: 'ordinary-cube', type: 'imported_model', modelAssetId: 'other-mesh' }],
    });
    expect(rebound.ok).toBe(false);
    expect(rebound.mismatches.join(' ')).toMatch(/modelAssetId/);
  });
});
