/**
 * Blank-project detection for the first-project launcher.
 *
 * A project is "effectively blank" when it only contains items explicitly tagged
 * as intact system scaffolding (origin floor/light/shot). Fuzzy name/number
 * heuristics are not the sole gate.
 */

import type { LocationProject } from './types';
import {
  isIntactSystemScaffoldObject,
  isIntactSystemScaffoldShot,
} from './scaffold';

/**
 * @deprecated Prefer scaffold tags. Kept for tests that assert placeholder naming
 * is no longer sufficient alone; returns true only when the shot is an intact
 * system-scaffold origin shot.
 */
export function isPlaceholderShot(shot: LocationProject['shots'][number]): boolean {
  return isIntactSystemScaffoldShot(shot);
}

/**
 * Returns true when the project has no meaningful production content yet.
 * Only intact `systemScaffold` objects/shots are ignored; any untagged content,
 * modified scaffold, pano, or asset makes the project non-blank.
 */
export function isEffectivelyBlankProject(project: LocationProject): boolean {
  if (project.panoRefs.length > 0) return false;

  const assetCount = Object.keys(project.assets?.assets ?? {}).length;
  if (assetCount > 0) return false;

  const objects = project.scene.objects ?? [];
  if (objects.some((object) => !isIntactSystemScaffoldObject(object))) return false;

  const shots = project.shots ?? [];
  if (shots.some((shot) => !isIntactSystemScaffoldShot(shot))) return false;

  return true;
}
