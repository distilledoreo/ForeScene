import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  CHECKERBOARD_TILE_METERS,
  FORESCENE_CONTACT_SHADOW_NAME,
  FORESCENE_GROUP_CONTACT_SHADOW_PREFIX,
  buildScene,
  computeBuildFogRange,
  createObject3D,
  createPreviewMesh,
  defaultSecondaryColor,
  defaultSolidColorForObject,
  disposeScene,
  placeImportedAssemblyContactShadows,
  resolveObjectMaterial,
  resolveSurfaceStyle,
} from '../src/engine/sceneObjects';
import { centerTransformForFootPlant } from '../src/engine/groundPivot';

describe('scene object disposal', () => {
  it('keeps semantic set proxies out of projected beauty frames', () => {
    const project = createDefaultProject();
    const set = createSceneObject('box', 1);
    set.id = 'set-proxy';
    set.name = 'Set proxy';
    set.stagingRole = 'set';
    const subject = createSceneObject('box', 1);
    subject.id = 'subject-prop';
    subject.name = 'Subject prop';
    subject.stagingRole = 'prop';
    project.scene.objects = [set, subject];
    const scene = buildScene(project, {
      appearance: 'projected',
      projected: {
        texture: new THREE.Texture(),
        origin: [0, 1.6, 0],
        rotation: [0, 0, 0],
        settings: project.settings.projectedStyle!,
      },
      showHelpers: false,
    });
    expect(scene.getObjectByName('Set proxy')).toBeUndefined();
    expect(scene.getObjectByName('Subject prop')).toBeTruthy();
    expect(project.scene.objects.some((object) => object.id === 'set-proxy')).toBe(true);
    disposeScene(scene);
  });

  it('maps Build visibility distance to the fog/shroud range', () => {
    expect(computeBuildFogRange(40)).toEqual({ near: 18, far: 40 });
    expect(computeBuildFogRange(200)).toEqual({ near: 90, far: 200 });
  });

  it('keeps configurable Build fog when fog is enabled', () => {
    const project = createDefaultProject();
    const scene = buildScene(project, { showHelpers: false, fogDistance: 80 });
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    const fog = scene.fog as THREE.Fog;
    expect(fog.near).toBe(36);
    expect(fog.far).toBe(80);
    disposeScene(scene);
  });

  it('disables fog when fog: false even if fogDistance is set', () => {
    const project = createDefaultProject();
    const scene = buildScene(project, {
      showHelpers: false,
      fog: false,
      fogDistance: 40,
    });
    expect(scene.fog).toBeNull();
    disposeScene(scene);
  });

  it('defaults to the 18–42 m fog range when fogDistance is omitted', () => {
    const project = createDefaultProject();
    const scene = buildScene(project, { showHelpers: false });
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    const fog = scene.fog as THREE.Fog;
    expect(fog.near).toBe(18);
    expect(fog.far).toBe(42);
    disposeScene(scene);
  });

  it('keeps shared build materials alive across scene rebuilds', () => {
    const project = createDefaultProject();
    const firstScene = buildScene(project, { showHelpers: false });
    const firstWall = firstScene.children
      .map((child) => child as THREE.Mesh)
      .find((child) => child.name === 'Main Temple Wall') as THREE.Mesh | undefined;

    expect(firstWall).toBeTruthy();
    const sharedMaterial = firstWall?.material as THREE.Material;
    expect(sharedMaterial).toBeTruthy();

    disposeScene(firstScene);

    const secondScene = buildScene(project, { showHelpers: false });
    const preview = createPreviewMesh(project.scene.objects[1]);
    secondScene.add(preview);

    const secondWall = secondScene.children
      .map((child) => child as THREE.Mesh)
      .find((child) => child.name === 'Main Temple Wall') as THREE.Mesh | undefined;

    expect(secondWall?.material).toBe(sharedMaterial);
    expect(((secondWall?.material as THREE.Material | undefined)?.uuid)).toBe(sharedMaterial.uuid);

    disposeScene(secondScene);
  });

  it('creates independent preview nodes for placement', () => {
    const project = createDefaultProject();
    const wall = project.scene.objects[1];
    const wallMesh = createObject3D(wall);
    const preview = createPreviewMesh(wall);

    expect(wallMesh).not.toBe(preview);
    expect(preview.name).toBe('Placement Preview');
    expect(preview.userData.previewObject).toBe(true);
  });

  it('reuses matching primitive geometry and surface materials across objects', () => {
    const first = createSceneObject('box', 1);
    first.dimensions = [2, 3, 4];
    first.surfaceStyle = 'solid';
    first.color = '#7aa2c4';
    const second = { ...first, id: 'same-geometry-second' };

    const firstMesh = createObject3D(first) as THREE.Mesh;
    const secondMesh = createObject3D(second) as THREE.Mesh;

    expect(firstMesh.geometry).toBe(secondMesh.geometry);
    expect(firstMesh.material).toBe(secondMesh.material);
  });
});

describe('object surface styles', () => {
  it('defaults to clay materials and supports solid + 1m checkerboard surfaces', () => {
    const box = createSceneObject('box', 1);
    expect(resolveSurfaceStyle(box)).toBe('default');

    const solid = {
      ...box,
      surfaceStyle: 'solid' as const,
      color: '#7aa2c4',
    };
    const solidMaterial = resolveObjectMaterial(solid);
    expect(solidMaterial.color.getHexString()).toBe('7aa2c4');

    const checker = {
      ...box,
      surfaceStyle: 'checkerboard' as const,
      color: '#e8e8e8',
      secondaryColor: '#444444',
    };
    const checkerMaterial = resolveObjectMaterial(checker);
    expect(CHECKERBOARD_TILE_METERS).toBe(1);
    expect(checkerMaterial.customProgramCacheKey?.()).toContain('checkerboard-1m-face');

    const alternateCheckerMaterial = resolveObjectMaterial({
      ...checker,
      color: '#999999',
      secondaryColor: '#222222',
    });
    expect(alternateCheckerMaterial.customProgramCacheKey?.()).toBe(checkerMaterial.customProgramCacheKey?.());
    expect(defaultSolidColorForObject(box)).toMatch(/^#[0-9a-f]{6}$/);
    expect(defaultSecondaryColor('#ffffff')).toMatch(/^#[0-9a-f]{6}$/);

    const mesh = createObject3D(checker);
    expect(mesh).toBeTruthy();
  });
});

describe('ground contact', () => {
  it('plants leaned character roots so declared feet stay on the floor', () => {
    const person = createSceneObject('human_dummy', 1);
    person.transform.rotation = [34, 0, 0];
    person.transform.position = centerTransformForFootPlant(
      [0, person.dimensions[1] / 2, 0],
      person.transform.rotation,
      person.dimensions[1],
    );
    const node = createObject3D(person);
    const half = person.dimensions[1] / 2;
    const foot = new THREE.Vector3(0, -half, 0).applyEuler(node.rotation);
    expect(node.position.y + foot.y).toBeCloseTo(0, 5);
    expect(node.getObjectByName(FORESCENE_CONTACT_SHADOW_NAME)).toBeTruthy();
  });

  it('does not attach contact shadows to set architecture', () => {
    const wall = createSceneObject('wall', 1);
    const node = createObject3D(wall);
    expect(node.getObjectByName(FORESCENE_CONTACT_SHADOW_NAME)).toBeUndefined();
  });

  it('uses one floor-level contact shadow for a multipart imported assembly', () => {
    const project = createDefaultProject();
    const left = createSceneObject('imported_model', 1);
    const right = createSceneObject('imported_model', 2);
    const importedModel = {
      sourceName: 'assembly.glb', sourceFormat: 'glb', sourceKind: 'model' as const,
      vertexCount: 8, triangleCount: 12, meshCount: 1, importMode: 'separate' as const,
      sourceImportId: 'import-assembly', geometrySimplified: false as const,
      hierarchyFlattened: true as const,
    };
    left.importedModel = importedModel;
    right.importedModel = importedModel;
    left.stagingRole = 'prop';
    right.stagingRole = 'prop';
    left.transform.position = [-0.4, left.dimensions[1] / 2, 0];
    right.transform.position = [0.4, right.dimensions[1] / 2, 0];
    project.scene.objects = [left, right];
    project.scene.objectGroups = {
      assembly: {
        id: 'assembly', name: 'Assembly', objectIds: [left.id, right.id],
        sourceImportId: 'import-assembly',
      },
    };

    const scene = buildScene(project);
    const leftNode = scene.children.find((node) => node.userData.sceneObjectId === left.id)!;
    const rightNode = scene.children.find((node) => node.userData.sceneObjectId === right.id)!;
    expect(leftNode.getObjectByName(FORESCENE_CONTACT_SHADOW_NAME)).toBeUndefined();
    expect(rightNode.getObjectByName(FORESCENE_CONTACT_SHADOW_NAME)).toBeUndefined();
    const shadow = scene.getObjectByName(`${FORESCENE_GROUP_CONTACT_SHADOW_PREFIX}assembly`)!;
    expect(shadow).toBeTruthy();
    expect(leftNode.position.y).toBeLessThan(left.transform.position[1]);
    expect(rightNode.position.y - leftNode.position.y).toBeCloseTo(
      right.transform.position[1] - left.transform.position[1],
      5,
    );
    expect(shadow.position.y).toBeLessThan(0.05);
    expect(shadow.position.y).toBeGreaterThan(-0.08);
    leftNode.visible = false;
    rightNode.visible = false;
    placeImportedAssemblyContactShadows(scene, project);
    expect(shadow.visible).toBe(false);
  });

  it('does not reinterpret an ordinary multi-object group as an import assembly', () => {
    const project = createDefaultProject();
    const left = createSceneObject('imported_model', 1);
    const right = createSceneObject('imported_model', 2);
    left.stagingRole = 'prop';
    right.stagingRole = 'prop';
    project.scene.objects = [left, right];
    project.scene.objectGroups = {
      pair: { id: 'pair', name: 'Independent pair', objectIds: [left.id, right.id] },
    };
    const scene = buildScene(project);
    expect(scene.getObjectByName(`${FORESCENE_GROUP_CONTACT_SHADOW_PREFIX}pair`)).toBeUndefined();
    const nodes = scene.children.filter((node) => node.userData.sceneObjectId);
    expect(nodes.every((node) => Boolean(node.getObjectByName(FORESCENE_CONTACT_SHADOW_NAME)))).toBe(true);
  });

  it('does not plant each mesh of a multipart group onto the floor by itself', () => {
    const project = createDefaultProject();
    const body = createSceneObject('imported_model', 1);
    const eye = createSceneObject('imported_model', 2);
    const importedModel = {
      sourceName: 'assembly.glb', sourceFormat: 'glb', sourceKind: 'model' as const,
      vertexCount: 8, triangleCount: 12, meshCount: 1, importMode: 'separate' as const,
      sourceImportId: 'import-assembly', geometrySimplified: false as const,
      hierarchyFlattened: true as const,
    };
    body.importedModel = importedModel;
    eye.importedModel = importedModel;
    body.stagingRole = 'prop';
    eye.stagingRole = 'prop';
    body.transform.position = [0, 0.5, 0];
    eye.transform.position = [0, 1.4, 0.35];
    project.scene.objects = [body, eye];
    project.scene.objectGroups = {
      assembly: {
        id: 'assembly', name: 'Assembly', objectIds: [body.id, eye.id],
        sourceImportId: 'import-assembly',
      },
    };
    const scene = buildScene(project, { showHelpers: false });
    const bodyNode = scene.children.find((node) => node.userData.sceneObjectId === body.id)!;
    const eyeNode = scene.children.find((node) => node.userData.sceneObjectId === eye.id)!;
    const restGap = eye.transform.position[1] - body.transform.position[1];
    expect(eyeNode.position.y - bodyNode.position.y).toBeCloseTo(restGap, 5);
    disposeScene(scene);
  });

  it('plants a standalone contact subject so live mesh sits on the floor', () => {
    const project = createDefaultProject();
    const dummy = createSceneObject('human_dummy', 1);
    dummy.transform.position = [0, 0.875, 0];
    dummy.transform.rotation = [34, 0, 0];
    project.scene.objects = [dummy];
    const scene = buildScene(project, { showHelpers: false });
    const node = scene.children.find((child) => child.userData.sceneObjectId === dummy.id)!;
    const bounds = new THREE.Box3().setFromObject(node);
    expect(bounds.min.y).toBeLessThan(0.02);
    expect(bounds.min.y).toBeGreaterThan(-0.12);
    disposeScene(scene);
  });

  it('sinks projected contact subjects deeper so they meet a painted pano floor', () => {
    const project = createDefaultProject();
    const dummy = createSceneObject('human_dummy', 1);
    dummy.transform.position = [0, 0.875, 0];
    project.scene.objects = [dummy];
    const clay = buildScene(project, { showHelpers: false });
    const clayY = clay.children.find((child) => child.userData.sceneObjectId === dummy.id)!.position.y;
    disposeScene(clay);
    const projected = buildScene(project, {
      showHelpers: false,
      appearance: 'projected',
      projected: {
        texture: new THREE.Texture(),
        origin: [0, 1.6, 0],
        rotation: [0, 0, 0],
        settings: project.settings.projectedStyle!,
      },
    });
    const projectedY = projected.children.find((child) => child.userData.sceneObjectId === dummy.id)!.position.y;
    expect(projectedY).toBeLessThan(clayY - 0.05);
    disposeScene(projected);
  });
});
