import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CameraMovePreviewStrip } from '../src/components/workspaces/CameraMovePreviewStrip';
import { createDefaultProject } from '../src/domain/defaults';

function cam(x: number) {
  const base = createDefaultProject().shots[0].camera;
  return {
    ...base,
    position: [x, base.position[1], base.position[2]] as [number, number, number],
  };
}

describe('CameraMovePreviewStrip', () => {
  it('renders nothing with fewer than two keyframes', () => {
    const html = renderToStaticMarkup(
      <CameraMovePreviewStrip
        keyframes={[{ id: 's', label: 'Start', timeSeconds: 0, camera: cam(0) }]}
        durationSeconds={6}
        thumbsById={{}}
        isPreviewing={false}
        onPreview={vi.fn()}
        onStopPreview={vi.fn()}
      />,
    );
    expect(html).toBe('');
  });

  it('shows filmstrip frames and play path for a multi-pose move', () => {
    const html = renderToStaticMarkup(
      <CameraMovePreviewStrip
        keyframes={[
          { id: 's', label: 'Start', timeSeconds: 0, camera: cam(0) },
          { id: 'e', label: 'End', timeSeconds: 6, camera: cam(6) },
        ]}
        durationSeconds={6}
        thumbsById={{ s: 'data:image/png;base64,abc' }}
        isPreviewing={false}
        onPreview={vi.fn()}
        onStopPreview={vi.fn()}
      />,
    );
    expect(html).toContain('data-camera-move-preview-strip');
    expect(html).toContain('data-camera-move-preview-filmstrip');
    expect(html).toContain('data-camera-move-preview-frame');
    expect(html).toContain('data-camera-move-preview-play');
    expect(html).toContain('Play path');
    expect(html).toContain('data:image/png;base64,abc');
    expect(html).toContain('Start');
    expect(html).toContain('End');
  });

  it('prefers exported video controls and demotes live path to secondary', () => {
    const html = renderToStaticMarkup(
      <CameraMovePreviewStrip
        keyframes={[
          { id: 's', label: 'Start', timeSeconds: 0, camera: cam(0) },
          { id: 'e', label: 'End', timeSeconds: 3, camera: cam(3) },
        ]}
        durationSeconds={3}
        thumbsById={{}}
        isPreviewing={false}
        exportedVideoUrl="blob:http://localhost/video"
        onPreview={vi.fn()}
        onStopPreview={vi.fn()}
      />,
    );
    expect(html).toContain('data-camera-move-preview-video');
    expect(html).toContain('blob:http://localhost/video');
    expect(html).not.toContain('data-camera-move-preview-filmstrip');
    expect(html).not.toContain('data-camera-move-preview-play');
    expect(html).toContain('data-camera-move-preview-live');
    expect(html).toContain('Preview live in viewfinder');
  });
});
