import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createCameraData, createDefaultProject } from '../src/domain/defaults';
import {
  clampShotNearClip,
  DEFAULT_SHOT_NEAR_CLIP_METERS,
  MAX_SHOT_NEAR_CLIP_METERS,
  MIN_SHOT_NEAR_CLIP_METERS,
} from '../src/engine/cameraClipping';
import { computeCameraMoveClippingRange } from '../src/engine/exportClipping';
import { applyFlyCameraToPerspectiveCamera } from '../src/engine/renderers';
import { createFinalRenderSceneOptions } from '../src/engine/finalRenderProfile';
import { buildScene, disposeScene } from '../src/engine/sceneObjects';
import { flyCameraFromCamera } from '../src/engine/sync';
import { useProjectStore } from '../src/state/useProjectStore';
import type { CameraData } from '../src/domain/types';

describe('clampShotNearClip', () => {
  it('keeps 0.1 as the default near clip', () => {
    expect(DEFAULT_SHOT_NEAR_CLIP_METERS).toBe(0.1);
    expect(createCameraData([0, 1.6, 0], [0, 1.6, 1]).near).toBe(0.1);
  });

  it('normalizes negative, blank, NaN, and zero values safely', () => {
    const far = 100;
    expect(clampShotNearClip(-1, far)).toBe(MIN_SHOT_NEAR_CLIP_METERS);
    expect(clampShotNearClip(Number(''), far)).toBe(MIN_SHOT_NEAR_CLIP_METERS);
    expect(clampShotNearClip(Number.NaN, far)).toBe(DEFAULT_SHOT_NEAR_CLIP_METERS);
    expect(clampShotNearClip(0, far)).toBe(MIN_SHOT_NEAR_CLIP_METERS);
    expect(clampShotNearClip(Number(undefined), far)).toBe(DEFAULT_SHOT_NEAR_CLIP_METERS);
  });

  it('never allows near to equal or exceed far', () => {
    expect(clampShotNearClip(50, 10)).toBeCloseTo(9.99, 5);
    expect(clampShotNearClip(10, 10)).toBeCloseTo(9.99, 5);
    expect(clampShotNearClip(0.1, 0.05)).toBeCloseTo(0.04, 5);
    expect(clampShotNearClip(0.1, 0.05)).toBeLessThan(0.05);
  });

  it('accepts intentional foreground clipping within the soft max', () => {
    expect(clampShotNearClip(2.5, 100)).toBe(2.5);
    expect(clampShotNearClip(MAX_SHOT_NEAR_CLIP_METERS, 100)).toBe(MAX_SHOT_NEAR_CLIP_METERS);
    expect(clampShotNearClip(50, 100)).toBe(MAX_SHOT_NEAR_CLIP_METERS);
  });
});

describe('shot near clip undo', () => {
  it('creates one camera undo step when near changes', () => {
    useProjectStore.setState({
      project: createDefaultProject(),
      selectedShotId: undefined,
      shotCameraHistoryByShotId: {},
      shotCameraHistoryBatchDepth: 0,
      shotCameraHistoryBatchCaptured: false,
    });
    const shotId = useProjectStore.getState().project.shots[0].id;
    const original = useProjectStore.getState().project.shots[0].camera;
    expect(original.near).toBe(DEFAULT_SHOT_NEAR_CLIP_METERS);

    useProjectStore.getState().selectShot(shotId);
    const nextNear = clampShotNearClip(1.5, original.far);
    useProjectStore.getState().updateShot(shotId, {
      camera: { ...original, near: nextNear },
    });

    expect(useProjectStore.getState().project.shots[0].camera.near).toBe(1.5);
    expect(useProjectStore.getState().undoShotCamera()).toBe(true);
    expect(useProjectStore.getState().project.shots[0].camera.near).toBe(
      DEFAULT_SHOT_NEAR_CLIP_METERS,
    );
    expect(useProjectStore.getState().redoShotCamera()).toBe(true);
    expect(useProjectStore.getState().project.shots[0].camera.near).toBe(1.5);
  });
});

describe('live viewfinder near clip wiring', () => {
  it('applies the shot near value to PerspectiveCamera.near', () => {
    const cameraData: CameraData = {
      ...createCameraData([0, 1.65, 2], [0, 1.65, 0]),
      near: 1.25,
      far: 80,
    };
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 100);
    applyFlyCameraToPerspectiveCamera(
      camera,
      flyCameraFromCamera(cameraData),
      cameraData.fovDegrees,
      16 / 9,
      cameraData.near,
      cameraData.far,
    );
    expect(camera.near).toBe(1.25);
    expect(camera.far).toBe(80);
  });

  it('wires SceneViewport to framing.camera.near instead of a hardcoded 0.1', () => {
    const source = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    expect(source).toContain('framing?.camera.near ?? DEFAULT_SHOT_NEAR_CLIP_METERS');
    expect(source).toContain('framing?.camera.far ?? renderDistanceRef.current');
    expect(source).not.toMatch(
      /applyFlyCameraToPerspectiveCamera\(\s*[\s\S]*?0\.1,\s*\n\s*framing\?\.camera\.far/,
    );
  });

  it('exposes Near Clip in Camera Settings via commitShotCamera', () => {
    const source = readFileSync(
      new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('Near Clip (m)');
    expect(source).toContain('clampShotNearClip');
    expect(source).toContain('near,');
    expect(source).toMatch(/commitShotCamera\(\{\s*\.\.\.selectedShot\.camera,\s*near,/);
  });
});

describe('export near clipping', () => {
  it('passes the selected near value through still export clipping', () => {
    const project = createDefaultProject();
    const scene = buildScene(project, createFinalRenderSceneOptions());
    const cameraData = createCameraData([0, 1.65, 2], [0, 1.65, 0]);
    cameraData.near = 2.5;

    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: [cameraData],
      nearMeters: cameraData.near,
    });

    expect(clipping.near).toBe(2.5);
    expect(clipping.far).toBeGreaterThan(clipping.near + 1);
    disposeScene(scene);

    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    expect(source).toContain('nearMeters: cameraData.near');
  });

  it('uses one fixed near value for every video frame from the max keyframe near', () => {
    const project = createDefaultProject();
    const scene = buildScene(project, createFinalRenderSceneOptions());
    const start = createCameraData([0, 1.65, 2], [0, 1.65, 0]);
    start.near = 0.2;
    const end = createCameraData([0, 1.65, -5], [0, 1.65, 10]);
    end.near = 1.8;

    const nearMeters = Math.max(
      clampShotNearClip(start.near, start.far),
      clampShotNearClip(end.near, end.far),
    );
    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: [start, end],
      nearMeters,
    });

    expect(nearMeters).toBe(1.8);
    expect(clipping.near).toBe(1.8);
    disposeScene(scene);

    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    expect(source).toContain('const nearMeters = Math.max(');
    expect(source).toContain('clipping.near,');
    expect(source).toContain('clipping.far,');
    expect(source).not.toContain('clipping?.near ?? cameraData.near');
  });

  it('falls back to 0.1 for missing or invalid near values', () => {
    const project = createDefaultProject();
    const scene = buildScene(project, createFinalRenderSceneOptions());
    const camera = createCameraData([0, 1.65, 0], [0, 1.65, 5]);
    // Simulate older / corrupted project data.
    (camera as { near: number }).near = Number.NaN;

    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: [camera],
      nearMeters: clampShotNearClip(camera.near, camera.far),
    });

    expect(clipping.near).toBe(DEFAULT_SHOT_NEAR_CLIP_METERS);
    disposeScene(scene);

    expect(clampShotNearClip(Number.POSITIVE_INFINITY, 100)).toBe(DEFAULT_SHOT_NEAR_CLIP_METERS);
    expect(clampShotNearClip(undefined as unknown as number, 100)).toBe(
      DEFAULT_SHOT_NEAR_CLIP_METERS,
    );
  });

  it('still derives far from scene bounds when near is raised', () => {
    const project = createDefaultProject();
    if (project.scene.objects[1]) {
      project.scene.objects[1].transform.position = [0, 0, 80];
    }
    const scene = buildScene(project, createFinalRenderSceneOptions());
    const camera = createCameraData([0, 1.65, 0], [0, 1.65, 80]);
    camera.near = 3;

    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: [camera],
      nearMeters: camera.near,
    });

    expect(clipping.near).toBe(3);
    expect(clipping.far).toBeGreaterThan(80);
    disposeScene(scene);
  });
});
