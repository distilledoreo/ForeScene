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
    // Default: not animating until hover/selected (avoids N library intervals).
    expect(html).toContain('data-shot-keyframe-roll-animate="false"');
  });

  it('falls back to empty placeholder without previews or assets', () => {
    const project = createDefaultProject();
    const html = renderToStaticMarkup(
      <ShotCameraRollThumbnail project={project} shot={project.shots[0]} />,
    );
    expect(html).toContain('data-shot-camera-roll-empty');
  });
});
