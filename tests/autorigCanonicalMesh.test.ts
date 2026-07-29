import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { extractCanonicalVertexPositions, prepareCanonicalAutorigMesh } from '../src/engine/autorigCanonicalMesh';
import { centerAutorigMarkersDepth, suggestAutorigMarkers } from '../src/engine/autorigMarkers';

const orientation = { frontAxis: '+z' as const, upAxis: '+y' as const, groundLevelMeters: 0 };

describe('canonical autorig mesh preparation', () => {
  it('normalizes orientation, scale, grounding, and centering in one space', () => {
    const source = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    source.position.set(40, 12, -8);
    source.scale.set(3, 2, 0.5);
    const canonical = prepareCanonicalAutorigMesh({
      source,
      orientation,
      targetHeightMeters: 1.75,
    });

    expect(canonical.size[1]).toBeCloseTo(1.75, 5);
    expect(canonical.bounds.min[1]).toBeCloseTo(0, 5);
    expect((canonical.bounds.min[0] + canonical.bounds.max[0]) / 2).toBeCloseTo(0, 5);
    expect((canonical.bounds.min[2] + canonical.bounds.max[2]) / 2).toBeCloseTo(0, 5);
  });

  it('centers suggested joints between front and back surfaces', () => {
    const source = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.75, 0.4));
    const canonical = prepareCanonicalAutorigMesh({
      source,
      orientation,
      targetHeightMeters: 1.75,
    });
    const suggestions = suggestAutorigMarkers({ size: canonical.size, heightMeters: 1.75 });
    const result = centerAutorigMarkersDepth(suggestions, canonical.root);

    expect(result.centeredJointIds.length).toBeGreaterThan(0);
    expect(result.meaningfulDepth).toBe(false);
    const hips = result.markers.find((marker) => marker.jointId === 'hips');
    expect(hips?.position[2]).toBeCloseTo(0, 5);

    const side = centerAutorigMarkersDepth(suggestions, canonical.root, 'side');
    expect(side.centeredJointIds.length).toBeGreaterThan(0);
    expect(side.markers.find((marker) => marker.jointId === 'hips')?.position[0]).toBeCloseTo(0, 5);
  });

  it('produces equivalent canonical vertices from scaled and off-center source variants', () => {
    const sourceA = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.75, 0.4));
    const sourceB = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.75, 0.4));
    sourceB.position.set(40, -12, 8);
    sourceB.scale.setScalar(7);
    const a = prepareCanonicalAutorigMesh({ source: sourceA, orientation, targetHeightMeters: 1.75 });
    const b = prepareCanonicalAutorigMesh({ source: sourceB, orientation, targetHeightMeters: 1.75 });
    const positionsA = Array.from(extractCanonicalVertexPositions(a.root));
    const positionsB = Array.from(extractCanonicalVertexPositions(b.root));
    expect(positionsB).toHaveLength(positionsA.length);
    positionsA.forEach((value, index) => expect(positionsB[index]).toBeCloseTo(value, 5));
  });

  it('retains meaningful depth when the source has varying front/back offsets', () => {
    const source = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.35));
    torso.position.set(0, 0.7, 0.12);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 0.55));
    head.position.set(0, 1.45, -0.12);
    source.add(torso, head);
    const canonical = prepareCanonicalAutorigMesh({ source, orientation, targetHeightMeters: 1.75 });
    const markers = suggestAutorigMarkers({ size: canonical.size, heightMeters: 1.75 });
    const centered = centerAutorigMarkersDepth(markers, canonical.root);
    expect(centered.meaningfulDepth).toBe(true);
    expect(new Set(centered.centeredJointIds).size).toBeGreaterThan(0);
  });
});
