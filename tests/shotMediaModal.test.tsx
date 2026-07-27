import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createVideoAsset } from '../src/domain/defaults';
import { ShotMediaModal } from '../src/components/common/ShotMediaModal';

describe('ShotMediaModal', () => {
  it('opens multi-keyframe shots on the animated keyframe path', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.cameraKeyframes = [
      {
        id: 's',
        label: 'Start',
        timeSeconds: 0,
        camera: shot.camera,
        previewUri: 'data:image/png;base64,STARTKF',
      },
      {
        id: 'e',
        label: 'End',
        timeSeconds: 3,
        camera: shot.camera,
        previewUri: 'data:image/png;base64,ENDKF',
      },
    ];

    const html = renderToStaticMarkup(
      <ShotMediaModal
        open
        project={project}
        shots={project.shots}
        shotId={shot.id}
        onClose={() => undefined}
        onOpenShot={() => undefined}
        onUpdateShot={() => undefined}
      />,
    );

    expect(html).toContain('data-shot-media-modal');
    expect(html).toContain('data-shot-media-stage-mode="keyframe_path"');
    expect(html).toContain('data-shot-keyframe-roll');
    expect(html).toContain('data-shot-media-keyframe-strip');
    expect(html).toContain('data-shot-media-keyframe-frame');
    expect(html).toContain('STARTKF');
    expect(html).toContain('ENDKF');
    expect(html).toContain('Keyframes');
  });

  it('renders image captures without selecting the live shot', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const viewportAsset = createPanoAsset({
      name: 'viewport.png',
      uri: 'data:image/png;base64,VIEWPORT',
      width: 1920,
      height: 1080,
    });
    project.assets.assets[viewportAsset.id] = viewportAsset;
    shot.assets.viewportRenderAssetId = viewportAsset.id;

    const html = renderToStaticMarkup(
      <ShotMediaModal
        open
        project={project}
        shots={project.shots}
        shotId={shot.id}
        onClose={() => undefined}
        onOpenShot={() => undefined}
        onUpdateShot={() => undefined}
      />,
    );

    expect(html).toContain('data-shot-media-modal');
    expect(html).toContain('VIEWPORT');
    expect(html).toContain('<img');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('data-shot-still-view-toggles');
  });

  it('exposes projection and people toggles when still view variants exist', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const clay = createPanoAsset({
      name: 'clay.png',
      uri: 'data:image/png;base64,CLAYPEOPLE',
      width: 1920,
      height: 1080,
    });
    const clayClean = createPanoAsset({
      name: 'clay_clean.png',
      uri: 'data:image/png;base64,CLAYCLEAN',
      width: 1920,
      height: 1080,
    });
    const projected = createPanoAsset({
      name: 'projected.png',
      uri: 'data:image/png;base64,PROJPEOPLE',
      width: 1920,
      height: 1080,
    });
    const projectedClean = createPanoAsset({
      name: 'projected_clean.png',
      uri: 'data:image/png;base64,PROJCLEAN',
      width: 1920,
      height: 1080,
    });
    project.assets.assets[clay.id] = clay;
    project.assets.assets[clayClean.id] = clayClean;
    project.assets.assets[projected.id] = projected;
    project.assets.assets[projectedClean.id] = projectedClean;
    shot.assets.viewportRenderAssetId = clay.id;
    shot.assets.viewportCleanPlateAssetId = clayClean.id;
    shot.assets.viewportProjectedAssetId = projected.id;
    shot.assets.viewportProjectedCleanPlateAssetId = projectedClean.id;

    const html = renderToStaticMarkup(
      <ShotMediaModal
        open
        project={project}
        shots={project.shots}
        shotId={shot.id}
        onClose={() => undefined}
        onOpenShot={() => undefined}
        onUpdateShot={() => undefined}
      />,
    );

    expect(html).toContain('data-shot-still-view-toggles');
    expect(html).toContain('data-shot-still-view="clay_with_people"');
    expect(html).toContain('CLAYPEOPLE');
    expect(html).toContain('Projection');
    expect(html).toContain('People');
    expect(html).toContain('Clean plate');
    expect(html).toContain('Projected');
  });

  it('renders stored video captures with a video element', () => {
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

    const html = renderToStaticMarkup(
      <ShotMediaModal
        open
        project={project}
        shots={project.shots}
        shotId={shot.id}
        onClose={() => undefined}
        onOpenShot={() => undefined}
        onUpdateShot={() => undefined}
      />,
    );

    expect(html).toContain('<video');
    expect(html).toContain('VIDEO');
  });
});
