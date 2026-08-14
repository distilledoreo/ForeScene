/**
 * Minimal 8-bit PNG encode/decode for harness-side pixel sampling.
 * Supports filter types 0–4 and color types 0, 2, 4, and 6. Interlace is rejected.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface DecodedRgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function bytesPerPixel(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`Unsupported PNG color type ${colorType}.`);
}

function expandToRgba(
  row: Uint8Array,
  colorType: number,
  width: number,
): Uint8Array {
  const rgba = new Uint8Array(width * 4);
  for (let x = 0; x < width; x += 1) {
    const out = x * 4;
    if (colorType === 6) {
      const i = x * 4;
      rgba[out] = row[i]!;
      rgba[out + 1] = row[i + 1]!;
      rgba[out + 2] = row[i + 2]!;
      rgba[out + 3] = row[i + 3]!;
    } else if (colorType === 2) {
      const i = x * 3;
      rgba[out] = row[i]!;
      rgba[out + 1] = row[i + 1]!;
      rgba[out + 2] = row[i + 2]!;
      rgba[out + 3] = 255;
    } else if (colorType === 4) {
      const i = x * 2;
      rgba[out] = row[i]!;
      rgba[out + 1] = row[i]!;
      rgba[out + 2] = row[i]!;
      rgba[out + 3] = row[i + 1]!;
    } else {
      rgba[out] = row[x]!;
      rgba[out + 1] = row[x]!;
      rgba[out + 2] = row[x]!;
      rgba[out + 3] = 255;
    }
  }
  return rgba;
}

function reconstructRow(
  filtered: Uint8Array,
  previous: Uint8Array,
  filter: number,
  bpp: number,
): Uint8Array {
  const row = new Uint8Array(filtered.length);
  for (let i = 0; i < filtered.length; i += 1) {
    const raw = filtered[i]!;
    const left = i >= bpp ? row[i - bpp]! : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
    let value = raw;
    if (filter === 1) value = raw + left;
    else if (filter === 2) value = raw + up;
    else if (filter === 3) value = raw + Math.floor((left + up) / 2);
    else if (filter === 4) value = raw + paeth(left, up, upLeft);
    else if (filter !== 0) throw new Error(`Unsupported PNG filter type ${filter}.`);
    row[i] = value & 0xff;
  }
  return row;
}

export function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

export function decodePngRgba(bytes: Uint8Array): DecodedRgbaImage {
  if (!looksLikePng(bytes)) throw new Error('Not a PNG file.');
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];

  while (offset + 12 <= bytes.byteLength) {
    const length = (bytes[offset]! << 24 | bytes[offset + 1]! << 16 | bytes[offset + 2]! << 8 | bytes[offset + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.byteLength) throw new Error('Truncated PNG chunk.');
    const chunk = bytes.subarray(offset + 4, dataEnd);
    const expectedCrc = (
      bytes[dataEnd]! << 24
      | bytes[dataEnd + 1]! << 16
      | bytes[dataEnd + 2]! << 8
      | bytes[dataEnd + 3]!
    ) >>> 0;
    if (crc32(chunk) !== expectedCrc) throw new Error(`PNG ${type} chunk CRC mismatch.`);
    if (type === 'IHDR') {
      if (length < 13) throw new Error('Invalid PNG IHDR.');
      width = (bytes[dataStart]! << 24 | bytes[dataStart + 1]! << 16 | bytes[dataStart + 2]! << 8 | bytes[dataStart + 3]!) >>> 0;
      height = (bytes[dataStart + 4]! << 24 | bytes[dataStart + 5]! << 16 | bytes[dataStart + 6]! << 8 | bytes[dataStart + 7]!) >>> 0;
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0) {
        throw new Error('Only non-interlaced deflate PNGs are supported.');
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(bytes.subarray(dataStart, dataEnd)));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8) {
    throw new Error(`Unsupported PNG geometry ${width}x${height} bitDepth=${bitDepth}.`);
  }
  const bpp = bytesPerPixel(colorType);
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (inflated.byteLength < expected) throw new Error('PNG IDAT is shorter than IHDR claims.');

  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[cursor]!;
    const filtered = inflated.subarray(cursor + 1, cursor + 1 + stride);
    cursor += stride + 1;
    const reconstructed = reconstructRow(filtered, previous, filter, bpp);
    previous = reconstructed;
    const row = expandToRgba(reconstructed, colorType, width);
    rgba.set(row, y * width * 4);
  }
  return { width, height, data: rgba };
}

function writeChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.byteLength, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([header, payload, crc]);
}

export function encodePngRgba(image: DecodedRgbaImage): Buffer {
  const { width, height, data } = image;
  if (data.byteLength !== width * height * 4) throw new Error('RGBA buffer size does not match width/height.');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    scanlines.set(data.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', deflateSync(scanlines)),
    writeChunk('IEND', new Uint8Array(0)),
  ]);
}
