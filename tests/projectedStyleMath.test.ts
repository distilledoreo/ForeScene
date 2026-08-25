import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { equirectUvToDirection } from '../src/engine/equirect';
import {
  applyInversePanoYaw,
  blendProjectedSample,
  equirectUvFromDirection,
  PROJECTED_STYLE_GLSL,
  rgbClose,
  sampleProjectedSyntheticAtWorld,
  sampleSyntheticDirectionalPano,
  SYNTHETIC_PANO_COLORS,
  worldPositionToProjectedPanoUv,
} from '../src/engine/projectedStyleMath';
import { shouldReceiveProjectedStyle } from '../src/engine/sceneObjects';
import { createSceneObject } from '../src/domain/defaults';
import { degreesToRadians } from '../src/engine/sync';

describe('projectedStyleMath equirect mapping', () => {
  it('maps +Z / +X / -Z / -X without mirroring', () => {
    expect(equirectUvFromDirection([0, 0, 1]).u).toBeCloseTo(0.5, 5);
    expect(equirectUvFromDirection([1, 0, 0]).u).toBeCloseTo(0.75, 5);
    expect(equirectUvFromDirection([0, 0, -1]).u).toBeCloseTo(0, 5);
    // -X is left when looking +Z (u≈0.25), not mirrored to the right.
    expect(equirectUvFromDirection([-1, 0, 0]).u).toBeCloseTo(0.25, 5);
  });

  it('clamps poles safely', () => {
    const up = equirectUvFromDirection([0, 1, 0]);
    const down = equirectUvFromDirection([0, -1, 0]);
    expect(up.v).toBeCloseTo(1, 5);
    expect(down.v).toBeCloseTo(0, 5);
    expect(up.u).toBeGreaterThanOrEqual(0);
    expect(up.u).toBeLessThanOrEqual(1);
  });

  it('wraps the horizontal seam without a gap (u continuous at ±π)', () => {
    const almostNeg = equirectUvFromDirection([0.0001, 0, -1]);
    const almostPos = equirectUvFromDirection([-0.0001, 0, -1]);
    // Both near -Z seam; u values should sit at opposite sides of the [0,1) wrap.
    expect(almostNeg.u).toBeGreaterThan(0.99);
    expect(almostPos.u).toBeLessThan(0.01);
    // Round-trip through equirectUvToDirection remains finite.
    for (const uv of [almostNeg, almostPos]) {
      const dir = equirectUvToDirection(uv.u, uv.v);
      expect(dir.every((n) => Number.isFinite(n))).toBe(true);
    }
  });

  it('round-trips cardinal directions through UV', () => {
    for (const dir of [
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
    ] as const) {
      const uv = equirectUvFromDirection([...dir]);
      const back = equirectUvToDirection(uv.u, uv.v);
      expect(back[0]).toBeCloseTo(dir[0], 4);
      expect(back[1]).toBeCloseTo(dir[1], 4);
      expect(back[2]).toBeCloseTo(dir[2], 4);
    }
  });

  it('applies positive pano yaw so world +Z samples former -X content (CCW from above)', () => {
    // After +90° pano yaw, world +Z is rotated into pano-local -X (u≈0.25).
    const local = applyInversePanoYaw([0, 0, 1], degreesToRadians(90));
    expect(local[0]).toBeCloseTo(-1, 5);
    expect(local[2]).toBeCloseTo(0, 5);
    const uv = equirectUvFromDirection(local);
    expect(uv.u).toBeCloseTo(0.25, 5);
  });

  it('returns null near the projector origin (fallback path)', () => {
    expect(worldPositionToProjectedPanoUv({
      worldPosition: [0, 1.6, 0],
      panoOrigin: [0, 1.6, 0],
      panoYawRadians: 0,
    })).toBeNull();
  });
});

describe('synthetic directional projection sampling', () => {
  const origin = [0, 1.6, 0] as const;

  it('paints each wall the expected color when viewed from the origin', () => {
    const cases: Array<{ pos: [number, number, number]; color: typeof SYNTHETIC_PANO_COLORS[keyof typeof SYNTHETIC_PANO_COLORS] }> = [
      { pos: [0, 1.6, 2], color: SYNTHETIC_PANO_COLORS['+z'] },
      { pos: [2, 1.6, 0], color: SYNTHETIC_PANO_COLORS['+x'] },
      { pos: [0, 1.6, -2], color: SYNTHETIC_PANO_COLORS['-z'] },
      { pos: [-2, 1.6, 0], color: SYNTHETIC_PANO_COLORS['-x'] },
      { pos: [0, 3.6, 0], color: SYNTHETIC_PANO_COLORS.ceiling },
      { pos: [0, 0.1, 0], color: SYNTHETIC_PANO_COLORS.floor },
    ];
    for (const item of cases) {
      const rgb = sampleProjectedSyntheticAtWorld({
        worldPosition: item.pos,
        panoOrigin: [...origin],
        opacity: 1,
        exposure: 1,
      });
      expect(rgb).not.toBe('near-origin');
      expect(rgbClose(rgb as [number, number, number], item.color)).toBe(true);
    }
  });

  it('is not mirrored: +X is green and -X is yellow', () => {
    const right = sampleProjectedSyntheticAtWorld({
      worldPosition: [3, 1.6, 0],
      panoOrigin: [...origin],
    });
    const left = sampleProjectedSyntheticAtWorld({
      worldPosition: [-3, 1.6, 0],
      panoOrigin: [...origin],
    });
    expect(rgbClose(right as [number, number, number], SYNTHETIC_PANO_COLORS['+x'])).toBe(true);
    expect(rgbClose(left as [number, number, number], SYNTHETIC_PANO_COLORS['-x'])).toBe(true);
  });

  it('positive yaw rotates sampling in the expected direction', () => {
    // With +90° yaw, a point on world +Z should sample the synthetic region that was at -X (yellow).
    const rgb = sampleProjectedSyntheticAtWorld({
      worldPosition: [0, 1.6, 2],
      panoOrigin: [...origin],
      panoYawRadians: degreesToRadians(90),
    });
    expect(rgbClose(rgb as [number, number, number], SYNTHETIC_PANO_COLORS['-x'])).toBe(true);
  });

  it('opacity 0 returns fallback; opacity 1 returns projection', () => {
    const fallback: [number, number, number] = [0.2, 0.3, 0.4];
    const atZero = sampleProjectedSyntheticAtWorld({
      worldPosition: [0, 1.6, 2],
      panoOrigin: [...origin],
      opacity: 0,
      fallbackRgb: fallback,
    });
    const atOne = sampleProjectedSyntheticAtWorld({
      worldPosition: [0, 1.6, 2],
      panoOrigin: [...origin],
      opacity: 1,
      fallbackRgb: fallback,
    });
    expect(rgbClose(atZero as [number, number, number], fallback)).toBe(true);
    expect(rgbClose(atOne as [number, number, number], SYNTHETIC_PANO_COLORS['+z'])).toBe(true);
  });

  it('blendProjectedSample respects exposure', () => {
    const blended = blendProjectedSample({
      sampleRgb: [0.5, 0, 0],
      fallbackRgb: [0, 0, 0],
      opacity: 1,
      exposure: 2,
    });
    expect(blended[0]).toBeCloseTo(1, 5);
  });

  it('helpers are not projected; architecture is', () => {
    const wall = createSceneObject('wall', 1);
    const person = createSceneObject('human_dummy', 1);
    const sun = createSceneObject('sun_marker', 1);
    const importedCreature = createSceneObject('imported_model', 1);
    importedCreature.stagingRole = 'prop';
    expect(shouldReceiveProjectedStyle(wall)).toBe(true);
    expect(shouldReceiveProjectedStyle(person)).toBe(false);
    expect(shouldReceiveProjectedStyle(sun)).toBe(false);
    expect(shouldReceiveProjectedStyle(importedCreature)).toBe(false);
  });

  it('shader embeds the same pure GLSL helpers used by JS', () => {
    const materials = readFileSync(new URL('../src/engine/projectedStyleMaterials.ts', import.meta.url), 'utf8');
    expect(materials).toContain('PROJECTED_STYLE_GLSL.applyInversePanoYaw');
    expect(materials).toContain('PROJECTED_STYLE_GLSL.equirectUvFromDirection');
    expect(PROJECTED_STYLE_GLSL.applyInversePanoYaw).toContain('direction.x * c - direction.z * s');
    expect(PROJECTED_STYLE_GLSL.equirectUvFromDirection).toContain('atan(direction.x, direction.z)');
  });

  it('does not wrap lights_fragment_begin or poke PhysicalMaterial fields (r184-safe)', () => {
    const materials = readFileSync(new URL('../src/engine/projectedStyleMaterials.ts', import.meta.url), 'utf8');
    // Regression: wrapping the include scopes geometryPosition/irradiance and breaks GLSL compile.
    expect(materials).not.toMatch(/if\s*\(\s*projectedLighting[\s\S]*?#include <lights_fragment_begin>/);
    // r184 MeshStandard/PhysicalMaterial: illegal field injections fail shader compile.
    expect(materials).not.toMatch(/material\.specularIntensity\s*\*=/);
    expect(materials).not.toMatch(/#include\s*<lights_physical_fragment>/);
    expect(materials).toContain('#include <aomap_fragment>');
    expect(materials).toContain('reflectedLight.indirectDiffuse = diffuseColor.rgb');
    expect(materials).toContain('projected-style-v10');
  });

  it('sampleSyntheticDirectionalPano covers seam UVs without NaN', () => {
    for (const u of [0, 0.001, 0.5, 0.999, 1 - 1e-9]) {
      const rgb = sampleSyntheticDirectionalPano(u, 0.5);
      expect(rgb.every((n) => Number.isFinite(n))).toBe(true);
    }
  });
});
