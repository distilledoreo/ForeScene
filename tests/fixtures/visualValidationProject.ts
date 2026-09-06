import { readFileSync } from 'node:fs';
import {
  createDefaultProject, createPanoAsset, createPanoReference, createSceneObject, createShot,
} from '../../src/domain/defaults';

/** Offline input fixture; browser tests author corrections only through the CLI. */
export function visualValidationProject() {
  const project = createDefaultProject();
  const floor = createSceneObject('floor', 1, [0, -0.05, 0]);
  floor.dimensions = [20, 0.1, 20];
  const subject = createSceneObject('box', 1, [0, 0.5, 0]);
  subject.id = 'validation-subject';
  subject.name = 'Required crate';
  subject.dimensions = [2, 1, 1];
  subject.stagingRole = 'prop';
  const dressing = createSceneObject('terrain_mass', 1, [12, 0.2, 0]);
  dressing.id = 'validation-dressing';
  dressing.name = 'Distant rubble';
  dressing.dimensions = [1, 0.4, 1];
  const wall = createSceneObject('wall', 1, [0, 1.5, 3]);
  wall.id = 'validation-wall';
  wall.dimensions = [4, 3, 0.2];
  const shot = createShot({ index: 1, camera: {
    position: [0, 2, 6], target: [0, 0.5, 0], fovDegrees: 45,
    aspectRatio: 16 / 9, near: 0.1, far: 100,
  } });
  shot.id = 'validation-shot';
  shot.shotNumber = '01';
  const png = readFileSync(new URL('./cli-parity-pano.png', import.meta.url));
  const asset = createPanoAsset({ name: 'Validation panorama',
    uri: `data:image/png;base64,${png.toString('base64')}`, width: 2048, height: 1024 });
  const pano = createPanoReference({ name: asset.name, assetId: asset.id,
    type: 'external_reference', origin: [0, 1.6, 0], width: 2048, height: 1024, isCanonical: true });
  shot.linkedPanoId = pano.id;
  project.scene.objects = [floor, subject, dressing, wall];
  project.scene.objectGroups = {};
  project.shots = [shot];
  project.panoRefs = [pano];
  project.landmarks = [];
  project.assets = { assets: { [asset.id]: asset } };
  return { project, shot, subject, dressing, wall, floor };
}
