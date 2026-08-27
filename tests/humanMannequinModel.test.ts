import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  HUMAN_MANNEQUIN_REFERENCE_DIMENSIONS,
  ensureHumanMannequinForProject,
  ensureHumanMannequinModel,
  isHumanMannequinModelReady,
  projectHasVisibleHumanMannequin,
  resetHumanMannequinModelForTests,
} from '../src/engine/humanMannequinModel';
import { createObject3D } from '../src/engine/sceneObjects';

const modelBuffer = readFileSync(new URL('../public/models/human-mannequin.glb', import.meta.url)).buffer;

describe('human mannequin model', () => {
  afterEach(() => {
    resetHumanMannequinModelForTests();
  });

  it('loads the bundled CC0 mannequin asset', async () => {
    await ensureHumanMannequinModel(modelBuffer);
    expect(isHumanMannequinModelReady()).toBe(true);
  });

  it('does not load the optional GLB when the resolved project hides every mannequin', async () => {
    const project = createDefaultProject();
    for (const object of project.scene.objects) {
      if (object.type === 'human_dummy') object.visible = false;
    }

    expect(projectHasVisibleHumanMannequin(project)).toBe(false);
    await ensureHumanMannequinForProject(project, modelBuffer);
    expect(isHumanMannequinModelReady()).toBe(false);
  });

  it('grounds and centers the loaded mannequin for scene placement', async () => {
    await ensureHumanMannequinModel(modelBuffer);
    const person = createSceneObject('human_dummy', 1);
    person.transform.position = [0, person.dimensions[1] / 2, 0];
    const mesh = createObject3D(person, false, 'light', undefined, { skipContactShadow: true });
    mesh.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    mesh.traverse((node) => {
      const child = node as THREE.Mesh;
      if (child.isMesh) bounds.expandByObject(child);
    });
    expect(bounds.min.y).toBeCloseTo(0, 1);
    const center = bounds.getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 1);
    expect(center.z).toBeCloseTo(0, 1);
    expect(bounds.getSize(new THREE.Vector3()).y).toBeCloseTo(HUMAN_MANNEQUIN_REFERENCE_DIMENSIONS[1], 1);
  });

  it('scales mannequin instances from scene object dimensions', async () => {
    await ensureHumanMannequinModel(modelBuffer);
    const person = createSceneObject('human_dummy', 1);
    person.dimensions = [0.55, 2.1, 0.55];
    person.transform.position = [0, 1.05, 0];
    const mesh = createObject3D(person, false, 'light', undefined, { skipContactShadow: true });
    mesh.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    mesh.traverse((node) => {
      const child = node as THREE.Mesh;
      if (child.isMesh) bounds.expandByObject(child);
    });
    expect(bounds.getSize(new THREE.Vector3()).y).toBeCloseTo(2.1, 1);
  });
});
