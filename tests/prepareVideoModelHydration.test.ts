import { describe, expect, it, vi } from 'vitest';
import { createCameraKeyframe, createDefaultProject, createTransform } from '../src/domain/defaults';

const state = vi.hoisted(() => ({
  hydrated: false,
  renderShotCameraMoveMp4: vi.fn(),
}));

vi.mock('../src/engine/modelAssetStore', () => ({
  hydrateModelAssetKeys: vi.fn(async (keys: readonly string[]) => {
    expect(keys).toEqual(['recovery-resource/model/video-persisted']);
    state.hydrated = true;
    return [];
  }),
}));

vi.mock('../src/engine/renderers', () => ({
  renderShotCameraMoveMp4: state.renderShotCameraMoveMp4,
}));

import { prepareVideoArtifact } from '../src/engine/prepareVideoArtifact';

describe('prepareVideoArtifact model hydration', () => {
  it('hydrates durable model keys before invoking the camera-move renderer', async () => {
    state.hydrated = false;
    state.renderShotCameraMoveMp4.mockReset().mockImplementation(async () => {
      expect(state.hydrated).toBe(true);
      return {
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        width: 1280,
        height: 720,
        durationSeconds: 2,
        frameRate: 24,
        fileExtension: 'mp4' as const,
        encodeMode: 'render' as const,
        frameCount: 48,
        codecString: 'avc1.64001f',
        actualEncoderMode: 'fast' as const,
        encoderModeFallback: false,
      };
    });
    const project = createDefaultProject();
    project.assets.assets.model = {
      id: 'model',
      type: 'model',
      name: 'Persisted video model',
      uri: 'panoref-idb:recovery-resource/model/video-persisted',
      resolutionStatus: 'available',
      createdAt: new Date(0).toISOString(),
    };
    project.scene.objects.push({
      id: 'video-model-object',
      name: 'Persisted video object',
      type: 'imported_model',
      transform: createTransform(),
      dimensions: [1, 1, 1],
      category: 'environment',
      locked: false,
      visible: true,
      modelAssetId: 'model',
    });
    const shot = project.shots[0]!;
    shot.cameraKeyframes = [
      createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shot.camera }),
      createCameraKeyframe({
        label: 'End',
        timeSeconds: 2,
        camera: { ...shot.camera, position: [1, shot.camera.position[1], shot.camera.position[2]] },
      }),
    ];

    await prepareVideoArtifact({
      project,
      shotId: shot.id,
      bypassCache: true,
      specification: {
        appearance: 'clay',
        mode: 'render',
        resolutionPreset: '720p',
        frameRate: 24,
        encoderMode: 'fast',
      },
    });

    expect(state.renderShotCameraMoveMp4).toHaveBeenCalledOnce();
  });
});
