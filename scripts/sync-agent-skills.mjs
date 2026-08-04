import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRoot = path.join(repoRoot, 'skills', 'forescene-previs');
const adapterRoots = [
  path.join(repoRoot, '.grok', 'skills', 'forescene-previs'),
  path.join(repoRoot, '.claude', 'skills', 'forescene-previs'),
  path.join(repoRoot, '.kilo', 'skills', 'forescene-previs'),
];

for (const adapterRoot of adapterRoots) {
  await rm(adapterRoot, { recursive: true, force: true });
  await mkdir(path.dirname(adapterRoot), { recursive: true });
  await cp(canonicalRoot, adapterRoot, { recursive: true });
}

console.log(JSON.stringify({ canonicalRoot, adapters: adapterRoots, status: 'synced' }, null, 2));
