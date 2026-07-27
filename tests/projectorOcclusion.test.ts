import { describe, expect, it } from 'vitest';
import {
  computeProjectorBlendWeights,
  decodeDepthMeters,
  packDepth16,
  sampleProjectorVisibility,
  unpackDepth16,
} from '../src/engine/projectedStyleMath';
import {
  computeProjectorOcclusionKey,
} from '../src/engine/projectorOcclusion';
import { normalizeProjectedStyleSettings, createDefaultProject } from '../src/domain/defaults';

describe('radial-depth packing', () => {
  it('packs 0 m to normalized 0', () => {
    const [h, l] = packDepth16(0);
    expect(unpackDepth16(h, l)).toBeCloseTo(0, 5);
  });

  it('packs 1.0 to normalized 1', () => {
    const [h, l] = packDepth16(1);
    expect(unpackDepth16(h, l)).toBeCloseTo(1, 5);
  });

  it('round-trips mid-range values', () => {
    for (const v of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const [h, l] = packDepth16(v);
      const decoded = unpackDepth16(h, l);
      // 16-bit precision: within one 16-bit step (~1.5e-5).
      expect(Math.abs(decoded - v)).toBeLessThan(2 / 65535 + 1e-6);
    }
  });

  it('clamps out-of-range inputs', () => {
    const [hNeg, lNeg] = packDepth16(-3);
    const [hPos, lPos] = packDepth16(5);
    expect(unpackDepth16(hNeg, lNeg)).toBeCloseTo(0, 5);
    expect(unpackDepth16(hPos, lPos)).toBeCloseTo(1, 5);
  });

  it('decodes packed bytes back to world meters', () => {
    const [h, l] = packDepth16(0.5);
    expect(decodeDepthMeters([h, l, 1, 1], 0.05, 50)).toBeCloseTo(0.05 + 49.95 * 0.5, 2);
  });

  it('blue channel is the valid-hit flag', () => {
    // No hit (blue = 0): every fragment is visible regardless of distance.
    expect(sampleProjectorVisibility({
      worldPosition: [10, 0, 0],
      projectorOrigin: [0, 0, 0],
      packedDepth: [0.5, 0.5, 0, 1],
      nearMeters: 0.05,
      farMeters: 50,
    }).visible).toBe(true);
    // Hit (blue = 1) at ~25m: a fragment 10m away (in front) is visible...
    expect(sampleProjectorVisibility({
      worldPosition: [10, 0, 0],
      projectorOrigin: [0, 0, 0],
      packedDepth: [0.5, 0.5, 1, 1],
      nearMeters: 0.05,
      farMeters: 50,
    }).visible).toBe(true);
    // ...and a fragment 40m away (behind the 25m hit) is occluded.
    expect(sampleProjectorVisibility({
      worldPosition: [40, 0, 0],
      projectorOrigin: [0, 0, 0],
      packedDepth: [0.5, 0.5, 1, 1],
      nearMeters: 0.05,
      farMeters: 50,
    }).visible).toBe(false);
  });
});

describe('sampleProjectorVisibility', () => {
  const near = 0.05;
  const far = 50;
  const origin = [0, 0, 0] as const;

  it('fragment at captured depth is visible', () => {
    const packed = ((): [number, number, number, number] => {
      const [h, l] = packDepth16((10 - near) / (far - near));
      return [h, l, 1, 1];
    })();
    expect(sampleProjectorVisibility({
      worldPosition: [10, 0, 0], projectorOrigin: [...origin], packedDepth: packed, nearMeters: near, farMeters: far, biasMeters: 0.04,
    }).visible).toBe(true);
  });

  it('fragment slightly behind within bias is visible', () => {
    const packed = ((): [number, number, number, number] => {
      const [h, l] = packDepth16((10 - near) / (far - near));
      return [h, l, 1, 1];
    })();
    expect(sampleProjectorVisibility({
      worldPosition: [10.03, 0, 0], projectorOrigin: [...origin], packedDepth: packed, nearMeters: near, farMeters: far, biasMeters: 0.04,
    }).visible).toBe(true);
  });

  it('absorbs packing/self-hit error beyond the raw bias (no false occlusion strips)', () => {
    const packed = ((): [number, number, number, number] => {
      const [h, l] = packDepth16((10 - near) / (far - near));
      return [h, l, 1, 1];
    })();
    // 8 cm behind the recorded hit exceeds the 4 cm raw bias, but stays within
    // the adaptive relative+quantization bias used to prevent stripy acne.
    expect(sampleProjectorVisibility({
      worldPosition: [10.08, 0, 0], projectorOrigin: [...origin], packedDepth: packed, nearMeters: near, farMeters: far, biasMeters: 0.04,
    }).visible).toBe(true);
  });

  it('fragment clearly behind is occluded', () => {
    const packed = ((): [number, number, number, number] => {
      const [h, l] = packDepth16((10 - near) / (far - near));
      return [h, l, 1, 1];
    })();
    expect(sampleProjectorVisibility({
      worldPosition: [30, 0, 0], projectorOrigin: [...origin], packedDepth: packed, nearMeters: near, farMeters: far, biasMeters: 0.04,
    }).visible).toBe(false);
  });

  it('fragment in front is visible', () => {
    const packed = ((): [number, number, number, number] => {
      const [h, l] = packDepth16((10 - near) / (far - near));
      return [h, l, 1, 1];
    })();
    expect(sampleProjectorVisibility({
      worldPosition: [5, 0, 0], projectorOrigin: [...origin], packedDepth: packed, nearMeters: near, farMeters: far, biasMeters: 0.04,
    }).visible).toBe(true);
  });

  it('missing map behaves as legacy visible', () => {
    expect(sampleProjectorVisibility({
      worldPosition: [5, 0, 0], projectorOrigin: [...origin], packedDepth: null, nearMeters: near, farMeters: far,
    }).visible).toBe(true);
  });
});

describe('visibility-gated multi-origin blend weights', () => {
  const primary = [0, 0, 0] as const;
  const secondary = [5, 0, 0] as const;
  const world = [1, 0, 0] as const;

  it('both visible -> confidence-weighted', () => {
    const w = computeProjectorBlendWeights({ worldPosition: [...world], primaryOrigin: [...primary], secondaryOrigin: [...secondary], mode: 'primary_dominant', primaryVisibility: 1, secondaryVisibility: 1 });
    expect(w.primary + w.secondary).toBeCloseTo(1, 5);
    expect(w.bothOccluded).toBe(false);
  });

  it('primary only visible -> primary weight 1', () => {
    const w = computeProjectorBlendWeights({ worldPosition: [...world], primaryOrigin: [...primary], secondaryOrigin: [...secondary], mode: 'primary_dominant', primaryVisibility: 1, secondaryVisibility: 0 });
    expect(w.primary).toBe(1);
    expect(w.secondary).toBe(0);
  });

  it('secondary only visible -> secondary weight 1', () => {
    const w = computeProjectorBlendWeights({ worldPosition: [...world], primaryOrigin: [...primary], secondaryOrigin: [...secondary], mode: 'primary_dominant', primaryVisibility: 0, secondaryVisibility: 1 });
    expect(w.primary).toBe(0);
    expect(w.secondary).toBe(1);
  });

  it('neither visible -> bothOccluded', () => {
    const w = computeProjectorBlendWeights({ worldPosition: [...world], primaryOrigin: [...primary], secondaryOrigin: [...secondary], mode: 'primary_dominant', primaryVisibility: 0, secondaryVisibility: 0 });
    expect(w.primary).toBe(0);
    expect(w.secondary).toBe(0);
    expect(w.bothOccluded).toBe(true);
  });

  it('primary-only mode with primary occluded -> fallback', () => {
    const w = computeProjectorBlendWeights({ worldPosition: [...world], primaryOrigin: [...primary], mode: 'primary_only', primaryVisibility: 0 });
    expect(w.primary).toBe(0);
    expect(w.bothOccluded).toBe(true);
  });

  it('secondary-only mode with secondary occluded -> fallback', () => {
    const w = computeProjectorBlendWeights({ worldPosition: [...world], primaryOrigin: [...primary], secondaryOrigin: [...secondary], mode: 'secondary_only', primaryVisibility: 1, secondaryVisibility: 0 });
    expect(w.secondary).toBe(0);
    expect(w.bothOccluded).toBe(true);
  });

  it('omitted visibility defaults to 1 (legacy / non-occlusion paths)', () => {
    const w = computeProjectorBlendWeights({ worldPosition: [...world], primaryOrigin: [...primary], secondaryOrigin: [...secondary], mode: 'primary_dominant' });
    expect(w.primary + w.secondary).toBeCloseTo(1, 5);
  });
});

describe('occlusion generation key', () => {
  const origin: [number, number, number] = [0, 1.6, 0];

  it('is stable for identical geometry', () => {
    const project = createDefaultProject();
    const a = computeProjectorOcclusionKey(project, origin);
    const b = computeProjectorOcclusionKey(project, origin);
    expect(a).toBe(b);
  });

  it('changes when an object moves', () => {
    const project = createDefaultProject();
    const before = computeProjectorOcclusionKey(project, origin);
    const after = computeProjectorOcclusionKey({
      ...project,
      scene: {
        ...project.scene,
        objects: project.scene.objects.map((o, i) => (i === 0 ? { ...o, transform: { ...o.transform, position: [1, 1, 1] } } : o)),
      },
    }, origin);
    expect(after).not.toBe(before);
  });

  it('ignores camera / selection / exposure changes', () => {
    const project = createDefaultProject();
    const base = computeProjectorOcclusionKey(project, origin);
    const withExtraSettings = {
      ...project,
      settings: { ...project.settings, projectedStyle: { ...project.settings.projectedStyle!, exposure: 3 } },
    };
    expect(computeProjectorOcclusionKey(withExtraSettings, origin)).toBe(base);
  });

  it('is deterministic FNV-1a hex of fixed length', () => {
    const project = createDefaultProject();
    const key = computeProjectorOcclusionKey(project, origin);
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('normalized occlusion settings (backward compatible)', () => {
  it('defaults fill in for old projects', () => {
    const s = normalizeProjectedStyleSettings({} as never);
    expect(s.occlusionEnabled).toBe(true);
    expect(s.occlusionBiasMeters).toBe(0.04);
    expect(s.occlusionSoftness).toBe(1);
    expect(s.occlusionDebugMode).toBe('off');
    expect(s.blendMode).toBe('primary_only');
  });

  it('clamps bias and softness', () => {
    const s = normalizeProjectedStyleSettings({ occlusionBiasMeters: 9, occlusionSoftness: 99 } as never);
    expect(s.occlusionBiasMeters).toBe(0.5);
    expect(s.occlusionSoftness).toBe(2);
  });

  it('old projects without occlusion fields still normalize', () => {
    const legacy = normalizeProjectedStyleSettings({
      panoId: 'x', opacity: 1, exposure: 1, lightingContribution: 0, fallbackMode: 'clay',
    });
    expect(legacy.occlusionEnabled).toBe(true);
    expect(legacy.occlusionBiasMeters).toBe(0.04);
  });

  it('does not mutate the project object (no serialized GPU resources)', () => {
    const project = createDefaultProject();
    const before = JSON.stringify(project);
    normalizeProjectedStyleSettings(project.settings.projectedStyle);
    expect(JSON.stringify(project)).toBe(before);
  });
});

// Synthetic geometry: drive the pure visibility + blend math as if a depth cube
// had been rendered from each projector origin.
const NEAR = 0.05;
const FAR = 100;

/** Build a packed RG depth cube texel for a hit at `meters` along the ray. */
function hitAt(meters: number): [number, number, number, number] {
  const [h, l] = packDepth16((meters - NEAR) / (FAR - NEAR));
  return [h, l, 1, 1];
}

describe('synthetic geometry: front / rear occlusion', () => {
  const origin: [number, number, number] = [0, 0, 0];

  it('front-facing surface (in front of occluder) is visible', () => {
    // Occluder recorded at 10m; a fragment at 6m is in front.
    const v = sampleProjectorVisibility({
      worldPosition: [6, 0, 0], projectorOrigin: origin, packedDepth: hitAt(10), nearMeters: NEAR, farMeters: FAR,
    });
    expect(v.visible).toBe(true);
    expect(v.firstHitMeters).toBeCloseTo(10, 2);
  });

  it('rear-facing surface (behind occluder) is occluded', () => {
    // Fragment at 14m is behind a 10m occluder.
    const v = sampleProjectorVisibility({
      worldPosition: [14, 0, 0], projectorOrigin: origin, packedDepth: hitAt(10), nearMeters: NEAR, farMeters: FAR,
    });
    expect(v.visible).toBe(false);
  });

  it('seam ray (opposite direction) reads an independent depth', () => {
    // A fragment behind the origin should sample the OPPOSITE cube face,
    // not the +X face. With a near miss (2m) on the -X face, a fragment
    // at 4m behind the origin must be occluded by that independent ray.
    const v = sampleProjectorVisibility({
      worldPosition: [-4, 0, 0], projectorOrigin: origin, packedDepth: hitAt(2), nearMeters: NEAR, farMeters: FAR,
    });
    expect(v.visible).toBe(false);
  });
});

describe('synthetic geometry: dual-origin fill', () => {
  const primary: [number, number, number] = [0, 0, 0];
  const secondary: [number, number, number] = [8, 0, 0];

  it('primary occluded but secondary sees the fragment -> secondary fills', () => {
    // Fragment near secondary (x=7). Primary occluded (hit at 1m on +X),
    // secondary sees it (no occluder on its own ray to x=7).
    const world: [number, number, number] = [7, 0, 0];
    const primaryVis = sampleProjectorVisibility({
      worldPosition: world, projectorOrigin: primary, packedDepth: hitAt(1), nearMeters: NEAR, farMeters: FAR,
    }).visible ? 1 : 0;
    const secondaryVis = sampleProjectorVisibility({
      worldPosition: world, projectorOrigin: secondary, packedDepth: null, nearMeters: NEAR, farMeters: FAR,
    }).visible ? 1 : 0;
    const w = computeProjectorBlendWeights({
      worldPosition: world, primaryOrigin: primary, secondaryOrigin: secondary, mode: 'primary_dominant',
      primaryVisibility: primaryVis, secondaryVisibility: secondaryVis,
    });
    expect(w.primary).toBe(0);
    expect(w.secondary).toBe(1);
    expect(w.bothOccluded).toBe(false);
  });

  it('both projectors occluded -> fallback (bothOccluded)', () => {
    const world: [number, number, number] = [4, 0, 0];
    const primaryVis = sampleProjectorVisibility({
      worldPosition: world, projectorOrigin: primary, packedDepth: hitAt(1), nearMeters: NEAR, farMeters: FAR,
    }).visible ? 1 : 0;
    const secondaryVis = sampleProjectorVisibility({
      worldPosition: world, projectorOrigin: secondary, packedDepth: hitAt(1), nearMeters: NEAR, farMeters: FAR,
    }).visible ? 1 : 0;
    const w = computeProjectorBlendWeights({
      worldPosition: world, primaryOrigin: primary, secondaryOrigin: secondary, mode: 'primary_dominant',
      primaryVisibility: primaryVis, secondaryVisibility: secondaryVis,
    });
    expect(w.bothOccluded).toBe(true);
    expect(w.primary + w.secondary).toBe(0);
  });
});
