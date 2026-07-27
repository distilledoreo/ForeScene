import { LocationProject } from '../domain/types';

/**
 * Asset registry entries are owned by one of three project surfaces: imported
 * scene geometry, panorama references, or a shot media slot. Keeping this
 * list central prevents replacement flows from accumulating unreachable data
 * URLs in saved projects.
 */
export function getReferencedProjectAssetIds(project: LocationProject): Set<string> {
  const referenced = new Set<string>();

  for (const object of project.scene.objects) {
    if (object.modelAssetId) referenced.add(object.modelAssetId);
  }
  for (const pano of project.panoRefs) {
    referenced.add(pano.imageAssetId);
  }
  for (const shot of project.shots) {
    for (const assetId of Object.values(shot.assets)) {
      if (assetId) referenced.add(assetId);
    }
    for (const keyframe of shot.cameraKeyframes ?? []) {
      if (keyframe.previewAssetId) referenced.add(keyframe.previewAssetId);
    }
  }

  return referenced;
}

/** Return the original project when every registered asset is still reachable. */
export function pruneUnreferencedProjectAssets(project: LocationProject): LocationProject {
  const referenced = getReferencedProjectAssetIds(project);
  const entries = Object.entries(project.assets.assets);
  if (entries.every(([assetId]) => referenced.has(assetId))) return project;

  return {
    ...project,
    assets: {
      ...project.assets,
      assets: Object.fromEntries(entries.filter(([assetId]) => referenced.has(assetId))),
    },
  };
}
