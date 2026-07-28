import * as THREE from 'three';
import JSZip from 'jszip';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject, createTransform } from '../src/domain/defaults';
import { ProjectAsset, SceneObject } from '../src/domain/types';
import { buildScene, disposeScene } from '../src/engine/sceneObjects';
import {
  MODEL_IMPORT_ACCEPT,
  MAX_SEPARATE_IMPORT_OBJECTS,
  createModelImportPlan,
  importModelJob,
  staleModelLoaderImportError,
} from '../src/engine/modelImport';
import {
  encodePackedGrayboxMesh,
  resetImportedMeshCacheForTests,
} from '../src/engine/importedMesh';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { useContinuityStore } from '../src/state/useContinuityStore';

beforeAll(() => {
  if (typeof ProgressEvent !== 'undefined') return;
  vi.stubGlobal('ProgressEvent', class TestProgressEvent extends Event {
    lengthComputable: boolean;
    loaded: number;
    total: number;

    constructor(type: string, init: ProgressEventInit = {}) {
      super(type);
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  });
});

describe('model import planning', () => {
  it('rewrites stale Vite loader-chunk failures into a hard-refresh hint', () => {
    const rewritten = staleModelLoaderImportError(
      new TypeError('Failed to fetch dynamically imported module: https://panoref.netlify.app/assets/FBXLoader-BWvV8Ag4.js'),
    );
    expect(rewritten?.message).toMatch(/Hard-refresh/i);
    expect(staleModelLoaderImportError(new Error('No triangle meshes were found in this file.'))).toBeUndefined();
  });

  it('creates one job per direct file (FBX/GLB) and reports native files as errors', () => {
    const blend = file(['native bytes'], 'courtyard.blend');
    const fbx = file(['fbx bytes'], 'courtyard.fbx');
    const glb = file(['glb bytes'], 'extra.glb');
    const plan = createModelImportPlan([blend, fbx, glb]);

    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs.some((j) => j.file.name === 'courtyard.fbx')).toBe(true);
    expect(plan.jobs.some((j) => j.file.name === 'extra.glb')).toBe(true);
    const nativeIssue = plan.issues.find((i) => i.fileName === 'courtyard.blend');
    expect(nativeIssue).toBeTruthy();
    expect(nativeIssue?.message).toContain('PanoRef cannot read Blender');
    expect(nativeIssue?.message).toContain('export the entire scene as a GLB');
  });

  it('does not include native DCC extensions in MODEL_IMPORT_ACCEPT', () => {
    expect(MODEL_IMPORT_ACCEPT).not.toContain('.blend');
    expect(MODEL_IMPORT_ACCEPT).not.toContain('.ma');
    expect(MODEL_IMPORT_ACCEPT).not.toContain('.mb');
    expect(MODEL_IMPORT_ACCEPT).not.toContain('.uproject');
    expect(MODEL_IMPORT_ACCEPT).not.toContain('.umap');
    expect(MODEL_IMPORT_ACCEPT).not.toContain('.uasset');
    expect(MODEL_IMPORT_ACCEPT).toContain('.glb');
    expect(MODEL_IMPORT_ACCEPT).toContain('.fbx');
    expect(MODEL_IMPORT_ACCEPT).toContain('.panoscene');
  });

  it('reports Maya native files with export guidance', () => {
    const plan = createModelImportPlan([file(['maya'], 'set.ma')]);
    expect(plan.jobs).toHaveLength(0);
    expect(plan.issues[0].message).toContain('PanoRef cannot read Maya');
    expect(plan.issues[0].message).toContain('Export All');
  });

  it('reports Unreal native files with export guidance', () => {
    const plan = createModelImportPlan([file(['unreal'], 'level.umap')]);
    expect(plan.jobs).toHaveLength(0);
    expect(plan.issues[0].message).toContain('PanoRef cannot read Unreal');
    expect(plan.issues[0].message).toContain('Export the current level as GLB');
  });

  it('produces one job + native error when both .blend and .fbx selected', () => {
    const blend = file(['native'], 'scene.blend');
    const fbx = file(['fbx'], 'scene.fbx');
    const plan = createModelImportPlan([blend, fbx]);
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].file.name).toBe('scene.fbx');
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0].fileName).toBe('scene.blend');
  });

  it('imports a portable native-scene handoff bundle', async () => {
    const zip = new JSZip();
    zip.file('panoref-scene.json', JSON.stringify({
      schemaVersion: 1,
      entry: 'geometry/set.obj',
      geometryOnly: true,
      source: { application: 'maya', file: 'set.mb' },
    }));
    zip.file('geometry/set.obj', [
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      'f 1 2 3',
    ].join('\n'));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const bundle = file([bytes], 'set.panoscene');

    const result = await importModelJob({ kind: 'bundle', file: bundle }, { mode: 'separate' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].object.importedModel).toMatchObject({
      sourceApplication: 'maya',
      sourceSceneName: 'set.mb',
      sourceKind: 'scene',
      triangleCount: 1,
      geometrySimplified: false,
      importMode: 'separate',
    });
    expect(result.summary.totalObjects).toBe(1);
  });
});

describe('texture-free model conversion', () => {
  beforeEach(() => resetImportedMeshCacheForTests());

  it('imports OBJ triangles unchanged and preserves source-space placement', async () => {
    const obj = file([
      'o Wall\n',
      'v 10 2 -1\n',
      'v 12 2 -1\n',
      'v 12 4 -1\n',
      'v 10 4 -1\n',
      'f 1 2 3\n',
      'f 1 3 4\n',
    ], 'wall.obj', 'text/plain');

    const result = await importModelJob({ kind: 'file', file: obj }, { mode: 'separate' });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.object.type).toBe('imported_model');
    expect(item.object.importedModel).toMatchObject({
      triangleCount: 2,
      vertexCount: 6,
      geometrySimplified: false,
      hierarchyFlattened: true,
      importMode: 'separate',
      meshCount: 1,
    });
    expect(item.object.transform.position).toEqual([11, 3, -1]);
    expect(item.object.dimensions).toEqual([2, 2, 0.001]);
    expect(item.asset.type).toBe('model');
    expect(item.asset.uri).not.toContain('v 10 2');

    const project = createDefaultProject();
    project.scene.objects = [item.object];
    project.assets.assets[item.asset.id] = item.asset;
    const scene = buildScene(project, { showHelpers: false });
    const imported = scene.getObjectByName(item.object.name) as THREE.Mesh;
    expect(imported).toBeTruthy();
    expect((imported.geometry.index?.count ?? 0) / 3).toBe(2);
    expect(imported.position.toArray()).toEqual([11, 3, -1]);
    const cachedGeometry = imported.geometry;
    disposeScene(scene);
    const rebuiltScene = buildScene(project, { showHelpers: false });
    expect((rebuiltScene.getObjectByName(item.object.name) as THREE.Mesh).geometry).toBe(cachedGeometry);
    disposeScene(rebuiltScene);
  });

  it('strips glTF material and texture references before conversion', async () => {
    const binary = new ArrayBuffer(44);
    new Float32Array(binary, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    new Uint16Array(binary, 36, 3).set([0, 1, 2]);
    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 44, uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      images: [{ uri: 'data:image/png;base64,not-decoded' }],
      textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };

    const result = await importModelJob({
      kind: 'file',
      file: file([JSON.stringify(gltf)], 'textured.gltf', 'model/gltf+json'),
    }, { mode: 'separate' });

    expect(result.items[0].object.importedModel?.triangleCount).toBe(1);
    expect(result.warnings.join(' ')).toContain('Removed');
    expect(result.items[0].asset.uri).not.toContain('not-decoded');
  });

  it('keeps canonical mesh assets through undo and prunes only on saved deletion', () => {
    const packed = encodePackedGrayboxMesh(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      new Uint32Array([0, 1, 2]),
    );
    const asset: ProjectAsset = {
      id: 'model_test',
      type: 'model',
      name: 'triangle.panoref-mesh',
      uri: packed.uri,
      createdAt: new Date(0).toISOString(),
    };
    const object: SceneObject = {
      id: 'obj_imported',
      name: 'Triangle',
      type: 'imported_model',
      transform: createTransform([0.5, 0.5, 0]),
      dimensions: [1, 1, 0.001],
      category: 'architecture',
      locked: false,
      visible: true,
      modelAssetId: asset.id,
    };
    const project = createDefaultProject();
    useContinuityStore.setState({
      project,
      selectedObjectIds: [],
      buildHistoryPast: [],
      buildHistoryFuture: [],
    });

    useContinuityStore.getState().addImportedModel({ asset, object });
    expect(useContinuityStore.getState().project.assets.assets[asset.id]).toBe(asset);
    expect(useContinuityStore.getState().undoBuild()).toBe(true);
    expect(useContinuityStore.getState().project.scene.objects).not.toContainEqual(object);
    expect(useContinuityStore.getState().project.assets.assets[asset.id]).toBe(asset);
    expect(useContinuityStore.getState().redoBuild()).toBe(true);
    expect(useContinuityStore.getState().project.scene.objects).toContainEqual(object);

    const saved = parseProject(serializeProject(useContinuityStore.getState().project));
    expect(saved.assets.assets[asset.id]).toBeTruthy();
    saved.scene.objects = saved.scene.objects.filter((candidate) => candidate.id !== object.id);
    expect(serializeProject(saved)).not.toContain(asset.id);
  });
});

describe('multi-object scene import', () => {
  beforeEach(() => resetImportedMeshCacheForTests());

  function buildMultiNodeGltf(): string {
    // Two separate meshes at different positions
    // Mesh 0: triangle at origin, Mesh 1: triangle at (5,0,0)
    const positions0 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const positions1 = new Float32Array([5, 0, 0, 6, 0, 0, 5, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);

    const allPositions = new Float32Array([...positions0, ...positions1]);
    const binary = new ArrayBuffer(allPositions.byteLength + indices.byteLength * 2);
    new Float32Array(binary, 0, allPositions.length).set(allPositions);
    new Uint16Array(binary, allPositions.byteLength, 3).set(indices);
    new Uint16Array(binary, allPositions.byteLength + 6, 3).set(indices);

    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions0.byteLength },
        { buffer: 0, byteOffset: positions0.byteLength, byteLength: positions1.byteLength },
        { buffer: 0, byteOffset: allPositions.byteLength, byteLength: 6 },
        { buffer: 0, byteOffset: allPositions.byteLength + 6, byteLength: 6 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [5, 0, 0], max: [6, 1, 0] },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
        { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 }, indices: 2 }], name: 'LeftPanel' },
        { primitives: [{ attributes: { POSITION: 1 }, indices: 3 }], name: 'RightPanel' },
      ],
      nodes: [
        { mesh: 0, name: 'LeftPanel', translation: [0, 0, 0] },
        { mesh: 1, name: 'RightPanel', translation: [0, 0, 0] },
      ],
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
    };
    return JSON.stringify(gltf);
  }

  function buildManyNodeGltf(count: number): string {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const binary = new ArrayBuffer(positions.byteLength + indices.byteLength);
    new Float32Array(binary, 0, positions.length).set(positions);
    new Uint16Array(binary, positions.byteLength, indices.length).set(indices);

    return JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: Array.from({ length: count }, (_, index) => ({ mesh: 0, name: `Panel-${index}`, translation: [index, 0, 0] })),
      scenes: [{ nodes: Array.from({ length: count }, (_, index) => index) }],
      scene: 0,
    });
  }

  function buildInvalidTriangleGltf(): string {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2, 0]);
    const binary = new ArrayBuffer(positions.byteLength + indices.byteLength);
    new Float32Array(binary, 0, positions.length).set(positions);
    new Uint16Array(binary, positions.byteLength, indices.length).set(indices);

    return JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 4, type: 'SCALAR' },
      ],
      meshes: [{ name: 'BrokenPanel', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ name: 'BrokenPanel', mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    });
  }

  function buildInstancedMeshGltf(): string {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const translations = new Float32Array([0, 0, 0, 3, 0, 0]);
    const translationOffset = positions.byteLength + indices.byteLength + 2;
    const binary = new ArrayBuffer(translationOffset + translations.byteLength);
    new Float32Array(binary, 0, positions.length).set(positions);
    new Uint16Array(binary, positions.byteLength, indices.length).set(indices);
    new Float32Array(binary, translationOffset, translations.length).set(translations);

    return JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_mesh_gpu_instancing'],
      buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
        { buffer: 0, byteOffset: translationOffset, byteLength: translations.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
        { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [3, 0, 0] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ name: 'RepeatedPanel', mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } } }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    });
  }

  it('separate mode: produces one object per mesh node with preserved layout', async () => {
    const gltfJson = buildMultiNodeGltf();
    const result = await importModelJob({
      kind: 'file',
      file: file([gltfJson], 'two-panels.gltf', 'model/gltf+json'),
    }, { mode: 'separate' });

    expect(result.items).toHaveLength(2);
    expect(result.summary.totalObjects).toBe(2);
    expect(result.summary.sourceNodeCount).toBe(2);
    expect(result.items[0].object.name).toBe('LeftPanel');
    expect(result.items[1].object.name).toBe('RightPanel');

    // World-space layout preserved – centers differ by ~5m on X
    const pos0 = result.items[0].object.transform.position;
    const pos1 = result.items[1].object.transform.position;
    expect(Math.abs(pos0[0] - pos1[0])).toBeGreaterThan(4);

    // Same sourceImportId
    expect(result.items[0].object.importedModel?.sourceImportId).toBe(result.items[1].object.importedModel?.sourceImportId);

    // Each has meshCount 1, importMode separate, sourceNodeName set
    expect(result.items[0].object.importedModel?.meshCount).toBe(1);
    expect(result.items[0].object.importedModel?.importMode).toBe('separate');
    expect(result.items[0].object.importedModel?.sourceNodeName).toBe('LeftPanel');
    expect(result.items[0].object.importedModel?.hierarchyFlattened).toBe(true);
    expect(result.items[0].object.transform.rotation).toEqual([0, 0, 0]);
    expect(result.items[0].object.transform.scale).toEqual([1, 1, 1]);
  });

  it('combined mode: produces a single combined object', async () => {
    const gltfJson = buildMultiNodeGltf();
    const result = await importModelJob({
      kind: 'file',
      file: file([gltfJson], 'two-panels.gltf', 'model/gltf+json'),
    }, { mode: 'combined' });

    expect(result.items).toHaveLength(1);
    expect(result.summary.totalObjects).toBe(1);
    expect(result.summary.combined).toBe(true);
    expect(result.items[0].object.importedModel?.meshCount).toBe(2);
    expect(result.items[0].object.importedModel?.importMode).toBe('combined');
    expect(result.items[0].object.importedModel?.triangleCount).toBe(2);
  });

  it('dedupes exact names without stripping meaningful numeric suffixes', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const binary = new ArrayBuffer(positions.byteLength + indices.byteLength);
    new Float32Array(binary, 0, positions.length).set(positions);
    new Uint16Array(binary, positions.byteLength, indices.length).set(indices);

    const makeGltfWithNames = (names: string[]) => {
      const meshes = names.map((name) => ({
        primitives: [{ attributes: { POSITION: 0 }, indices: 1 }],
        name,
      }));
      const nodes = names.map((name, i) => ({
        mesh: i,
        name,
        translation: [i * 2, 0, 0],
      }));
      return {
        asset: { version: '2.0' },
        buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}` }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
          { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
          { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
        ],
        meshes,
        nodes,
        scenes: [{ nodes: nodes.map((_, i) => i) }],
        scene: 0,
      };
    };

    const gltf = makeGltfWithNames(['Chair', 'Chair', 'Chair']);
    const result = await importModelJob({
      kind: 'file',
      file: file([JSON.stringify(gltf)], 'chairs.gltf', 'model/gltf+json'),
    }, { mode: 'separate' });

    expect(result.items.map((i) => i.object.name)).toEqual(['Chair', 'Chair (2)', 'Chair (3)']);

    const numbered = await importModelJob({
      kind: 'file',
      file: file([JSON.stringify(makeGltfWithNames(['Wall_01', 'Wall_02', 'Wall_02']))], 'walls.gltf', 'model/gltf+json'),
    }, { mode: 'separate' });

    expect(numbered.items.map((i) => i.object.name)).toEqual(['Wall_01', 'Wall_02', 'Wall_02 (2)']);
  });

  it('preserves world transforms and flips winding on negative scale', async () => {
    // Build a simple scene via three directly, export via GLB? Instead test via THREE object extraction using same path as OBJ with transform.
    // We'll create a custom loader by using modelImport internal via an OBJ that is actually multiple objects – but for negative scale test,
    // we rely on the generic extraction pipeline: create a glTF node with negative scale and ensure import does not throw and geometry is valid.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const binary = new ArrayBuffer(positions.byteLength + indices.byteLength);
    new Float32Array(binary, 0, positions.length).set(positions);
    new Uint16Array(binary, positions.byteLength, indices.length).set(indices);

    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}` }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }], name: 'NegScale' }],
      nodes: [{ mesh: 0, name: 'NegScale', scale: [-1, 1, 1] }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };

    const result = await importModelJob({
      kind: 'file',
      file: file([JSON.stringify(gltf)], 'neg.gltf', 'model/gltf+json'),
    }, { mode: 'separate' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].object.importedModel?.triangleCount).toBe(1);
    // Negative world scale must reverse the packed triangle winding.
    expect(result.items[0].object.dimensions[0]).toBeGreaterThan(0);
    const project = createDefaultProject();
    project.scene.objects = [result.items[0].object];
    project.assets.assets[result.items[0].asset.id] = result.items[0].asset;
    const scene = buildScene(project, { showHelpers: false });
    const imported = scene.getObjectByName(result.items[0].object.name) as THREE.Mesh;
    expect(Array.from(imported.geometry.index?.array ?? [])).toEqual([0, 2, 1]);
    disposeScene(scene);
  });

  it('enforces object-count safety limit', async () => {
    const tooMany = MAX_SEPARATE_IMPORT_OBJECTS + 1;
    await expect(importModelJob({
      kind: 'file',
      file: file([buildManyNodeGltf(tooMany)], 'many-panels.gltf', 'model/gltf+json'),
    }, { mode: 'separate' })).rejects.toThrow(
      `This file contains ${tooMany} separate objects, above the limit of ${MAX_SEPARATE_IMPORT_OBJECTS}`,
    );
  });

  it('rejects malformed triangle geometry instead of silently omitting the mesh', async () => {
    await expect(importModelJob({
      kind: 'file',
      file: file([buildInvalidTriangleGltf()], 'broken.gltf', 'model/gltf+json'),
    }, { mode: 'separate' })).rejects.toThrow(/Mesh "BrokenPanel" is not triangle geometry/);
  });

  it('keeps an InstancedMesh grouped as one object and preserves expanded instance metadata', async () => {
    const result = await importModelJob({
      kind: 'file',
      file: file([buildInstancedMeshGltf()], 'repeated.gltf', 'model/gltf+json'),
    }, { mode: 'separate' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].object.importedModel).toMatchObject({
      sourceNodeName: 'RepeatedPanel',
      instanceCount: 2,
      vertexCount: 6,
      triangleCount: 2,
    });
  });
});

describe('atomic store insertion', () => {
  beforeEach(() => resetImportedMeshCacheForTests());

  it('adds multiple objects in one history step and selects all', () => {
    const project = createDefaultProject();
    const initialCount = project.scene.objects.length;
    useContinuityStore.setState({
      project,
      selectedObjectIds: [],
      buildHistoryPast: [],
      buildHistoryFuture: [],
    });

    const results: Array<{ asset: ProjectAsset; object: SceneObject }> = [1, 2, 3].map((i) => {
      const packed = encodePackedGrayboxMesh(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        new Uint32Array([0, 1, 2]),
      );
      const asset: ProjectAsset = {
        id: `model_${i}`,
        type: 'model',
        name: `mesh${i}.panoref-mesh`,
        uri: packed.uri,
        createdAt: new Date().toISOString(),
      };
      const obj: SceneObject = {
        id: `obj_${i}`,
        name: `Mesh ${i}`,
        type: 'imported_model',
        transform: createTransform([i, 0, 0]),
        dimensions: [1, 1, 0.001],
        category: 'architecture',
        locked: false,
        visible: true,
        modelAssetId: asset.id,
        importedModel: {
          sourceName: 'test.gltf',
          sourceFormat: 'gltf',
          sourceKind: 'scene',
          vertexCount: 3,
          triangleCount: 1,
          meshCount: 1,
          importMode: 'separate',
          sourceImportId: 'import_123',
          sourceNodeName: `Mesh ${i}`,
          sourceNodePath: `Root[0]/Mesh ${i}[${i}]`,
          geometrySimplified: false,
          hierarchyFlattened: true,
        },
      };
      return { asset, object: obj };
    });

    const store = useContinuityStore.getState();
    store.addImportedModels(results);

    const after = useContinuityStore.getState();
    expect(after.project.scene.objects).toHaveLength(initialCount + 3);
    expect(after.selectedObjectIds).toHaveLength(3);
    expect(after.buildHistoryPast).toHaveLength(1);
    // Undo should remove all three at once
    expect(after.undoBuild()).toBe(true);
    expect(useContinuityStore.getState().project.scene.objects).toHaveLength(initialCount);
    expect(useContinuityStore.getState().selectedObjectIds).toHaveLength(0);
  });
});

function file(parts: BlobPart[], name: string, type = 'application/octet-stream'): File {
  return new File(parts, name, { type });
}
