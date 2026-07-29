import * as THREE from 'three';
import type { PoseableCharacterOrientation, Vec3 } from '../domain/types';

export interface CanonicalAutorigMesh {
  /** The exact normalized rest mesh used by preview, fitting, and skinning. */
  root: THREE.Group;
  bounds: { min: Vec3; max: Vec3 };
  size: Vec3;
  heightMeters: number;
}

function axisToVector(axis: PoseableCharacterOrientation['frontAxis']): THREE.Vector3 {
  switch (axis) {
    case '+x': return new THREE.Vector3(1, 0, 0);
    case '-x': return new THREE.Vector3(-1, 0, 0);
    case '+y': return new THREE.Vector3(0, 1, 0);
    case '-y': return new THREE.Vector3(0, -1, 0);
    case '+z': return new THREE.Vector3(0, 0, 1);
    case '-z': return new THREE.Vector3(0, 0, -1);
  }
}

/** Map a source front/up declaration into the canonical +Z/+Y frame. */
export function canonicalOrientationQuaternion(
  orientation: PoseableCharacterOrientation,
): THREE.Quaternion {
  const front = axisToVector(orientation.frontAxis).normalize();
  const up = axisToVector(orientation.upAxis).normalize();
  if (Math.abs(front.dot(up)) > 0.999) return new THREE.Quaternion();
  const sourceBasis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(up, front).normalize(),
    up,
    front,
  );
  const canonicalBasis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  );
  const sourceRotation = new THREE.Quaternion().setFromRotationMatrix(sourceBasis);
  const canonicalRotation = new THREE.Quaternion().setFromRotationMatrix(canonicalBasis);
  return canonicalRotation.multiply(sourceRotation.invert());
}

/**
 * Prepare one authoritative canonical mesh. Every consumer gets the same
 * orientation, height normalization, grounding, and X/Z centering.
 */
export function prepareCanonicalAutorigMesh(params: {
  source: THREE.Object3D;
  orientation: PoseableCharacterOrientation;
  targetHeightMeters: number;
}): CanonicalAutorigMesh {
  const root = new THREE.Group();
  root.name = 'autorig-canonical-mesh';
  root.quaternion.copy(canonicalOrientationQuaternion(params.orientation));
  root.add(params.source.clone(true));
  root.updateMatrixWorld(true);

  const orientedBounds = new THREE.Box3().setFromObject(root);
  const orientedSize = orientedBounds.getSize(new THREE.Vector3());
  const sourceHeight = orientedSize.y > 1e-6
    ? orientedSize.y
    : Math.max(orientedSize.x, orientedSize.z, 1);
  root.scale.setScalar(params.targetHeightMeters / sourceHeight);
  root.updateMatrixWorld(true);

  const scaledBounds = new THREE.Box3().setFromObject(root);
  root.position.set(
    -(scaledBounds.min.x + scaledBounds.max.x) * 0.5,
    params.orientation.groundLevelMeters - scaledBounds.min.y,
    -(scaledBounds.min.z + scaledBounds.max.z) * 0.5,
  );
  root.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  return {
    root,
    bounds: {
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    },
    size: [size.x, size.y, size.z],
    heightMeters: size.y,
  };
}

/** Extract canonical vertex positions while preserving mesh boundaries elsewhere. */
export function extractCanonicalVertexPositions(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true);
  const values: number[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const point = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      values.push(point.x, point.y, point.z);
    }
  });
  return Float32Array.from(values);
}

/** Triangle adjacency input in the same traversal order as vertex extraction. */
export function extractCanonicalTopology(root: THREE.Object3D): Uint32Array {
  root.updateMatrixWorld(true);
  const triangles: number[] = [];
  let vertexOffset = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const index = mesh.geometry.getIndex();
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) {
        triangles.push(vertexOffset + index.getX(i), vertexOffset + index.getX(i + 1), vertexOffset + index.getX(i + 2));
      }
    } else {
      for (let i = 0; i + 2 < position.count; i += 3) {
        triangles.push(vertexOffset + i, vertexOffset + i + 1, vertexOffset + i + 2);
      }
    }
    vertexOffset += position.count;
  });
  return Uint32Array.from(triangles);
}
