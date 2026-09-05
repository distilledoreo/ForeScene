import {
  HUMANOID_FIXTURE_POSITION_MAX,
  HUMANOID_FIXTURE_POSITION_MIN,
  HUMANOID_FIXTURE_POSITIONS,
} from './humanoidMeshPositions';

/** Small, genuinely unrigged humanoid-shaped GLB used for saved-rig autorig coverage. */
export function unriggedHumanoidGlb(options: { nodeName?: string } = {}): ArrayBuffer {
  const positions = Buffer.from(HUMANOID_FIXTURE_POSITIONS.buffer);
  const bin = positions;
  const gltf = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{
      bufferView: 0,
      componentType: 5126,
      count: 6,
      type: 'VEC3',
      min: HUMANOID_FIXTURE_POSITION_MIN,
      max: HUMANOID_FIXTURE_POSITION_MAX,
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ name: options.nodeName ?? 'UnriggedHumanoid', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPadding)]);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = Buffer.alloc(totalLength);
  let offset = 0;
  glb.write('glTF', offset, 4, 'ascii'); offset += 4;
  glb.writeUInt32LE(2, offset); offset += 4;
  glb.writeUInt32LE(totalLength, offset); offset += 4;
  glb.writeUInt32LE(jsonChunk.length, offset); offset += 4;
  glb.writeUInt32LE(0x4e4f534a, offset); offset += 4;
  jsonChunk.copy(glb, offset); offset += jsonChunk.length;
  glb.writeUInt32LE(binChunk.length, offset); offset += 4;
  glb.writeUInt32LE(0x004e4942, offset); offset += 4;
  binChunk.copy(glb, offset);
  return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
}
