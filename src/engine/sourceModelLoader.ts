import * as THREE from 'three';
import type { SourceModelBounds, SourceModelDescriptor, SourceModelNode } from '../domain/sourceModelTypes';
import { checkSourceImportAbort, sourceResourcePath, type SourceModelPackage } from './sourceModelPackage';

type Renderable = THREE.Mesh | THREE.Line | THREE.Points;
export interface LoadedSourceModel {
  root: THREE.Object3D;
  scenes: THREE.Object3D[];
  animations: THREE.AnimationClip[];
  nodes: SourceModelNode[];
  bounds: SourceModelBounds;
  materialCount: number;
  textureCount: number;
  textureBytes: number;
  geometryBytes: number;
  lightCount: number;
  cameraCount: number;
  requiredExtensions: string[];
  warnings: string[];
  clone: (root: THREE.Object3D) => THREE.Object3D;
}

const GLTF_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression', 'KHR_lights_punctual', 'KHR_materials_anisotropy',
  'KHR_materials_clearcoat', 'KHR_materials_dispersion', 'KHR_materials_emissive_strength',
  'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_transmission',
  'KHR_materials_iridescence', 'KHR_materials_unlit', 'KHR_materials_volume', 'KHR_materials_sheen',
  'KHR_mesh_quantization', 'KHR_meshopt_compression', 'EXT_meshopt_compression',
  'KHR_texture_basisu', 'KHR_texture_transform', 'EXT_materials_bump',
  'EXT_mesh_gpu_instancing', 'EXT_texture_avif', 'EXT_texture_webp',
]);

interface GltfDocument {
  asset?: { version?: string };
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  nodes?: Array<{ mesh?: number; weights?: number[] }>;
  meshes?: Array<{ weights?: number[] }>;
}

/** Read metadata without rewriting even a byte of the imported glTF/GLB. */
export function readSourceGltfDocument(bytes: ArrayBuffer, binary: boolean): GltfDocument {
  if (!binary) return JSON.parse(new TextDecoder().decode(bytes)) as GltfDocument;
  if (bytes.byteLength < 20) throw new Error('Invalid GLB header.');
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a) {
    throw new Error('Invalid GLB 2.0 header or JSON chunk.');
  }
  const length = view.getUint32(12, true);
  if (!length || length % 4 !== 0 || length > bytes.byteLength - 20) throw new Error('Invalid GLB JSON length.');
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length))) as GltfDocument;
}

export function isSourceRenderable(node: THREE.Object3D): node is Renderable {
  return Boolean((node as THREE.Mesh).isMesh || (node as THREE.Line).isLine || (node as THREE.Points).isPoints);
}

function mimeForResource(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp', ktx2: 'image/ktx2' } as Record<string, string>)[extension ?? '']
    ?? 'application/octet-stream';
}

/** Resolve only user-supplied bytes. Missing or remote dependencies are errors, not gray materials. */
function packageLoadingManager(files: Map<string, ArrayBuffer>) {
  const manager = new THREE.LoadingManager();
  const urls = new Map<string, string>();
  const errors = new Set<string>();
  let outstanding = 0;
  const waiters: Array<() => void> = [];
  const start = manager.itemStart.bind(manager);
  const end = manager.itemEnd.bind(manager);
  manager.itemStart = (url) => { outstanding += 1; start(url); };
  manager.itemEnd = (url) => {
    end(url);
    outstanding -= 1;
    if (outstanding === 0) waiters.splice(0).forEach((resolve) => resolve());
  };
  manager.onError = (url) => { errors.add(`Could not load source resource: ${url}`); };
  manager.setURLModifier((url) => {
    if (/^(data:|blob:)/i.test(url)) return url;
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch { /* literal percent characters are valid file names */ }
    let name: string | undefined;
    for (const candidate of [url, decoded]) {
      try {
        const normalized = sourceResourcePath(candidate);
        if (files.has(normalized)) { name = normalized; break; }
      } catch { /* absolute DCC paths may resolve to a supplied, unique basename below */ }
    }
    if (!name) {
      const basename = decoded.replace(/\\/g, '/').split('/').pop();
      const matches = [...files.keys()].filter((key) => key.split('/').pop() === basename);
      if (matches.length === 1) name = matches[0];
    }
    if (!name) {
      const message = `Missing or ambiguous companion file: ${url}. Select the model and its resources together, or export a self-contained GLB. External requests are disabled.`;
      errors.add(message);
      throw new Error(message);
    }
    let objectUrl = urls.get(name);
    if (!objectUrl) {
      objectUrl = URL.createObjectURL(new Blob([files.get(name)!], { type: mimeForResource(name) }));
      urls.set(name, objectUrl);
    }
    return objectUrl;
  });
  return {
    manager,
    errors,
    async settled() { if (outstanding > 0) await new Promise<void>((resolve) => waiters.push(resolve)); },
    dispose() { urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear(); },
  };
}

async function configureGltfDecoders(loader: import('three/addons/loaders/GLTFLoader.js').GLTFLoader, used: Set<string>): Promise<Array<() => void>> {
  const dispose: Array<() => void> = [];
  try {
    if (used.has('EXT_meshopt_compression') || used.has('KHR_meshopt_compression')) {
      const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
      loader.setMeshoptDecoder(MeshoptDecoder);
    }
    if (used.has('KHR_draco_mesh_compression')) {
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      const wrapper = new URL('../../node_modules/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js', import.meta.url).href;
      const wasm = new URL('../../node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm', import.meta.url).href;
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => url.endsWith('.wasm') ? wasm : wrapper);
      const decoder = new DRACOLoader(manager).setDecoderConfig({ type: 'wasm' }).setWorkerLimit(2);
      loader.setDRACOLoader(decoder);
      dispose.push(() => decoder.dispose());
    }
    if (used.has('KHR_texture_basisu')) {
      if (typeof document === 'undefined') throw new Error('KTX2 textures require a WebGL-capable browser.');
      const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
      const script = new URL('../../node_modules/three/examples/jsm/libs/basis/basis_transcoder.js', import.meta.url).href;
      const wasm = new URL('../../node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm', import.meta.url).href;
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        if (url.endsWith('basis_transcoder.wasm')) return wasm;
        if (url.endsWith('basis_transcoder.js')) return script;
        return loader.manager.resolveURL(url);
      });
      manager.onError = (url) => loader.manager.itemError(url);
      const decoder = new KTX2Loader(manager).setWorkerLimit(2);
      const loadTexture = decoder.load.bind(decoder);
      decoder.load = (url, onLoad, onProgress, onError) => loadTexture(url, onLoad, onProgress, (error) => {
        // glTF catches texture decoder errors; record them before that fallback can hide damage.
        loader.manager.itemError(url);
        onError?.(error);
      });
      dispose.push(() => decoder.dispose());
      // Capability detection is renderer-local; never borrow or destroy the editor's context.
      const probe = new THREE.WebGLRenderer({ antialias: false });
      try { decoder.detectSupport(probe); } finally { probe.dispose(); probe.forceContextLoss(); }
      loader.setKTX2Loader(decoder);
    }
    return dispose;
  } catch (error) { dispose.forEach((release) => release()); throw error; }
}

export async function loadSourceModel(input: SourceModelPackage, signal?: AbortSignal): Promise<LoadedSourceModel> {
  checkSourceImportAbort(signal);
  const bytes = input.files.get(input.entry);
  if (!bytes) throw new Error(`Missing entry model: ${input.entry}`);
  const resources = packageLoadingManager(input.files);
  const base = input.entry.includes('/') ? input.entry.slice(0, input.entry.lastIndexOf('/') + 1) : '';
  let root: THREE.Object3D | undefined;
  let scenes: THREE.Object3D[] = [];
  let animations: THREE.AnimationClip[] = [];
  let requiredExtensions: string[] = [];
  let isAuthoredNode: ((node: THREE.Object3D) => boolean) | undefined;
  const warnings: string[] = [];
  let decoderDisposers: Array<() => void> = [];
  try {
    if ([...input.files.keys()].some((name) => /\.tga$/i.test(name))) {
      const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
      resources.manager.addHandler(/\.tga$/i, new TGALoader(resources.manager));
    }
    if ([...input.files.keys()].some((name) => /\.dds$/i.test(name))) {
      const { DDSLoader } = await import('three/addons/loaders/DDSLoader.js');
      resources.manager.addHandler(/\.dds$/i, new DDSLoader(resources.manager));
    }
    if (input.format === 'glb' || input.format === 'gltf') {
      const document = readSourceGltfDocument(bytes, input.format === 'glb');
      if (document.asset?.version !== '2.0') throw new Error('Preserved-source import requires glTF 2.0.');
      requiredExtensions = document.extensionsRequired ?? [];
      const unsupported = requiredExtensions.filter((name) => !GLTF_EXTENSIONS.has(name));
      if (unsupported.length) throw new Error(`Cannot render required glTF extensions: ${unsupported.join(', ')}. The original file has not been modified.`);
      for (const extension of document.extensionsUsed ?? []) {
        if (!GLTF_EXTENSIONS.has(extension)) warnings.push(`Extension ${extension} is retained in the source but is not interpreted by the renderer.`);
      }
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader(resources.manager);
      decoderDisposers = await configureGltfDecoders(loader, new Set([...(document.extensionsUsed ?? []), ...requiredExtensions]));
      const gltf = await loader.parseAsync(input.format === 'glb' ? bytes : new TextDecoder().decode(bytes), base);
      root = gltf.scene;
      scenes = gltf.scenes;
      animations = gltf.animations;
      isAuthoredNode = (node) => gltf.parser.associations.get(node)?.nodes !== undefined;
      // GLTFLoader's instancing extension constructs a new InstancedMesh, whose
      // updateMorphTargets is intentionally empty. Restore the node-wide morph
      // weights before rendering; otherwise WebGLMorphtargets reads undefined.
      // All instances of a glTF node share these authored weights. Do not expand
      // geometry or fabricate per-instance animation data.
      for (const scene of scenes) scene.traverse((node) => {
        const mesh = node as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh || mesh.morphTexture || mesh.morphTargetInfluences) return;
        if (!Object.values(mesh.geometry.morphAttributes).some((attributes) => attributes.length > 0)) return;
        THREE.Mesh.prototype.updateMorphTargets.call(mesh);
        let owner: THREE.Object3D | null = mesh;
        let nodeIndex: number | undefined;
        while (owner && nodeIndex === undefined) {
          nodeIndex = gltf.parser.associations.get(owner)?.nodes;
          owner = owner.parent;
        }
        const nodeDef = nodeIndex === undefined ? undefined : document.nodes?.[nodeIndex];
        const weights = nodeDef?.weights ?? (nodeDef?.mesh === undefined ? undefined : document.meshes?.[nodeDef.mesh]?.weights);
        if (weights) {
          const influences = (mesh as THREE.Mesh).morphTargetInfluences;
          if (weights.length !== influences?.length || !weights.every(Number.isFinite)) {
            throw new Error('Instanced source mesh has invalid morph weights.');
          }
          mesh.morphTargetInfluences = [...weights];
        }
      });
    } else if (input.format === 'fbx') {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      root = new FBXLoader(resources.manager).parse(bytes, base);
      animations = root.animations;
      warnings.push('FBX source bytes are preserved. Runtime materials use Three.js FBX conversion, not Maya/Arnold shader evaluation.');
    } else if (input.format === 'obj') {
      const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
        import('three/addons/loaders/OBJLoader.js'), import('three/addons/loaders/MTLLoader.js'),
      ]);
      const text = new TextDecoder().decode(bytes);
      const loader = new OBJLoader(resources.manager);
      const libraries = [...text.matchAll(/^\s*mtllib\s+(.+)$/gm)].map((match) => match[1].trim());
      if (libraries.length) {
        const combined: Record<string, import('three/addons/loaders/MTLLoader.js').MaterialInfo> = {};
        let creator: import('three/addons/loaders/MTLLoader.js').MTLLoader.MaterialCreator | undefined;
        // MaterialCreator can only use one resource base; resolve each map before merging.
        for (const library of libraries) {
          const path = sourceResourcePath(base + library);
          const materialBytes = input.files.get(path) ?? [...input.files].find(([name]) => name === library)?.[1];
          if (!materialBytes) throw new Error(`Missing OBJ material library: ${library}. Select its MTL and texture files too.`);
          const mtlBase = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
          const current = new MTLLoader(resources.manager).parse(new TextDecoder().decode(materialBytes), mtlBase);
          current.preload();
          if (!creator) creator = current;
          Object.assign(combined, current.materialsInfo);
          Object.assign(creator.materials, current.materials);
        }
        if (creator) { creator.materialsInfo = combined; loader.setMaterials(creator); }
      }
      root = loader.parse(text);
    } else {
      let geometry: THREE.BufferGeometry;
      if (input.format === 'stl') {
        const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
        geometry = new STLLoader(resources.manager).parse(bytes);
      } else {
        const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
        geometry = new PLYLoader(resources.manager).parse(bytes);
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ color: 0xc8cdc8, roughness: 0.75, vertexColors: Boolean(geometry.getAttribute('color')) });
      root = new THREE.Group();
      if (input.format === 'ply' && !geometry.index) {
        material.dispose();
        root.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xffffff, size: 0.02, vertexColors: Boolean(geometry.getAttribute('color')) })));
      } else root.add(new THREE.Mesh(geometry, material));
    }
    await resources.settled();
    checkSourceImportAbort(signal);
    if (resources.errors.size) throw new Error([...resources.errors].join('\n'));
    if (!scenes.length) scenes = [root];
    root.updateMatrixWorld(true);
    const { clone } = await import('three/addons/utils/SkeletonUtils.js');
    const stats = inspectSourceModel(root, scenes, isAuthoredNode);
    if (!stats.nodes.length) throw new Error('No renderable geometry was found in the source model.');
    if (animations.length) warnings.push(`${animations.length} animation clip(s) are retained; source clips are not automatically played on the ForeScene timeline.`);
    if (scenes.length > 1) warnings.push(`All ${scenes.length} source scenes are retained; the source's default scene is displayed.`);
    if (stats.lightCount || stats.cameraCount) warnings.push('Source cameras and lights are retained. ForeScene cameras and lighting remain active by default.');
    return { root, scenes, animations, ...stats, requiredExtensions, warnings, clone };
  } catch (error) {
    if (root) disposeSourceResources(scenes.length ? scenes : [root]);
    throw error;
  } finally {
    decoderDisposers.forEach((dispose) => dispose());
    resources.dispose();
  }
}

export function sourceNodeAtPath(root: THREE.Object3D, path: readonly number[]): THREE.Object3D {
  let node = root;
  for (const index of path) {
    if (!Number.isSafeInteger(index) || index < 0 || !node.children[index]) throw new Error(`Source node path is unavailable: /${path.join('/')}`);
    node = node.children[index];
  }
  return node;
}

function nodeBounds(node: Renderable): THREE.Box3 {
  let box: THREE.Box3 | null;
  if ((node as THREE.SkinnedMesh).isSkinnedMesh || (node as THREE.InstancedMesh).isInstancedMesh) {
    const mesh = node as THREE.SkinnedMesh | THREE.InstancedMesh;
    mesh.computeBoundingBox();
    box = mesh.boundingBox;
  } else {
    node.geometry.computeBoundingBox();
    box = node.geometry.boundingBox;
  }
  return box ? box.clone().applyMatrix4(node.matrixWorld) : new THREE.Box3();
}

export function boundsData(box: THREE.Box3): SourceModelBounds {
  const values = [...box.min.toArray(), ...box.max.toArray()];
  if (box.isEmpty() || !values.every(Number.isFinite)) throw new Error('Source model has empty or non-finite bounds.');
  return { min: box.min.toArray(), max: box.max.toArray() };
}

function texturesOf(material: THREE.Material): THREE.Texture[] {
  return Object.values(material).filter((value): value is THREE.Texture => Boolean(value?.isTexture));
}

function textureFootprint(texture: THREE.Texture): number {
  if ((texture as THREE.CompressedTexture).isCompressedTexture) {
    return (texture.mipmaps ?? []).reduce((sum, mip) => sum + ((mip as { data?: ArrayBufferView }).data?.byteLength ?? 0), 0);
  }
  const images = Array.isArray(texture.image) ? texture.image : [texture.image];
  const bytesPerPixel = texture.type === THREE.FloatType ? 16 : texture.type === THREE.HalfFloatType ? 8 : 4;
  return images.reduce((sum: number, image: { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | undefined) => {
    const width = image?.naturalWidth || image?.width || 0;
    const height = image?.naturalHeight || image?.height || 0;
    return sum + Math.ceil(width * height * bytesPerPixel * (texture.generateMipmaps ? 4 / 3 : 1));
  }, 0);
}

function inspectSourceModel(root: THREE.Object3D, scenes: THREE.Object3D[], isAuthoredNode?: (node: THREE.Object3D) => boolean) {
  const nodes: SourceModelNode[] = [];
  const union = new THREE.Box3();
  const paths = new Map<THREE.Object3D, number[]>();
  const grouped = new Map<THREE.Object3D, { bounds: THREE.Box3; node: SourceModelNode }>();
  const visit = (node: THREE.Object3D, path: number[]) => {
    paths.set(node, path);
    if (!node.matrixWorld.elements.every(Number.isFinite)) throw new Error('Source contains a non-finite transform.');
    if (isSourceRenderable(node)) {
      const position = node.geometry.getAttribute('position');
      if (position?.count) {
        const bounds = nodeBounds(node);
        union.union(bounds);
        const instances = (node as THREE.InstancedMesh).isInstancedMesh ? (node as THREE.InstancedMesh).count : 1;
        // GLTFLoader splits material primitives into child meshes. Their authored node
        // must remain one selectable object, without absorbing nested authored objects.
        let owner: THREE.Object3D = node;
        if (isAuthoredNode) {
          let candidate: THREE.Object3D | null = node;
          while (candidate && !isAuthoredNode(candidate)) candidate = candidate.parent;
          if (candidate && paths.has(candidate)) owner = candidate;
        }
        let group = grouped.get(owner);
        if (!group) {
          group = { bounds: new THREE.Box3(), node: {
            path: [...paths.get(owner)!], renderablePaths: [], name: owner.name || `Object ${nodes.length + 1}`,
            bounds: boundsData(bounds), vertexCount: 0, triangleCount: 0, instanceCount: 0,
          } };
          grouped.set(owner, group); nodes.push(group.node);
        }
        group.bounds.union(bounds);
        group.node.bounds = boundsData(group.bounds);
        group.node.renderablePaths!.push([...path]);
        group.node.vertexCount += position.count * instances;
        group.node.triangleCount += (node as THREE.Mesh).isMesh ? Math.floor((node.geometry.index?.count ?? position.count) / 3) * instances : 0;
        group.node.instanceCount = Math.max(group.node.instanceCount, instances);
      }
    }
    node.children.forEach((child, index) => visit(child, [...path, index]));
  };
  visit(root, []);
  const resources = collectSourceResources(scenes);
  const arrays = new Set<ArrayBufferView>();
  for (const geometry of resources.geometries) {
    const attributes = [...Object.values(geometry.attributes), ...Object.values(geometry.morphAttributes).flat(), ...(geometry.index ? [geometry.index] : [])];
    for (const attribute of attributes) arrays.add((attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
      ? (attribute as THREE.InterleavedBufferAttribute).data.array : (attribute as THREE.BufferAttribute).array);
  }
  let instanceBytes = 0;
  let lightCount = 0;
  let cameraCount = 0;
  root.traverse((node) => {
    if ((node as THREE.InstancedMesh).isInstancedMesh) {
      const mesh = node as THREE.InstancedMesh;
      instanceBytes += mesh.instanceMatrix.array.byteLength + (mesh.instanceColor?.array.byteLength ?? 0);
    }
    if ((node as THREE.Light).isLight) lightCount += 1;
    if ((node as THREE.Camera).isCamera) cameraCount += 1;
  });
  return {
    nodes, bounds: boundsData(union), materialCount: resources.materials.size,
    textureCount: resources.textures.size,
    textureBytes: [...resources.textures].reduce((sum, texture) => sum + textureFootprint(texture), 0),
    geometryBytes: [...arrays].reduce((sum, array) => sum + array.byteLength, 0) + instanceBytes,
    lightCount, cameraCount,
  };
}

export function collectSourceResources(roots: readonly THREE.Object3D[]) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  const instancedMeshes = new Set<THREE.InstancedMesh>();
  for (const root of roots) root.traverse((node) => {
    if (!isSourceRenderable(node)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      texturesOf(material).forEach((texture) => textures.add(texture));
    }
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((node as THREE.SkinnedMesh).skeleton);
    if ((node as THREE.InstancedMesh).isInstancedMesh) instancedMeshes.add(node as THREE.InstancedMesh);
  });
  return { geometries, materials, textures, skeletons, instancedMeshes };
}

export function disposeSourceResources(roots: readonly THREE.Object3D[]): void {
  const resources = collectSourceResources(roots);
  resources.geometries.forEach((geometry) => geometry.dispose());
  resources.materials.forEach((material) => material.dispose());
  const bitmaps = new Set<ImageBitmap>();
  resources.textures.forEach((texture) => {
    texture.dispose();
    const images = Array.isArray(texture.image) ? texture.image : [texture.image];
    for (const image of images) if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) bitmaps.add(image);
  });
  bitmaps.forEach((bitmap) => bitmap.close());
  resources.skeletons.forEach((skeleton) => skeleton.dispose());
  resources.instancedMeshes.forEach((mesh) => mesh.dispose());
}

export function sourceDescriptor(input: SourceModelPackage, model: LoadedSourceModel, sourceHash: string): SourceModelDescriptor {
  return {
    version: 1, format: input.format, container: input.container, entry: input.entry,
    resourceNames: [...input.files.keys()], sourceHash,
    bounds: model.bounds, meshNodes: model.nodes,
    animations: model.animations.map((clip) => ({ name: clip.name, duration: clip.duration })),
    scenes: model.scenes.map((scene, index) => scene.name || `Scene ${index + 1}`),
    materialCount: model.materialCount, textureCount: model.textureCount,
    textureBytes: model.textureBytes, geometryBytes: model.geometryBytes,
    lightCount: model.lightCount, cameraCount: model.cameraCount,
    requiredExtensions: model.requiredExtensions,
  };
}
