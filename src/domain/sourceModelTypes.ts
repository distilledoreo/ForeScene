/** Source binaries are immutable. Editor transforms and material overrides live on SceneObject. */
export type SourceModelFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl' | 'ply';
export type ModelImportPreservation = 'preserve' | 'graybox';

export interface SourceModelBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SourceModelNode {
  /** Child indices, not names or runtime UUIDs: stable with duplicate/empty authored names. */
  path: number[];
  /** Material primitives belonging to this authored node, excluding child authored objects. */
  renderablePaths?: number[][];
  name: string;
  bounds: SourceModelBounds;
  vertexCount: number;
  triangleCount: number;
  instanceCount: number;
}

export interface SourceModelDescriptor {
  version: 1;
  format: SourceModelFormat;
  /** Raw files remain byte-for-byte unchanged; ZIP packages retain every companion file. */
  container: 'raw' | 'zip';
  entry: string;
  resourceNames: string[];
  sourceHash: string;
  bounds: SourceModelBounds;
  meshNodes: SourceModelNode[];
  animations: Array<{ name: string; duration: number }>;
  scenes: string[];
  materialCount: number;
  textureCount: number;
  textureBytes: number;
  geometryBytes: number;
  lightCount: number;
  cameraCount: number;
  requiredExtensions: string[];
}
