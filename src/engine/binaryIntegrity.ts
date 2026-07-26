/**
 * Content integrity helpers shared by recovery revisions, health checks, and
 * portable backups. Recovery resource keys are content addressed, but the
 * digest is also retained as explicit metadata on every new revision.
 */

export const PROJECT_ASSET_RESOURCE_PREFIX = 'recovery-resource/project-asset/';
export const MODEL_RESOURCE_PREFIX = 'recovery-resource/model/';

export interface BinaryIntegrityMetadata {
  key: string;
  sha256: string;
  byteLength: number;
  mimeType?: string;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A small standards-compliant fallback for non-browser test runtimes. */
function sha256Fallback(input: Uint8Array): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  // JavaScript numbers cannot safely represent all 64-bit lengths, but local
  // browser payloads are far below that practical limit.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      const s0 = rightRotate(a, 7) ^ rightRotate(a, 18) ^ (a >>> 3);
      const s1 = rightRotate(b, 17) ^ rightRotate(b, 19) ^ (b >>> 10);
      words[index] = (((words[index - 16] + s0) | 0) + ((words[index - 7] + s1) | 0)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (((((h + s1) | 0) + choice) | 0) + ((constants[index] + words[index]) | 0)) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, index) => digestView.setUint32(index * 4, value >>> 0, false));
  return hex(digest);
}

export async function sha256Digest(bytes: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }
  return sha256Fallback(new Uint8Array(bytes));
}

export async function blobSha256Digest(blob: Blob): Promise<string> {
  return sha256Digest(await blob.arrayBuffer());
}

export function digestFromRecoveryResourceKey(key: string): string | undefined {
  const projectAssetMatch = key.match(/^recovery-resource\/project-asset\/([a-f0-9]{64})\//i);
  if (projectAssetMatch) return projectAssetMatch[1].toLowerCase();
  const modelMatch = key.match(/^recovery-resource\/model\/([a-f0-9]{64})$/i);
  return modelMatch?.[1].toLowerCase();
}

export async function verifyBinaryDigest(
  bytes: ArrayBuffer,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const actual = await sha256Digest(bytes);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`${label} failed SHA-256 integrity verification.`);
  }
}
