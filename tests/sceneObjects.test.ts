import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  CHECKERBOARD_TILE_METERS,
  buildScene,
  computeBuildFogRange,
  createObject3D,
  createPreviewMesh,
  defaultSecondaryColor,
  defaultSolidColorForObject,
  disposeScene,
  resolveObjectMaterial,
  resolveSurfaceStyle,
} from '../src/engine/sceneObjects';

describe('scene object disposal', () => {
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
