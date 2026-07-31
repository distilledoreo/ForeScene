/**
 * Blank graybox project factory for autonomous previs resets.
 * Unlike createDefaultProject(), this starts empty — no temple starter set.
 */

import type { LocationProject, Vec3 } from '../../domain/types';
import {
  createCameraData,
  createDefaultExportConfiguration,
  createLandmark,
  createOriginShot,
  createSceneObject,
  DEFAULT_CAMERA_HEIGHT_METERS,
  defaultProjectSettings,
  defaultProjectWorkflow,
} from '../../domain/defaults';
import { createId } from '../../utils/ids';
import type { PrevisAspectRatio } from './manifest';
import { aspectRatioValue } from './manifest';

export interface BlankGrayboxProjectOptions {
  name: string;
  description?: string;
  aspectRatio?: PrevisAspectRatio;
  frameRate?: number;
}

/**
 * Create a minimal agent-owned project: ground slab + sun + one origin shot.
 * Locations/cast/shots from the production manifest replace this shell.
 */
export function createBlankGrayboxProject(
  options: BlankGrayboxProjectOptions,
): LocationProject {
  const now = new Date().toISOString();
  const floor = createSceneObject('floor', 1);
  floor.name = 'Ground Slab';
  floor.locked = true;
  floor.dimensions = [20, 0.08, 20];
  floor.transform.position = [0, -0.04, 0];

  const sun = createSceneObject('sun_marker', 1);
  sun.name = 'Key Light';
  sun.transform.position = [4, 6, -3];

  const settings = {
    ...defaultProjectSettings,
    ...(options.frameRate !== undefined
      ? { /* frameRate reserved on settings in a later milestone */ }
      : {}),
  };

  const aspect = aspectRatioValue(options.aspectRatio ?? '16:9');
  const camera = createCameraData(
    [0, DEFAULT_CAMERA_HEIGHT_METERS, 6],
    [0, 1.2, 0],
    settings.defaultShotFovDegrees,
  );
  camera.aspectRatio = aspect;

  const scene = {
    worldUp: 'Y' as const,
    objects: [floor, sun],
    panoOrigin: [0, DEFAULT_CAMERA_HEIGHT_METERS, 0] as Vec3,
    panoRotation: [0, 0, 0] as Vec3,
  };

  const exportConfiguration = createDefaultExportConfiguration();
  const origin = createOriginShot({ scene, settings, exportConfiguration });
  origin.camera = camera;
  origin.name = 'Origin';
  origin.description = 'Blank graybox origin shot — replaced by previs shot list.';
  origin.shotNumber = '000';

  const center = createLandmark(1, [0, 1.2, 0]);
  center.name = 'world_center';
  center.displayName = 'World Center';
  center.description = 'Origin of the blank graybox stage.';

  return {
    schemaVersion: '1.0',
    productVersion: '0.1.0',
    id: createId('project'),
    name: options.name.trim() || 'Previs Project',
    description: options.description?.trim() ?? '',
    units: 'meters',
    createdAt: now,
    updatedAt: now,
    scene,
    panoRefs: [],
    landmarks: [center],
    shots: [origin],
    assets: { assets: {} },
    settings,
    workflow: { ...defaultProjectWorkflow },
    exportConfiguration,
  };
}
