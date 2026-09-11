import * as THREE from 'three';
import * as sourceModelLoader from '../src/engine/sourceModelLoader';
import JSZip from 'jszip';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sourceFixture, sourceFixtureGlb } from './fixtures/source-model-fixture';
import { createDefaultProject } from '../src/domain/defaults';
import { createModelImportPlan, importModelJob, type ModelImportBatchResult } from '../src/engine/modelImport';
import { createObject3D, buildScene, disposeScene } from '../src/engine/sceneObjects';
import { ensureSourceModelsForProject, resetSourceModelRuntimeForTests } from '../src/engine/sourceModelRuntime';
import { getModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { createProjectPackage, readProjectFile, parseProject, serializeProject } from '../src/engine/projectIO';
import { readSourceZip, sourceResourcePath } from '../src/engine/sourceModelPackage';
import { extractCoverageScene } from '../src/engine/projectionCoverage/surfaceSampler';

beforeAll(() => {
  if (typeof ProgressEvent === 'undefined') vi.stubGlobal('ProgressEvent', class extends Event { constructor(type: string) { super(type); } });
});
const scenes: THREE.Scene[] = [];
afterEach(() => {
  scenes.splice(0).forEach(disposeScene);
  resetSourceModelRuntimeForTests(); resetModelAssetStoreForTests();
});
function projectFor(batch: ModelImportBatchResult) {
  const project = createDefaultProject();
  project.scene.objects = batch.items.map((item) => item.object);
  batch.items.forEach((item) => { project.assets.assets[item.asset.id] = item.asset; });
  return project;
}
function renderObject(batch: ModelImportBatchResult, index = 0) {
  const project = projectFor(batch);
  const scene = new THREE.Scene(); scenes.push(scene);
  const root = createObject3D(batch.items[index].object, false, 'light', project.assets);
  scene.add(root); scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
  return { root, meshes, scene };
}
const importFixture = (options: Parameters<typeof sourceFixture>[0] = {}, mode: 'combined' | 'separate' = 'separate') =>
  importModelJob({ kind: 'file', file: new File([sourceFixtureGlb(options)], 'scene.glb') }, { mode });

describe('source-preserving model imports', () => {
  it('retains exact original GLB bytes and one shared asset for separate selections', async () => {
    const bytes = sourceFixtureGlb();
    const batch = await importModelJob({ kind: 'file', file: new File([bytes], 'scene.glb') }, { mode: 'separate' });
    expect(batch.items).toHaveLength(2);
    expect(new Set(batch.items.map((item) => item.asset.id)).size).toBe(1);
    expect(await getModelAsset(batch.items[0].asset.storageKey!)).toEqual(bytes);
    expect(batch.summary.sourcePreserved).toBe(true);
    expect(batch.items[0].asset.metadata?.sourceModel?.animations).toEqual([{ name: 'Retained motion', duration: 1 }]);
    expect(batch.items.map((item) => item.object.sourceModelNodePath)).toEqual([[0,0], [0,1]]);
  });
  it('retains UVs, morph targets, material names, metadata and shared geometry', async () => {
    const batch = await importFixture();
    const first = renderObject(batch); const second = renderObject(batch, 1);
    expect(first.meshes).toHaveLength(1); expect(second.meshes).toHaveLength(1);
    const mesh = first.meshes[0];
    expect(mesh.geometry.attributes.uv.count).toBe(4);
    expect(mesh.geometry.morphAttributes.position).toHaveLength(1);
    expect(mesh.morphTargetInfluences).toEqual([0.5]);
    expect((mesh.material as THREE.Material).name).toBe('Authored paint');
    expect(mesh.userData.authorData).toEqual({ retain: true });
    expect(second.meshes[0].geometry).toBe(mesh.geometry);
    expect(second.meshes[0].material).toBe(mesh.material);
    expect(first.root.animations[0].name).toBe('Retained motion');
  });
  it('keeps original world placement and allows independent editing and scaling', async () => {
    const batch = await importFixture();
    const left = renderObject(batch); const right = renderObject(batch, 1);
    expect(new THREE.Box3().setFromObject(left.root).getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    expect(new THREE.Box3().setFromObject(right.root).getCenter(new THREE.Vector3()).x).toBeCloseTo(4);
    batch.items[0].object.transform.position[0] += 5;
    batch.items[0].object.transform.scale[0] = 2;
    const changed = renderObject(batch);
    expect(new THREE.Box3().setFromObject(changed.root).getCenter(new THREE.Vector3()).x).toBeCloseTo(5);
    expect(new THREE.Box3().setFromObject(changed.root).getSize(new THREE.Vector3()).x).toBeCloseTo(4);
    expect(new THREE.Box3().setFromObject(right.root).getCenter(new THREE.Vector3()).x).toBeCloseTo(4);
  });
  it('overrides are non-destructive and disposing one scene keeps another scene resources alive', async () => {
    const batch = await importFixture();
    const first = renderObject(batch); const material = first.meshes[0].material as THREE.Material;
    const geometryDispose = vi.spyOn(first.meshes[0].geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    batch.items[0].object.surfaceStyle = 'solid'; batch.items[0].object.color = '#ff0000';
    const override = renderObject(batch);
    expect(override.meshes[0].material).not.toBe(material);
    disposeScene(override.scene); scenes.splice(scenes.indexOf(override.scene), 1);
    expect(geometryDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
    batch.items[0].object.surfaceStyle = 'source';
    expect(renderObject(batch).meshes[0].material).toBe(material);
  });
  it('keeps all material primitives of an authored object together in separate mode', async () => {
    const fixture = sourceFixture();
    fixture.document.materials.push({ ...fixture.document.materials[0], name: 'Second material' });
    fixture.document.meshes[0].primitives.push({ ...fixture.document.meshes[0].primitives[0], material: 1 });
    const batch = await importModelJob({ kind: 'file', file: new File([JSON.stringify(fixture.document)], 'slots.gltf') }, { mode: 'separate' });
    expect(batch.items).toHaveLength(2);
    const { meshes } = renderObject(batch);
    expect(meshes).toHaveLength(2);
    expect(meshes.map((mesh) => (mesh.material as THREE.Material).name)).toEqual(['Authored paint', 'Second material']);
    expect(batch.items[0].object.importedModel?.meshCount).toBe(2);
  });
  it('keeps instancing instead of expanding vertices', async () => {
    const batch = await importFixture({ instanced: true });
    const { meshes } = renderObject(batch);
    expect((meshes[0] as THREE.InstancedMesh).isInstancedMesh).toBe(true);
    expect((meshes[0] as THREE.InstancedMesh).count).toBe(2);
    expect(meshes[0].geometry.getAttribute('position').count).toBe(4);
    expect(batch.analysis.instancesExpanded).toBe(false);
  });
  it('clones skins with independent bones while retaining source geometry', async () => {
    const batch = await importFixture({ skinned: true });
    const a = renderObject(batch).meshes[0] as THREE.SkinnedMesh;
    const b = renderObject(batch).meshes[0] as THREE.SkinnedMesh;
    expect(a.isSkinnedMesh).toBe(true); expect(a.skeleton.bones).toHaveLength(1);
    expect(a.skeleton).not.toBe(b.skeleton); expect(a.skeleton.bones[0]).not.toBe(b.skeleton.bones[0]);
    expect(a.geometry).toBe(b.geometry);
  });
  it('retains full hierarchy and opt-in lights for combined imports', async () => {
    const batch = await importFixture({}, 'combined');
    expect(batch.items).toHaveLength(1);
    const first = renderObject(batch);
    expect(first.meshes).toHaveLength(2);
    expect(first.root.getObjectByName('Camera')?.type).toBe('PerspectiveCamera');
    expect(first.root.getObjectByName('Key')?.visible).toBe(false);
    batch.items[0].object.sourceModelLightsEnabled = true;
    expect(renderObject(batch).root.getObjectByName('Key')?.visible).toBe(true);
  });
  it('packages source bytes once and restores them and object edits in a fresh runtime', async () => {
    const batch = await importFixture(); const project = projectFor(batch);
    project.scene.objects[0].transform.position[0] = 12;
    const bytes = await getModelAsset(batch.items[0].asset.storageKey!);
    const packaged = await createProjectPackage(project);
    const archive = await JSZip.loadAsync(await packaged.arrayBuffer());
    expect(Object.keys(archive.files).filter((name) => /^model-assets\/.*\.bin$/.test(name))).toHaveLength(1);
    resetSourceModelRuntimeForTests(); resetModelAssetStoreForTests();
    const reopened = await readProjectFile(new File([packaged], 'source.fsp'));
    await ensureSourceModelsForProject(reopened);
    expect(reopened.scene.objects[0].transform.position[0]).toBe(12);
    expect(reopened.scene.objects[0].surfaceStyle).toBe('source');
    const asset = reopened.assets.assets[reopened.scene.objects[0].modelAssetId!];
    expect(await getModelAsset(asset.storageKey!)).toEqual(bytes);
    const scene = buildScene(reopened); scenes.push(scene);
    expect(scene.getObjectsByProperty('isMesh', true).some((mesh: THREE.Object3D) => (mesh as THREE.Mesh).geometry.getAttribute('uv')?.count === 4)).toBe(true);
  });
  it('pins early templates while a later source loads past the idle timeout', async () => {
    const later = await importFixture();
    resetSourceModelRuntimeForTests(); // Keep bytes, discard the later template.
    vi.useFakeTimers();
    let load: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const early = await importFixture();
      const originalLoad = sourceModelLoader.loadSourceModel;
      load = vi.spyOn(sourceModelLoader, 'loadSourceModel').mockImplementationOnce(async (...args) => {
        vi.advanceTimersByTime(31_000);
        return originalLoad(...args);
      });
      const project = projectFor(early);
      project.scene.objects.push(...later.items.map((item) => item.object));
      later.items.forEach((item) => { project.assets.assets[item.asset.id] = item.asset; });
      await ensureSourceModelsForProject(project);
      expect(load).toHaveBeenCalledTimes(1);
      const first = renderObject(early);
      expect(first.root.userData.missingAssetPlaceholder).not.toBe(true);
      expect(first.meshes[0].geometry.getAttribute('uv')?.count).toBe(4);
    } finally {
      load?.mockRestore();
      vi.useRealTimers();
    }
  });
  it('collects companion buffers into a portable package without rewriting the source', async () => {
    const fixture = sourceFixture({ external: true });
    const file = new File([fixture.text], 'scene.gltf'); const buffer = new File([fixture.buffer], 'mesh.bin');
    const plan = createModelImportPlan([file, buffer]); expect(plan.issues).toEqual([]); expect(plan.jobs).toHaveLength(1);
    const batch = await importModelJob(plan.jobs[0], { mode: 'combined' });
    const bytes = await getModelAsset(batch.items[0].asset.storageKey!);
    const entries = await readSourceZip(bytes!);
    expect(new TextDecoder().decode(entries.get('scene.gltf'))).toBe(fixture.text);
    expect(new Uint8Array(entries.get('mesh.bin')!)).toEqual(fixture.buffer);
    const reopened = await readProjectFile(new File([await createProjectPackage(projectFor(batch))], 'resources.fsp'));
    await ensureSourceModelsForProject(reopened);
  });
  it('rejects absent companions, unsupported required extensions, invalid node paths and cancellation', async () => {
    const external = sourceFixture({ external: true });
    await expect(importModelJob({ kind: 'file', file: new File([external.text], 'bad.gltf') }, { mode: 'combined' })).rejects.toThrow(/Missing.*companion/i);
    const source = { ...sourceFixture().document, extensionsRequired: ['VENDOR_no_renderer'] };
    await expect(importModelJob({ kind: 'file', file: new File([JSON.stringify(source)], 'bad.gltf') }, { mode: 'combined' })).rejects.toThrow(/required glTF extensions/);
    const abort = new AbortController(); abort.abort();
    await expect(importModelJob({ kind: 'file', file: new File([sourceFixtureGlb()], 'scene.glb') }, { mode: 'combined', signal: abort.signal })).rejects.toThrow(/cancelled/i);
    const batch = await importFixture(); const project = projectFor(batch);
    project.scene.objects[0].sourceModelNodePath = [999];
    await expect(ensureSourceModelsForProject(project)).rejects.toThrow(/not present/);
    project.scene.objects[0].sourceModelNodePath = [-1];
    expect(() => parseProject(serializeProject(project))).toThrow(/source node/i);
  });
  it('keeps the explicit legacy graybox path available', async () => {
    const batch = await importModelJob({ kind: 'file', file: new File([sourceFixtureGlb()], 'scene.glb') }, { mode: 'combined', preservation: 'graybox' });
    expect(batch.items[0].asset.metadata?.modelEncoding).not.toBe('source');
    expect(batch.items[0].object.importedModel?.hierarchyFlattened).toBe(true);
    expect(renderObject(batch).meshes[0].geometry.getAttribute('uv')).toBeUndefined();
  });
  it('uses all instance transforms in projection coverage without mutating authored geometry', async () => {
    const batch = await importFixture({ instanced: true }, 'combined');
    const coverage = await extractCoverageScene(projectFor(batch));
    expect(coverage).toBeTruthy();
    const { meshes } = renderObject(batch);
    expect((meshes[0] as THREE.InstancedMesh).count).toBe(2);
  });
  it('rejects unsafe archive paths and preserves safe relative resource paths', () => {
    expect(() => sourceResourcePath('../outside')).toThrow();
    expect(() => sourceResourcePath('https://example.test/texture.png')).toThrow();
    expect(sourceResourcePath('models/../textures/wall.png')).toBe('textures/wall.png');
  });
});
