import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRoot = path.join(repoRoot, 'skills', 'forescene-previs');
const adapterRoots = [
  path.join(repoRoot, '.grok', 'skills', 'forescene-previs'),
  path.join(repoRoot, '.claude', 'skills', 'forescene-previs'),
  path.join(repoRoot, '.kilo', 'skills', 'forescene-previs'),
];

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, absolute));
    else files.push(path.relative(root, absolute));
  }
  return files.sort();
}

const canonicalFiles = await filesUnder(canonicalRoot);
const mismatches = [];
for (const adapterRoot of adapterRoots) {
  const adapterFiles = await filesUnder(adapterRoot).catch(() => []);
  const adapterLabel = path.relative(repoRoot, adapterRoot);
  if (JSON.stringify(adapterFiles) !== JSON.stringify(canonicalFiles)) {
    mismatches.push(`${adapterLabel}: file set differs`);
    continue;
  }
  for (const relative of canonicalFiles) {
    const [canonical, adapter] = await Promise.all([
      readFile(path.join(canonicalRoot, relative)),
      readFile(path.join(adapterRoot, relative)),
    ]);
    if (!canonical.equals(adapter)) mismatches.push(`${adapterLabel}/${relative}: content differs`);
  }
}

const result = {
  canonicalRoot: path.relative(repoRoot, canonicalRoot),
  adapters: adapterRoots.map((root) => path.relative(repoRoot, root)),
  fileCount: canonicalFiles.length,
  status: mismatches.length === 0 ? 'verified' : 'drifted',
  mismatches,
};
console.log(JSON.stringify(result, null, 2));
if (mismatches.length > 0) process.exitCode = 1;
