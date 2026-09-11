/** Tiny authored scene fixtures; no network or third-party asset dependencies. */
export function sourceFixture(options: { texture?: boolean; external?: boolean; instanced?: boolean; skinned?: boolean } = {}) {
  const chunks: Uint8Array[] = [];
  const views: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [];
  const accessors: Array<Record<string, unknown>> = [];
  let length = 0;
  function accessor(values: Float32Array | Uint16Array, type: string, min?: number[], max?: number[]) {
    const pad = (4 - length % 4) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    const bytes = new Uint8Array(values.buffer);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes); length += bytes.length;
    accessors.push({ bufferView: views.length - 1, componentType: values instanceof Uint16Array ? 5123 : 5126,
      count: values.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!), type,
      ...(min ? { min } : {}), ...(max ? { max } : {}) });
    return accessors.length - 1;
  }
  const position = accessor(new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]), 'VEC3', [-1,-1,0], [1,1,0]);
  const normal = accessor(new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), 'VEC3');
  const uv = accessor(new Float32Array([0,0, 1,0, 1,1, 0,1]), 'VEC2');
  const indices = accessor(new Uint16Array([0,1,2, 0,2,3]), 'SCALAR');
  const morph = accessor(new Float32Array([0,0,0.2, 0,0,0.2, 0,0,0.2, 0,0,0.2]), 'VEC3', [0,0,0.2], [0,0,0.2]);
  const times = accessor(new Float32Array([0,1]), 'SCALAR', [0], [1]);
  const translations = accessor(new Float32Array([0,0,0, 0,1,0]), 'VEC3');
  const attributes: Record<string, number> = { POSITION: position, NORMAL: normal, TEXCOORD_0: uv };
  const nodes: Array<Record<string, unknown>> = [
    { name: 'Set', translation: [2,0,0], children: [1,2] },
    { name: 'Panel', mesh: 0, translation: [-2,0,0], extras: { role: 'hero', authorData: { retain: true } } },
    { name: 'Panel', mesh: 0, translation: [2,0,0] },
    { name: 'Camera', camera: 0, translation: [0,0,5] },
    { name: 'Key', extensions: { KHR_lights_punctual: { light: 0 } }, translation: [0,0,3] },
  ];
  const extensionsUsed = ['KHR_lights_punctual', 'KHR_materials_unlit'];
  if (options.instanced) {
    const translation = accessor(new Float32Array([0,0,0, 0,3,0]), 'VEC3');
    nodes[1].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: translation } } };
    extensionsUsed.push('EXT_mesh_gpu_instancing');
  }
  let skins: unknown[] | undefined;
  if (options.skinned) {
    attributes.JOINTS_0 = accessor(new Uint16Array(16), 'VEC4');
    attributes.WEIGHTS_0 = accessor(new Float32Array([1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]), 'VEC4');
    const inverse = accessor(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), 'MAT4');
    nodes.push({ name: 'Joint' });
    nodes[0].children = [1,2,5];
    nodes[1].skin = 0; nodes[2].skin = 0;
    skins = [{ joints: [5], inverseBindMatrices: inverse }];
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  let binary = '';
  buffer.forEach((value) => { binary += String.fromCharCode(value); });
  const document = {
    asset: { version: '2.0', generator: 'ForeScene source preservation tests' }, scene: 0,
    scenes: [{ name: 'Authored scene', nodes: [0,3,4] }], nodes,
    buffers: [{ byteLength: length, uri: options.external ? 'mesh.bin' : `data:application/octet-stream;base64,${btoa(binary)}` }],
    bufferViews: views, accessors,
    meshes: [{ name: 'Shared authored panel', weights: [0.5], primitives: [{ attributes, indices, material: 0, targets: [{ POSITION: morph }] }] }],
    materials: [{ name: 'Authored paint', doubleSided: true, extensions: { KHR_materials_unlit: {} },
      pbrMetallicRoughness: { baseColorFactor: [1,1,1,1], metallicFactor: 0.25, roughnessFactor: 0.35,
        ...(options.texture ? { baseColorTexture: { index: 0 } } : {}) } }],
    ...(options.texture ? { textures: [{ source: 0 }], images: [{ uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nAXBAQEAAAjDIG7/zhNE0k3CAz7tBf5/xlWuAAAAAElFTkSuQmCC' }] } : {}),
    cameras: [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.1, zfar: 100 } }],
    extensionsUsed, extensions: { KHR_lights_punctual: { lights: [{ type: 'point', intensity: 5 }] } },
    animations: [{ name: 'Retained motion', samplers: [{ input: times, output: translations }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] }],
    extras: { untouched: 'source metadata' }, ...(skins ? { skins } : {}),
  };
  return { document, buffer, text: JSON.stringify(document) };
}

export function sourceFixtureGlb(options: Parameters<typeof sourceFixture>[0] = {}): ArrayBuffer {
  const json = new TextEncoder().encode(sourceFixture(options).text);
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + length);
  const view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true); view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).fill(32); new Uint8Array(bytes, 20, json.length).set(json);
  return bytes;
}
