import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShotCameraRollThumbnail } from '../src/components/common/ShotCameraRollThumbnail';
import { createDefaultProject } from '../src/domain/defaults';

describe('ShotCameraRollThumbnail keyframe roll', () => {
  it('renders a keyframe roll when two or more preview stills exist', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.cameraKeyframes = [
      {
        id: 's',
        label: 'Start',
        timeSeconds: 0,
        camera: shot.camera,
        previewUri: 'data:image/png;base64,START',
      },
      {
        id: 'e',
        label: 'End',
        timeSeconds: 4,
        camera: shot.camera,
        previewUri: 'data:image/png;base64,END',
      },
    ];

    const html = renderToStaticMarkup(
      <ShotCameraRollThumbnail project={project} shot={shot} className="h-20 w-28" />,
    );

    expect(html).toContain('data-shot-keyframe-roll');
    expect(html).toContain('data-shot-keyframe-roll-count="2"');
    expect(html).toContain('data-shot-keyframe-roll-keyframe-id="s"');
    expect(html).toContain('data:image/png;base64,START');
    expect(html).toContain('data-shot-has-keyframe-move="true"');
    expect(html).toContain('data-shot-keyframe-move-badge');
    expect(html).toContain('data-shot-keyframe-roll-animate="false"');
  });

  it('falls back to empty placeholder without previews or assets', () => {
    const project = createDefaultProject();
    const html = renderToStaticMarkup(
      <ShotCameraRollThumbnail project={project} shot={project.shots[0]} />,
    );
    expect(html).toContain('data-shot-camera-roll-empty');
  });

  it('does not inflate the capture-count badge with generated prepared references', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const now = new Date().toISOString();
    project.assets.assets['capture'] = {
      id: 'capture',
      type: 'image',
      name: 'capture.png',
      uri: 'data:image/png;base64,CAPTURE',
      mimeType: 'image/png',
      width: 4,
      height: 4,
      createdAt: now,
    };
    project.assets.assets['depth-ref'] = {
      id: 'depth-ref',
      type: 'image',
      name: 'depth_ref.png',
      uri: 'data:image/png;base64,DEPTH',
      mimeType: 'image/png',
      width: 4,
      height: 4,
      createdAt: now,
    };
    shot.assets.viewportRenderAssetId = 'capture';
    shot.materializedMedia = {
      stills: {
        'depth-reference-frame:depth:with_people:start': {
          id: 'still-depth-ref',
          key: 'depth-reference-frame:depth:with_people:start',
          kind: 'depth-reference-frame',
          assetId: 'depth-ref',
          fingerprint: 'depth-fingerprint',
          dependencyIds: [],
          width: 4,
          height: 4,
          mimeType: 'image/png',
          appearance: 'depth',
          peopleVariant: 'with_people',
          frameRole: 'start',
          timeSeconds: 0,
          createdAt: now,
        },
      },
    };

    const html = renderToStaticMarkup(
      <ShotCameraRollThumbnail project={project} shot={shot} showMediaCount />,
    );

    expect(html).not.toMatch(/>2<\/span>/);
  });
});
