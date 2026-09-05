import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('projected style materials (fast source gate)', () => {
  it('does not inject illegal PhysicalMaterial fields (r184)', () => {
    const materials = readFileSync(
      new URL('../src/engine/projectedStyleMaterials.ts', import.meta.url),
      'utf8',
    );
    expect(materials).not.toMatch(/material\.specularIntensity\s*\*=/);
    expect(materials).not.toMatch(/#include\s*<lights_physical_fragment>/);
    expect(materials).toContain('projected-style-v11');
    expect(materials).toContain('#include <aomap_fragment>');
    expect(materials).toContain('#include <color_fragment>');
    expect(materials).toContain('projectedHideUnprojectedGeometry');
    expect(materials).toContain('coverage <= VISIBILITY_EPSILON');
    expect(materials).toContain('discard;');
  });
});
