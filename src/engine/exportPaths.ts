/**
 * Path helpers for both export package layouts.
 *
 * Legacy-v1 paths remain inline template strings at their existing call sites
 * (unchanged, per compatibility requirements). This module owns every path
 * used by the forescene-v2 writer/planner, plus the shared collision-safe
 * folder assignment for shared panoramas, so both the plan and the writer
 * agree on where things live without inventing ad-hoc strings.
 */

import { sanitizeExportSegment } from './exportNaming';

/** Sanitize a descriptive name into a safe package folder segment. */
export function sanitizePackageFolderSegment(value: string): string {
  return sanitizeExportSegment(value);
}

export interface SharedFolderKey {
  id: string;
  label: string;
}

/**
 * Assign unique, collision-safe folder names for shared panorama sources.
 * Colliding sanitized labels receive numeric suffixes: `_2`, `_3`, etc.
 */
export function assignSharedPanoramaFolders(keys: SharedFolderKey[]): Map<string, string> {
  const used = new Map<string, number>();
  const result = new Map<string, string>();
  for (const key of keys) {
    const base = sanitizePackageFolderSegment(key.label) || 'panorama';
    const collisionKey = base.toLocaleLowerCase();
    const seen = used.get(collisionKey) ?? 0;
    used.set(collisionKey, seen + 1);
    const folder = seen === 0 ? base : `${base}_${seen + 1}`;
    result.set(key.id, folder);
  }
  return result;
}

export const V2_ROOT_MANIFEST_PATH = 'manifest.json';
export const V2_START_HERE_PATH = 'START_HERE.html';

export function v2ShotRoot(shotFolder: string): string {
  return `shots/${shotFolder}`;
}

export function v2Generation(shotFolder: string): string {
  return `${v2ShotRoot(shotFolder)}/generation`;
}

export function v2Motion(shotFolder: string): string {
  return `${v2Generation(shotFolder)}/motion`;
}

export function v2CameraMove(shotFolder: string): string {
  return `${v2Generation(shotFolder)}/camera_move`;
}

export function v2Characters(shotFolder: string): string {
  return `${v2Generation(shotFolder)}/characters`;
}

export function v2Prompts(shotFolder: string): string {
  return `${v2ShotRoot(shotFolder)}/prompts`;
}

export function v2Technical(shotFolder: string): string {
  return `${v2ShotRoot(shotFolder)}/technical`;
}

export function v2ShotManifest(shotFolder: string): string {
  return `${v2ShotRoot(shotFolder)}/manifest.json`;
}

export function v2SharedPanoramaDir(folder: string): string {
  return `shared_references/panoramas/${folder}`;
}

export function v2SharedPanoramaPng(folder: string): string {
  return `${v2SharedPanoramaDir(folder)}/panorama.png`;
}

export function v2SharedGrayboxPng(folder: string): string {
  return `${v2SharedPanoramaDir(folder)}/graybox.png`;
}

export function v2SharedCubemapDir(folder: string): string {
  return `${v2SharedPanoramaDir(folder)}/cubemap`;
}

export function v2SharedCubemapFace(folder: string, face: string): string {
  return `${v2SharedCubemapDir(folder)}/${face}.png`;
}

export function v2SharedCubemapStitched(folder: string): string {
  return `${v2SharedCubemapDir(folder)}/cubemap_stitched.png`;
}

/** Parse the shared panorama folder segment out of a `shared_references/panoramas/<folder>/...` path. */
export function parseSharedPanoramaFolder(path: string): string | undefined {
  const match = /^shared_references\/panoramas\/([^/]+)\//.exec(path);
  return match?.[1];
}

export interface V2ShotPaths {
  root: string;
  generation: string;
  motion: string;
  cameraMove: string;
  characters: string;
  prompts: string;
  technical: string;
  manifest: string;
}

/** One shot's full set of v2 archive directories, derived from its base folder name. */
export function createV2ShotPaths(shotFolder: string): V2ShotPaths {
  return {
    root: v2ShotRoot(shotFolder),
    generation: v2Generation(shotFolder),
    motion: v2Motion(shotFolder),
    cameraMove: v2CameraMove(shotFolder),
    characters: v2Characters(shotFolder),
    prompts: v2Prompts(shotFolder),
    technical: v2Technical(shotFolder),
    manifest: v2ShotManifest(shotFolder),
  };
}

/**
 * Remap a legacy-v1 shot-scoped path (e.g. `${rootFolder}/inputs/viewport_clay.png`)
 * into the equivalent forescene-v2 archive path. Both the planner and the writer call
 * this so per-shot paths can never drift between the plan and the ZIP.
 */
export function remapLegacyShotPathToV2(rootFolder: string, legacyPath: string): string {
  const prefix = `${rootFolder}/`;
  const rest = legacyPath.startsWith(prefix) ? legacyPath.slice(prefix.length) : legacyPath;
  const shot = createV2ShotPaths(rootFolder);

  if (rest === 'manifest.json') return shot.manifest;
  if (rest.startsWith('metadata/')) return `${shot.technical}/${rest.slice('metadata/'.length)}`;
  if (rest.startsWith('outputs/')) return `${shot.generation}/${rest.slice('outputs/'.length)}`;
  if (rest.startsWith('prompts/')) return `${shot.prompts}/${rest.slice('prompts/'.length)}`;
  if (rest.startsWith('inputs/camera_move/')) {
    return `${shot.cameraMove}/${rest.slice('inputs/camera_move/'.length)}`;
  }
  if (rest.startsWith('inputs/characters/')) {
    return `${shot.characters}/${rest.slice('inputs/characters/'.length)}`;
  }
  if (rest.startsWith('inputs/cubemap/')) {
    return `${shot.generation}/cubemap/${rest.slice('inputs/cubemap/'.length)}`;
  }
  if (/^inputs\/viewport_(clay|projected|depth)_motion\.mp4$/.test(rest)) {
    return `${shot.motion}/${rest.slice('inputs/'.length)}`;
  }
  if (rest.startsWith('inputs/')) return `${shot.generation}/${rest.slice('inputs/'.length)}`;
  return `${shot.root}/${rest}`;
}
