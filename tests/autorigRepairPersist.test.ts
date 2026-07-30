import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneSkinWeightBuffers, type SkinWeightBuffers } from '../src/engine/autorigSkinWeights';

function makeBuffers(vertexCount: number): SkinWeightBuffers {
  const ipv = 4;
  const indices = new Uint16Array(vertexCount * ipv);
  const weights = new Float32Array(vertexCount * ipv);
  for (let v = 0; v < vertexCount; v += 1) {
    indices[v * ipv] = 1;
    weights[v * ipv] = 1;
  }
  return {
    influencesPerVertex: ipv,
    indices,
    weights,
    jointOrder: ['hips', 'leftUpperArm'],
    fallbackVertexCount: 0,
  };
}

describe('autorig repaired skin buffer persistence', () => {
  it('cloneSkinWeightBuffers deep-copies so Apply can snapshot preview weights', () => {
    const original = makeBuffers(3);
    original.weights[0] = 0.42;
    const cloned = cloneSkinWeightBuffers(original);
    expect(cloned.weights[0]).toBeCloseTo(0.42, 5);
    expect(cloned.indices).not.toBe(original.indices);
    expect(cloned.weights).not.toBe(original.weights);
    expect(cloned.jointOrder).not.toBe(original.jointOrder);
    cloned.weights[0] = 0.99;
    expect(original.weights[0]).toBeCloseTo(0.42, 5);
  });

  it('generateSkinWeightsForRigAsset accepts skinBuffers override instead of regenerating', () => {
    const source = readFileSync(
      resolve('src/engine/autoriggedPoseableCharacter.ts'),
      'utf8',
    );
    expect(source).toMatch(/skinBuffers\?: SkinWeightBuffers/);
    expect(source).toMatch(/params\.skinBuffers\s*\n\s*\? cloneSkinWeightBuffers\(params\.skinBuffers\)/);
    expect(source).toMatch(/previewRepaired:\s*true/);
  });

  it('Pose & Fix UI surfaces Checking deformation while auto-repair runs', () => {
    const step = readFileSync(
      resolve('src/components/autorig/AutorigPoseFixStep.tsx'),
      'utf8',
    );
    expect(step).toMatch(/Checking deformation…/);
    expect(step).toMatch(/data-autorig-checking-deformation/);
    expect(step).toMatch(/fixLocked/);
  });
});
