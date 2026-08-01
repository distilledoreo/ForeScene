/**
 * Blank-project detection for the first-project launcher.
 *
 * A project is "effectively blank" when it only contains scaffolding the app
 * creates automatically (origin capture, ground slab, light helper, default
 * origin/placeholder shot) and no user production content.
 */

import type { LocationProject, SceneObject, Shot } from './types';

/** Object types that may appear on a fresh blank stage without counting as content. */
const SCAFFOLD_OBJECT_TYPES = new Set<SceneObject['type']>(['floor', 'sun_marker']);

/**
 * True when a shot looks like the automatically created origin / Camera 001
 * placeholder rather than a real production shot.
 */
export function isPlaceholderShot(shot: Shot): boolean {
  const name = shot.name.trim().toLowerCase();
  const number = shot.shotNumber.trim();

  const originNumber = number === '000' || number === '001' || number === '0' || number === '1';
  const originName =
    name === 'origin'
    || name === 'camera 000'
    || name === 'camera 001'
    || /^camera\s*0*1$/.test(name)
    || /^camera\s*0+$/.test(name);

  if (!originNumber && !originName) return false;

  const hasStaging = shot.objectOverrides && Object.keys(shot.objectOverrides).length > 0;
  if (hasStaging) return false;

  if ((shot.cameraKeyframes?.length ?? 0) > 0) return false;
  if (shot.linkedPanoId) return false;
  if ((shot.description ?? '').trim().length > 0 && !/blank|origin|placeholder|default/i.test(shot.description)) {
    return false;
  }

  return true;
}

function hasMeaningfulObjects(objects: readonly SceneObject[]): boolean {
  return objects.some((object) => {
    if (SCAFFOLD_OBJECT_TYPES.has(object.type)) return false;
    if (object.type === 'human_dummy') return true;
    if (object.poseableCharacter) return true;
    if (object.importedModel || object.modelAssetId) return true;
    if (object.stagingRole === 'person' || object.stagingRole === 'prop') return true;
    // Any non-scaffold architecture / environment counts as set content.
    return true;
  });
}

/**
 * Returns true when the project has no meaningful production content yet.
 * Safe for the first-project launcher: default origin + floor/sun scaffolding
 * alone still count as blank.
 */
export function isEffectivelyBlankProject(project: LocationProject): boolean {
  if (project.panoRefs.length > 0) return false;

  const assetCount = Object.keys(project.assets?.assets ?? {}).length;
  if (assetCount > 0) return false;

  if (hasMeaningfulObjects(project.scene.objects)) return false;

  // More than one non-placeholder shot means the user (or automation) started a list.
  const shots = project.shots ?? [];
  if (shots.length === 0) return true;
  if (shots.some((shot) => !isPlaceholderShot(shot))) return false;
  // Only placeholder shots remain — still blank even if two were created by accident.
  return true;
}
