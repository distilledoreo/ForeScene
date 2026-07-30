import { describe, expect, it } from 'vitest';
import { createDefaultProject, createOriginShot, createPanoAsset, createPanoReference } from '../src/domain/defaults';
import { linkAllShotsToCanonicalPano } from '../src/engine/sync';
import { useProjectStore } from '../src/state/useProjectStore';

describe('origin camera', () => {
  it('starts new projects with a camera at the pano origin', () => {
    const project = createDefaultProject();
    expect(project.shots[0].camera.position).toEqual(project.scene.panoOrigin);
    expect(project.shots[0].camera.target[2]).toBeGreaterThan(project.scene.panoOrigin[2]);
  });

  it('adds additional cameras at the origin', () => {
    useProjectStore.setState({
      project: createDefaultProject(),
      workspace: 'shots',
      selectedShotId: undefined,
      shotCameraFlying: true,
    });

    const shot = useProjectStore.getState().addCamera();
    const project = useProjectStore.getState().project;

    expect(project.shots).toHaveLength(2);
    expect(shot.name).toBe('Camera 002');
    expect(shot.camera.position).toEqual(project.scene.panoOrigin);
  });

  it('creates an origin camera for legacy projects without shots', () => {
    const project = createDefaultProject();
    project.shots = [];
    const shot = createOriginShot(project);
    expect(shot.camera.position).toEqual(project.scene.panoOrigin);
  });

  it('auto-links existing shots to the canonical pano when one is added', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'global_reference.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Canonical',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);

    const linked = linkAllShotsToCanonicalPano(project);
    expect(linked.shots[0].linkedPanoId).toBe(pano.id);
    expect(linked.shots[0].panoCrop?.panoId).toBe(pano.id);
    expect(linked.shots[0].panoCrop?.yawDegrees).toBeCloseTo(0, 3);
  });
});