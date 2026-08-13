#!/usr/bin/env node
/**
 * Deterministic Gate D fixture candidate. Writes required three-shot artifacts
 * into FORESCENE_OUTPUT without calling ForeScene. This proves harness
 * collection/report isolation, not model quality.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = process.env.FORESCENE_OUTPUT;
if (!output) {
  process.stderr.write('FORESCENE_OUTPUT is required.\n');
  process.exit(1);
}

await mkdir(output, { recursive: true });
const png = Buffer.from('png');
const mp4 = Buffer.alloc(32);
mp4.write('ftyp', 4, 'ascii');
await writeFile(path.join(output, '010.png'), png);
await writeFile(path.join(output, '020.png'), png);
await writeFile(path.join(output, '030-start.png'), png);
await writeFile(path.join(output, '030-mid.png'), png);
await writeFile(path.join(output, '030-end.png'), png);
await writeFile(path.join(output, '030.mp4'), mp4);
process.stdout.write(`${JSON.stringify({ ok: true, fixture: 'reliability-gate-d' }, null, 2)}\n`);
