import type { SkinWeightBuffers } from '../autorigSkinWeights';

export interface PartialSkinWeightUpdate {
  revision: number;
  vertexIndices: Uint32Array;
  skinIndices: Uint16Array;
  skinWeights: Float32Array;
  warnings: string[];
  fallbackVertexCount?: number;
}

/** Validate a partial update before mutating live buffers. */
export function validatePartialSkinUpdate(params: {
  buffers: SkinWeightBuffers;
  update: PartialSkinWeightUpdate;
  expectedRevision?: number;
}): { ok: true } | { ok: false; message: string } {
  const { buffers, update } = params;
  if (
    typeof params.expectedRevision === 'number'
    && update.revision !== params.expectedRevision
  ) {
    return { ok: false, message: 'Stale correction revision.' };
  }
  const ipv = buffers.influencesPerVertex;
  const vertexCount = Math.floor(buffers.indices.length / ipv);
  if (update.vertexIndices.length * ipv !== update.skinIndices.length) {
    return { ok: false, message: 'Partial skin index length mismatch.' };
  }
  if (update.skinIndices.length !== update.skinWeights.length) {
    return { ok: false, message: 'Partial skin weight length mismatch.' };
  }
  for (let i = 0; i < update.vertexIndices.length; i += 1) {
    const v = update.vertexIndices[i]!;
    if (v >= vertexCount) {
      return { ok: false, message: `Vertex index ${v} out of range.` };
    }
    const base = i * ipv;
    let sum = 0;
    for (let s = 0; s < ipv; s += 1) {
      const w = update.skinWeights[base + s]!;
      if (!Number.isFinite(w) || w < 0) {
        return { ok: false, message: 'Non-finite or negative skin weight.' };
      }
      const joint = update.skinIndices[base + s]!;
      if (!Number.isFinite(joint) || joint < 0 || joint >= buffers.jointOrder.length) {
        return { ok: false, message: 'Invalid skin joint index.' };
      }
      sum += w;
    }
    if (Math.abs(sum - 1) > 0.05 && sum > 1e-6) {
      return { ok: false, message: 'Skin weights do not sum to one.' };
    }
  }
  return { ok: true };
}

/** Patch global skin buffers with a partial update (mutates in place). */
export function applyPartialSkinUpdate(
  buffers: SkinWeightBuffers,
  update: PartialSkinWeightUpdate,
): void {
  const ipv = buffers.influencesPerVertex;
  for (let i = 0; i < update.vertexIndices.length; i += 1) {
    const v = update.vertexIndices[i]!;
    const src = i * ipv;
    const dst = v * ipv;
    for (let s = 0; s < ipv; s += 1) {
      buffers.indices[dst + s] = update.skinIndices[src + s]!;
      buffers.weights[dst + s] = update.skinWeights[src + s]!;
    }
  }
}

/**
 * Slice dirty vertices out of a full Binder V2 result.
 * Correct by construction relative to a full regeneration.
 */
export function extractPartialSkinUpdate(params: {
  buffers: SkinWeightBuffers;
  vertexIndices: ArrayLike<number>;
  revision: number;
  warnings?: string[];
}): PartialSkinWeightUpdate {
  const ipv = params.buffers.influencesPerVertex;
  const count = params.vertexIndices.length;
  const skinIndices = new Uint16Array(count * ipv);
  const skinWeights = new Float32Array(count * ipv);
  const vertexIndices = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const v = params.vertexIndices[i]! >>> 0;
    vertexIndices[i] = v;
    const src = v * ipv;
    const dst = i * ipv;
    for (let s = 0; s < ipv; s += 1) {
      skinIndices[dst + s] = params.buffers.indices[src + s]!;
      skinWeights[dst + s] = params.buffers.weights[src + s]!;
    }
  }
  return {
    revision: params.revision,
    vertexIndices,
    skinIndices,
    skinWeights,
    warnings: params.warnings ? [...params.warnings] : [],
    fallbackVertexCount: params.buffers.fallbackVertexCount,
  };
}
