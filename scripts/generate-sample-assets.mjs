/**
 * Generate distinctive Dialogue Demo visual assets (PNG) and embed them as
 * base64 data URIs in src/samples/dialogueDemoAssets.ts.
 *
 * Run: npm run sample:generate
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'src', 'samples', 'assets');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcB]);
}

function encodePng(width, height, rgba) {
  // rgba: Uint8Array length width*height*4 → convert to RGB filter0 scanlines
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (width * 3 + 1) + 1 + x * 3;
      raw[di] = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(rgba, w, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= w) return;
  const h = rgba.length / (w * 4);
  if (y >= h) return;
  const i = (y * w + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

function fillRect(rgba, w, x0, y0, x1, y1, r, g, b) {
  const h = rgba.length / (w * 4);
  const xa = Math.max(0, Math.floor(Math.min(x0, x1)));
  const xb = Math.min(w - 1, Math.floor(Math.max(x0, x1)));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1)));
  const yb = Math.min(h - 1, Math.floor(Math.max(y0, y1)));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) setPixel(rgba, w, x, y, r, g, b);
  }
}

function fillCircle(rgba, w, cx, cy, radius, r, g, b) {
  const h = rgba.length / (w * 4);
  const r2 = radius * radius;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(rgba, w, x, y, r, g, b);
    }
  }
}

/** Equirectangular-ish interior: floor band, walls, two figures, table. */
function paintEquirectRoom(rgba, w, h, style) {
  const isGray = style === 'graybox';
  // Sky / upper walls
  const wallTop = isGray ? [168, 172, 178] : [92, 118, 148];
  const wallMid = isGray ? [148, 152, 158] : [120, 88, 72];
  const wallLow = isGray ? [132, 136, 142] : [78, 58, 48];
  const floorCol = isGray ? [110, 114, 120] : [156, 124, 88];
  const floorDark = isGray ? [96, 100, 106] : [128, 96, 64];
  const ceiling = isGray ? [190, 194, 200] : [240, 228, 210];
  const tableCol = isGray ? [90, 92, 96] : [110, 78, 52];
  const alex = isGray ? [96, 130, 180] : [70, 150, 230];
  const blair = isGray ? [180, 110, 140] : [240, 110, 170];

  // Ceiling band (top 22%)
  fillRect(rgba, w, 0, 0, w, h * 0.22, ...ceiling);
  // Upper wall
  fillRect(rgba, w, 0, h * 0.22, w, h * 0.42, ...wallTop);
  // Mid wall with warmer/cooler split (styled has wood left / paint right)
  fillRect(rgba, w, 0, h * 0.42, w, h * 0.58, ...wallMid);
  if (!isGray) {
    fillRect(rgba, w, 0, h * 0.42, w * 0.35, h * 0.58, 140, 96, 70);
    fillRect(rgba, w, w * 0.65, h * 0.42, w, h * 0.58, 100, 130, 150);
  }
  // Lower wall
  fillRect(rgba, w, 0, h * 0.58, w, h * 0.68, ...wallLow);
  // Floor
  fillRect(rgba, w, 0, h * 0.68, w, h, ...floorCol);
  // Floor checker / boards for identity
  for (let i = 0; i < 16; i++) {
    const x0 = (i / 16) * w;
    const x1 = ((i + 1) / 16) * w;
    if (i % 2 === 0) fillRect(rgba, w, x0, h * 0.68, x1, h, ...floorDark);
  }

  // Doorway center-back
  const doorX = w * 0.48;
  fillRect(rgba, w, doorX - w * 0.04, h * 0.32, doorX + w * 0.04, h * 0.68, isGray ? 70 : 40, isGray ? 74 : 32, isGray ? 80 : 28);

  // Table center
  fillRect(rgba, w, w * 0.42, h * 0.58, w * 0.58, h * 0.66, ...tableCol);
  fillRect(rgba, w, w * 0.44, h * 0.66, w * 0.46, h * 0.72, ...tableCol);
  fillRect(rgba, w, w * 0.54, h * 0.66, w * 0.56, h * 0.72, ...tableCol);

  // Alex (left figure)
  fillCircle(rgba, w, w * 0.36, h * 0.46, h * 0.035, ...alex);
  fillRect(rgba, w, w * 0.34, h * 0.49, w * 0.38, h * 0.66, ...alex);
  // Blair (right figure)
  fillCircle(rgba, w, w * 0.64, h * 0.45, h * 0.032, ...blair);
  fillRect(rgba, w, w * 0.62, h * 0.48, w * 0.66, h * 0.65, ...blair);

  // Horizon label strip for human recognition
  if (isGray) {
    // Clay edge highlight
    fillRect(rgba, w, 0, h * 0.675, w, h * 0.685, 200, 204, 210);
  } else {
    // Warm light streak
    fillRect(rgba, w, w * 0.1, h * 0.28, w * 0.9, h * 0.30, 255, 210, 140);
  }
}

function paintShotThumbnail(rgba, w, h, kind) {
  // Shared room background tint
  fillRect(rgba, w, 0, 0, w, h * 0.55, 150, 154, 160);
  fillRect(rgba, w, 0, h * 0.55, w, h, 115, 118, 124);
  const alex = [70, 150, 230];
  const blair = [240, 110, 170];
  const table = [110, 78, 52];

  if (kind === 'wide') {
    fillRect(rgba, w, w * 0.35, h * 0.55, w * 0.65, h * 0.68, ...table);
    fillCircle(rgba, w, w * 0.32, h * 0.42, h * 0.08, ...alex);
    fillRect(rgba, w, w * 0.27, h * 0.48, w * 0.37, h * 0.75, ...alex);
    fillCircle(rgba, w, w * 0.68, h * 0.41, h * 0.075, ...blair);
    fillRect(rgba, w, w * 0.63, h * 0.47, w * 0.73, h * 0.74, ...blair);
  } else if (kind === 'medium') {
    fillCircle(rgba, w, w * 0.45, h * 0.28, h * 0.12, ...alex);
    fillRect(rgba, w, w * 0.35, h * 0.38, w * 0.55, h * 0.95, ...alex);
    fillCircle(rgba, w, w * 0.78, h * 0.4, h * 0.06, ...blair);
  } else if (kind === 'ots') {
    // Blair shoulder foreground dark
    fillRect(rgba, w, 0, h * 0.35, w * 0.38, h, 50, 40, 55);
    fillCircle(rgba, w, w * 0.62, h * 0.32, h * 0.1, ...alex);
    fillRect(rgba, w, w * 0.52, h * 0.4, w * 0.72, h * 0.95, ...alex);
  } else {
    // close-up Alex
    fillCircle(rgba, w, w * 0.5, h * 0.38, h * 0.22, ...alex);
    fillRect(rgba, w, w * 0.28, h * 0.55, w * 0.72, h, ...alex);
    // eye dots
    fillCircle(rgba, w, w * 0.42, h * 0.36, h * 0.03, 20, 30, 40);
    fillCircle(rgba, w, w * 0.58, h * 0.36, h * 0.03, 20, 30, 40);
  }

  // Distinct border tint per kind
  const borders = {
    wide: [40, 120, 200],
    medium: [40, 180, 120],
    ots: [200, 120, 40],
    cu: [200, 60, 100],
  };
  const [br, bg, bb] = borders[kind] ?? [255, 255, 255];
  fillRect(rgba, w, 0, 0, w, 6, br, bg, bb);
  fillRect(rgba, w, 0, h - 6, w, h, br, bg, bb);
}

function paintContactSheet(rgba, w, h) {
  fillRect(rgba, w, 0, 0, w, h, 30, 32, 38);
  const labels = ['wide', 'medium', 'ots', 'cu'];
  const cellW = Math.floor(w / 2) - 16;
  const cellH = Math.floor(h / 2) - 28;
  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x0 = 12 + col * (cellW + 12);
    const y0 = 24 + row * (cellH + 16);
    const cell = new Uint8Array(cellW * cellH * 4);
    paintShotThumbnail(cell, cellW, cellH, labels[i]);
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const si = (y * cellW + x) * 4;
        setPixel(rgba, w, x0 + x, y0 + y, cell[si], cell[si + 1], cell[si + 2]);
      }
    }
  }
  // Title bar
  fillRect(rgba, w, 0, 0, w, 18, 50, 54, 64);
}

function make(w, h, painter) {
  const rgba = new Uint8Array(w * h * 4);
  // default opaque black
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i + 3] = 255;
  }
  painter(rgba, w, h);
  return encodePng(w, h, rgba);
}

mkdirSync(assetsDir, { recursive: true });

const assets = {
  grayboxPano: {
    file: 'graybox-panorama.png',
    width: 1024,
    height: 512,
    role: 'graybox-panorama',
    png: make(1024, 512, (rgba, w, h) => paintEquirectRoom(rgba, w, h, 'graybox')),
  },
  styledPano: {
    file: 'styled-panorama.png',
    width: 1024,
    height: 512,
    role: 'styled-panorama',
    png: make(1024, 512, (rgba, w, h) => paintEquirectRoom(rgba, w, h, 'styled')),
  },
  contactSheet: {
    file: 'contact-sheet.png',
    width: 1280,
    height: 720,
    role: 'contact-sheet',
    png: make(1280, 720, (rgba, w, h) => paintContactSheet(rgba, w, h)),
  },
  shotWide: {
    file: 'shot-010-wide.png',
    width: 640,
    height: 360,
    role: 'shot-thumbnail',
    shotNumber: '010',
    png: make(640, 360, (rgba, w, h) => paintShotThumbnail(rgba, w, h, 'wide')),
  },
  shotMedium: {
    file: 'shot-020-medium.png',
    width: 640,
    height: 360,
    role: 'shot-thumbnail',
    shotNumber: '020',
    png: make(640, 360, (rgba, w, h) => paintShotThumbnail(rgba, w, h, 'medium')),
  },
  shotOts: {
    file: 'shot-030-ots.png',
    width: 640,
    height: 360,
    role: 'shot-thumbnail',
    shotNumber: '030',
    png: make(640, 360, (rgba, w, h) => paintShotThumbnail(rgba, w, h, 'ots')),
  },
  shotCu: {
    file: 'shot-040-cu.png',
    width: 640,
    height: 360,
    role: 'shot-thumbnail',
    shotNumber: '040',
    png: make(640, 360, (rgba, w, h) => paintShotThumbnail(rgba, w, h, 'cu')),
  },
};

const entries = [];
for (const [key, asset] of Object.entries(assets)) {
  const path = join(assetsDir, asset.file);
  writeFileSync(path, asset.png);
  const dataUri = `data:image/png;base64,${asset.png.toString('base64')}`;
  entries.push({ key, ...asset, dataUri, bytes: asset.png.length });
  console.log(`wrote ${asset.file} (${asset.png.length} bytes)`);
}

// Ensure graybox ≠ styled
const grayB64 = assets.grayboxPano.png.toString('base64');
const styledB64 = assets.styledPano.png.toString('base64');
if (grayB64 === styledB64) {
  throw new Error('graybox and styled panos must differ');
}
const shotUris = [assets.shotWide, assets.shotMedium, assets.shotOts, assets.shotCu]
  .map((a) => a.png.toString('base64'));
if (new Set(shotUris).size !== 4) {
  throw new Error('shot thumbnails must all be distinct');
}

const ts = `/**
 * Auto-generated Dialogue Demo visual assets.
 * Do not edit by hand — run: npm run sample:generate
 */
export interface SampleVisualAsset {
  role: string;
  width: number;
  height: number;
  mimeType: 'image/png';
  dataUri: string;
  shotNumber?: string;
}

export const DIALOGUE_DEMO_ASSETS = {
  grayboxPano: {
    role: 'graybox-panorama',
    width: 1024,
    height: 512,
    mimeType: 'image/png' as const,
    dataUri: ${JSON.stringify(assets.grayboxPano.png.toString('base64').length > 0 ? `data:image/png;base64,${assets.grayboxPano.png.toString('base64')}` : '')},
  },
  styledPano: {
    role: 'styled-panorama',
    width: 1024,
    height: 512,
    mimeType: 'image/png' as const,
    dataUri: ${JSON.stringify(`data:image/png;base64,${assets.styledPano.png.toString('base64')}`)},
  },
  contactSheet: {
    role: 'contact-sheet',
    width: 1280,
    height: 720,
    mimeType: 'image/png' as const,
    dataUri: ${JSON.stringify(`data:image/png;base64,${assets.contactSheet.png.toString('base64')}`)},
  },
  shotThumbnails: {
    '010': {
      role: 'shot-thumbnail',
      width: 640,
      height: 360,
      mimeType: 'image/png' as const,
      dataUri: ${JSON.stringify(`data:image/png;base64,${assets.shotWide.png.toString('base64')}`)},
      shotNumber: '010',
    },
    '020': {
      role: 'shot-thumbnail',
      width: 640,
      height: 360,
      mimeType: 'image/png' as const,
      dataUri: ${JSON.stringify(`data:image/png;base64,${assets.shotMedium.png.toString('base64')}`)},
      shotNumber: '020',
    },
    '030': {
      role: 'shot-thumbnail',
      width: 640,
      height: 360,
      mimeType: 'image/png' as const,
      dataUri: ${JSON.stringify(`data:image/png;base64,${assets.shotOts.png.toString('base64')}`)},
      shotNumber: '030',
    },
    '040': {
      role: 'shot-thumbnail',
      width: 640,
      height: 360,
      mimeType: 'image/png' as const,
      dataUri: ${JSON.stringify(`data:image/png;base64,${assets.shotCu.png.toString('base64')}`)},
      shotNumber: '040',
    },
  },
} as const satisfies {
  grayboxPano: SampleVisualAsset;
  styledPano: SampleVisualAsset;
  contactSheet: SampleVisualAsset;
  shotThumbnails: Record<string, SampleVisualAsset>;
};
`;

writeFileSync(join(root, 'src', 'samples', 'dialogueDemoAssets.ts'), ts);
console.log('wrote src/samples/dialogueDemoAssets.ts');
console.log('done');
