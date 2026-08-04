import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRoot = path.join(repoRoot, 'skills', 'forescene-previs');
const adapterRoots = ['.grok', '.claude', '.kilo'].map((harnessRoot) => path.join(repoRoot, harnessRoot, 'skills', 'forescene-previs'));

function listFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    return entry.isDirectory() ? listFiles(root, absolute) : [path.relative(root, absolute)];
  }).sort();
}

describe('canonical ForeScene skill distribution', () => {
  it('keeps every harness adapter byte-identical to the canonical skill tree', () => {
    const canonicalFiles = listFiles(canonicalRoot);
    expect(canonicalFiles.length).toBeGreaterThan(0);
    for (const adapterRoot of adapterRoots) {
      expect(existsSync(adapterRoot), `missing adapter: ${path.relative(repoRoot, adapterRoot)}`).toBe(true);
      expect(listFiles(adapterRoot)).toEqual(canonicalFiles);
      for (const relative of canonicalFiles) {
        expect(readFileSync(path.join(adapterRoot, relative))).toEqual(readFileSync(path.join(canonicalRoot, relative)));
      }
    }
  });

  it('keeps the canonical skill harness-neutral and documents rapid-previs', () => {
    const skill = readFileSync(path.join(canonicalRoot, 'SKILL.md'), 'utf8');
    expect(skill).toContain('rapid-previs');
    expect(skill).toContain('production-integrity');
    expect(skill).toContain('6–8 shots');
    expect(skill).toContain('three-part canary');
    expect(skill).not.toContain('Grok Build');
    expect(skill).not.toContain('.grok/');
    expect(statSync(path.join(canonicalRoot, 'references', 'rapid-previs.md')).isFile()).toBe(true);
    expect(statSync(path.join(canonicalRoot, 'references', 'production-integrity.md')).isFile()).toBe(true);
  });
});
