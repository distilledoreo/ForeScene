import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = process.cwd();
const reusableRoots = [
  'src/engine/agent',
  'scripts/agent',
  'docs/agent-api.md',
  'docs/agent-playwright.md',
  'examples/refinement',
  'tests/agentRefinement.test.ts',
  'tests/proxyReplacement.test.ts',
  'e2e/agent-api.spec.ts',
  '.grok/skills/forescene-previs',
];
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.md', '.json', '.txt', '.yml', '.yaml']);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function textFiles(target: string): Promise<string[]> {
  if ((await stat(target)).isFile()) return textExtensions.has(path.extname(target).toLowerCase()) ? [target] : [];
  const info = await readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of info) {
    const absolute = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await textFiles(absolute));
    else if (textExtensions.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
  }
  return files;
}

async function denylistedTerms(): Promise<string[]> {
  const productionRoot = path.join(repositoryRoot, 'production');
  const productions = await readdir(productionRoot, { withFileTypes: true });
  const terms: string[] = [];
  for (const production of productions) {
    if (!production.isDirectory()) continue;
    const denylistPath = path.join(productionRoot, production.name, 'neutrality-denylist.json');
    try {
      const values = JSON.parse(await readFile(denylistPath, 'utf8')) as unknown;
      if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
        throw new Error('denylist must be an array of strings');
      }
      terms.push(...values);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`${denylistPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(terms.map(normalize).filter(Boolean))];
}

describe('refinement reusable-surface neutrality', () => {
  it('keeps production-specific names and asset labels out of reusable paths', async () => {
    const terms = await denylistedTerms();
    const files = (await Promise.all(reusableRoots.map((root) => textFiles(path.join(repositoryRoot, root))))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const content = normalize(await readFile(file, 'utf8'));
      for (const term of terms) if (content.includes(term)) violations.push(`${path.relative(repositoryRoot, file)} contains "${term}"`);
    }
    expect(violations).toEqual([]);
  });
});
