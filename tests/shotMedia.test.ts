import { describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference, createVideoAsset } from '../src/domain/defaults';
import {
  hasShotCapture,
  resolveCameraKeyframePreviewUris,
  resolveShotMedia,
  resolveShotMediaPoster,
  shotHasCameraKeyframeMove,
} from '../src/domain/shotMedia';

describe('resolveShotMedia', () => {
  it('includes video and stored captured images in stable order', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const videoAsset = createVideoAsset({
      name: 'camera_move.mp4',
      uri: 'data:video/mp4;base64,VIDEO',
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
    });
    const viewportAsset = createPanoAsset({
      name: 'viewport.png',
      uri: 'data:image/png;base64,VIEWPORT',
      width: 1920,
      height: 1080,
    });
    const aiAsset = createPanoAsset({
      name: 'ai_result.png',
      uri: 'data:image/png;base64,AI',
      width: 1920,
      height: 1080,
    });
    project.assets.assets[videoAsset.id] = videoAsset;
    project.assets.assets[viewportAsset.id] = viewportAsset;
    project.assets.assets[aiAsset.id] = aiAsset;
    shot.assets.cameraMoveVideoAssetId = videoAsset.id;
    shot.assets.viewportRenderAssetId = viewportAsset.id;
    shot.assets.aiResultFrameAssetId = aiAsset.id;

    const media = resolveShotMedia(project, shot);

    expect(media.map((item) => item.source)).toEqual([
      'camera_move',
      'captured_still',
      'ai_result',
    ]);
    expect(media[0].kind).toBe('video');
    expect(media[1].kind).toBe('image');
    expect(resolveShotMediaPoster(project, shot)?.source).toBe('captured_still');
  });

  it('falls back to video posters only when no still image exists', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const videoAsset = createVideoAsset({
      name: 'camera_move.mp4',
      uri: 'data:video/mp4;base64,VIDEO',
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
    });
    project.assets.assets[videoAsset.id] = videoAsset;
    shot.assets.cameraMoveVideoAssetId = videoAsset.id;

    expect(resolveShotMediaPoster(project, shot)?.source).toBe('camera_move');
  });

  it('excludes linked and canonical panoramas', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const linkedAsset = createPanoAsset({
      name: 'linked_pano.png',
      uri: 'data:image/png;base64,LINKED',
      width: 2048,
      height: 1024,
    });
    const linkedPano = createPanoReference({
      name: 'Linked Pano',
      assetId: linkedAsset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 2048,
      height: 1024,
      isCanonical: true,
    });
    project.assets.assets[linkedAsset.id] = linkedAsset;
    project.panoRefs.push(linkedPano);
    shot.linkedPanoId = linkedPano.id;

    expect(resolveShotMedia(project, shot)).toEqual([]);
    expect(resolveShotMediaPoster(project, shot)).toBeUndefined();
  });

  it('ignores missing asset references', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.assets.viewportRenderAssetId = 'missing-asset';

    expect(resolveShotMedia(project, shot)).toEqual([]);
  });
});

describe('camera keyframe roll previews', () => {
  it('treats multi-keyframe moves as captures even without exported media', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    expect(hasShotCapture(project, shot)).toBe(false);

    shot.cameraKeyframes = [
      { id: 's', label: 'Start', timeSeconds: 0, camera: shot.camera, previewUri: 'data:image/png;base64,S' },
      { id: 'e', label: 'End', timeSeconds: 3, camera: shot.camera, previewUri: 'data:image/png;base64,E' },
    ];
    expect(shotHasCameraKeyframeMove(shot)).toBe(true);
    expect(hasShotCapture(project, shot)).toBe(true);
    expect(resolveCameraKeyframePreviewUris(shot)).toEqual([
      'data:image/png;base64,S',
      'data:image/png;base64,E',
    ]);
  });

  it('sorts preview uris by time and drops missing stills', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.cameraKeyframes = [
      { id: 'e', label: 'End', timeSeconds: 4, camera: shot.camera, previewUri: 'data:image/png;base64,E' },
      { id: 's', label: 'Start', timeSeconds: 0, camera: shot.camera },
      { id: 'm', label: 'Mid', timeSeconds: 2, camera: shot.camera, previewUri: 'data:image/png;base64,M' },
    ];
    expect(resolveCameraKeyframePreviewUris(shot)).toEqual([
      'data:image/png;base64,M',
      'data:image/png;base64,E',
    ]);
  });
});

