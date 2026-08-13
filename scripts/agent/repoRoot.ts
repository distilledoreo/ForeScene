/**
 * Canonical ForeScene checkout root. Benchmarks and candidates may run with a
 * cwd outside this repo; documented `npm run agent:*` commands must still
 * resolve here via FORESCENE_REPO_ROOT or npm --prefix.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function isForeScenePackageRoot(candidate: string): boolean {
  const packagePath = path.join(candidate, 'package.json');
  if (!existsSync(packagePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string };
    return parsed.name === 'forescene';
  } catch {
    return false;
  }
}

export function resolveForeSceneRepoRoot(explicit?: string): string {
  const configured = explicit ?? process.env.FORESCENE_REPO_ROOT;
  if (configured) {
    const resolved = path.resolve(configured);
    if (!isForeScenePackageRoot(resolved)) {
      throw new Error(
        `FORESCENE_REPO_ROOT (${resolved}) is not a ForeScene checkout (package.json name must be "forescene").`,
      );
    }
    return resolved;
  }
  if (isForeScenePackageRoot(process.cwd())) return path.resolve(process.cwd());
  return MODULE_REPO_ROOT;
}

export const REPO_ROOT = resolveForeSceneRepoRoot();
