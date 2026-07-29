import * as THREE from 'three';
import { fillRegionColorAttribute } from './regionOverlay';

/**
 * Apply (or update) per-vertex region colors on a clay preview root.
 * Materials are switched to vertexColors so the Body Parts overlay is visible.
 * Returns a disposer that restores original materials.
 */
export function applyRegionColorsToPreviewRoot(params: {
  root: THREE.Object3D;
  /** Canonical vertex labels aligned with extractCanonicalVertexPositions order. */
  labels: Uint8Array;
  confidence?: Float32Array | null;
  topologyVertexMeshPart?: Uint32Array | null;
}): () => void {
  const colors = fillRegionColorAttribute({
    labels: params.labels,
    confidence: params.confidence,
  });
  const restorers: Array<() => void> = [];
  let vertexCursor = 0;

  params.root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const count = position.count;

    // Slice the canonical color buffer for this mesh part.
    const local = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const src = (vertexCursor + i) * 3;
      local[i * 3] = colors[src] ?? 0.5;
      local[i * 3 + 1] = colors[src + 1] ?? 0.5;
      local[i * 3 + 2] = colors[src + 2] ?? 0.5;
    }
    vertexCursor += count;

    const previousColor = geometry.getAttribute('color');
    geometry.setAttribute('color', new THREE.BufferAttribute(local, 3));
    geometry.attributes.color!.needsUpdate = true;

    const previousMaterial = mesh.material;
    const materials = Array.isArray(previousMaterial) ? previousMaterial : [previousMaterial];
    const nextMaterials = materials.map((material) => {
      if (!material) return material;
      const clone = material.clone();
      if ('vertexColors' in clone) (clone as THREE.MeshBasicMaterial).vertexColors = true;
      if ('color' in clone) (clone as THREE.MeshBasicMaterial).color?.set(0xffffff);
      return clone;
    });
    mesh.material = Array.isArray(previousMaterial) ? nextMaterials : nextMaterials[0]!;

    restorers.push(() => {
      if (previousColor) geometry.setAttribute('color', previousColor);
      else geometry.deleteAttribute('color');
      const current = mesh.material;
      const currentList = Array.isArray(current) ? current : [current];
      for (const material of currentList) material?.dispose();
      mesh.material = previousMaterial;
    });
  });

  return () => {
    for (const restore of restorers) restore();
  };
}

/** Update only the color attribute values without rebuilding materials. */
export function updateRegionColorsOnPreviewRoot(params: {
  root: THREE.Object3D;
  labels: Uint8Array;
  confidence?: Float32Array | null;
}): void {
  const colors = fillRegionColorAttribute({
    labels: params.labels,
    confidence: params.confidence,
  });
  let vertexCursor = 0;
  params.root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    const position = mesh.geometry.getAttribute('position');
    if (!attr || !position) {
      vertexCursor += position?.count ?? 0;
      return;
    }
    const count = position.count;
    for (let i = 0; i < count; i += 1) {
      const src = (vertexCursor + i) * 3;
      attr.setXYZ(i, colors[src] ?? 0.5, colors[src + 1] ?? 0.5, colors[src + 2] ?? 0.5);
    }
    attr.needsUpdate = true;
    vertexCursor += count;
  });
}
