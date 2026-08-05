import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { setTwoPointCameraKeyframe } from '../src/engine/cameraKeyframes';
import { generateGrayboxReferencePrompt, generateVideoPrompt } from '../src/engine/prompts';

describe('graybox reference prompt', () => {
  it('includes the continuity template and creative brief', () => {
    const prompt = generateGrayboxReferencePrompt('Sun-baked sandstone temple at dusk.');

    expect(prompt).toContain('Transform the provided graybox 360 equirectangular panorama into a finished final render.');
    expect(prompt).toContain('Creative brief:');
    expect(prompt).toContain('Sun-baked sandstone temple at dusk.');
    expect(prompt).toContain('Geometry lock:');
    expect(prompt).toContain('Forbidden changes:');
    expect(prompt).toContain('360 requirements:');
    expect(prompt).toContain('Rendering goal:');
  });

  it('uses a placeholder brief when the project description is empty', () => {
    const prompt = generateGrayboxReferencePrompt('');

    expect(prompt).toContain('Describe the look you want: style, time of day, materials, and mood.');
  });

  it('uses a flexible 16:9 format instruction without fixed pixel dimensions', () => {
    const prompt = generateGrayboxReferencePrompt('Misty alpine village.');

    expect(prompt).toContain('The output must be a 16:9 image containing a centered 2:1 equirectangular panorama band.');
    expect(prompt).not.toContain('1920');
    expect(prompt).not.toContain('1080');
  });

  it('mentions the camera move MP4 when a shot has exported motion control', () => {
    const shot = createDefaultProject().shots[0];
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [1, 1.8, -3],
      },
    });
    shot.assets.cameraMoveVideoAssetId = 'asset_camera_move';

    const prompt = generateVideoPrompt(shot);
    expect(prompt).toContain('Use viewport_clay_motion.mp4 as the camera-motion');
    expect(prompt).not.toContain('inputs/cubemap/');
  });

  it('mentions cubemap faces when cubemap export is enabled', () => {
    const shot = createDefaultProject().shots[0];
    shot.exportSettings.includeCubemap = true;
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [1, 1.8, -3],
      },
    });
    shot.assets.cameraMoveVideoAssetId = 'asset_camera_move';

    const prompt = generateVideoPrompt(shot);
    expect(prompt).toContain('inputs/cubemap/');
    expect(prompt).not.toContain('cubemap_visible');
    expect(prompt).toContain('cubemap is not the camera lens');
  });
});
