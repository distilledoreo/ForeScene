/**
 * Browser-safe deterministic manifest fingerprint for change detection (not security).
 */

import type { PrevisProductionManifestV1 } from './manifest';

/** FNV-1a 32-bit — stable across browser and Node for the same manifest JSON. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hashPrevisManifest(manifest: PrevisProductionManifestV1 | unknown): string {
  const canonical = typeof manifest === 'string'
    ? manifest
    : JSON.stringify(manifest);
  const a = fnv1a32(canonical);
  const b = fnv1a32(`${canonical}\0`);
  const c = fnv1a32(`${canonical}\0\0`);
  return a.toString(16).padStart(8, '0')
    + b.toString(16).padStart(8, '0')
    + c.toString(16).padStart(8, '0');
}
