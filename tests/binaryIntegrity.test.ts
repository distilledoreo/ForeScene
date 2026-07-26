import { describe, expect, it, vi } from 'vitest';
import { sha256Digest } from '../src/engine/binaryIntegrity';

describe('binary integrity', () => {
  it('uses a real SHA-256 fallback when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(sha256Digest(new TextEncoder().encode('abc').buffer)).resolves.toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
