import type { Shot } from '../domain/types';

/** Copy authored shot content while the destination retains its fresh identity and media slots. */
export function createShotDuplicationPatch(source: Shot): Pick<
  Shot,
  'camera' | 'description' | 'landmarkIds' | 'exportSettings' | 'cameraKeyframes'
  | 'objectOverrides' | 'linkedPanoId' | 'panoCrop' | 'promptOverrides'
> {
  return structuredClone({
    camera: source.camera,
    description: source.description,
    landmarkIds: source.landmarkIds,
    exportSettings: source.exportSettings,
    cameraKeyframes: source.cameraKeyframes,
    objectOverrides: source.objectOverrides ?? {},
    linkedPanoId: source.linkedPanoId,
    panoCrop: source.panoCrop,
    promptOverrides: source.promptOverrides,
  });
}
