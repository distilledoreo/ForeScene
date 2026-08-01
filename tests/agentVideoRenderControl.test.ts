import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { setTwoPointCameraKeyframe } from '../src/engine/cameraKeyframes';
import { renderShotCameraMoveMp4 } from '../src/engine/renderers';
import {
  cancelAgentShotVideoRender,
  renderAgentShotVideo,
  resetAgentShotVideoRenderControl,
} from '../src/engine/agent/videoRenderControl';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

vi.mock('../src/engine/renderers', () => ({
  renderShotCameraMoveMp4: vi.fn(),
}));

const renderMock = vi.mocked(renderShotCameraMoveMp4);

function projectWithTimeline() {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  const start = setTwoPointCameraKeyframe({
    keyframes: [],
    slot: 'start',
    camera: shot.camera,
    durationSeconds: 2,
  });
  const keyframes = setTwoPointCameraKeyframe({
    keyframes: start,
    slot: 'end',
    camera: { ...shot.camera, position: [2, 2, 2] as [number, number, number] },
    durationSeconds: 2,
  });
  project.shots[0] = { ...shot, cameraKeyframes: keyframes };
  return project;
}

function renderedVideo() {
  return {
    blob: new Blob(['video'], { type: 'video/mp4' }),
    dataUrl: 'data:video/mp4;base64,dmVv',
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationSeconds: 2,
    frameRate: 24,
    encodeMode: 'render' as const,
    codecString: 'avc1.test',
    frameCount: 48,
    fileExtension: 'mp4' as const,
  };
}

describe('agent shot video transactions', () => {
  beforeEach(() => {
    resetAgentShotVideoRenderControl();
    renderMock.mockReset();
    useAgentControlStore.setState({ controlMode: 'read-write' });
    useProjectStore.getState().setProject(projectWithTimeline());
    useProjectSafetyStore.setState({
      flushProject: vi.fn(async () => ({
        project: structuredClone(useProjectStore.getState().project),
      }) as never),
    });
    renderMock.mockResolvedValue(renderedVideo());
  });

  it('forwards deterministic mode, appearance, content, and attachment options', async () => {
    const shotId = useProjectStore.getState().project.shots[0]!.id;
    const result = await renderAgentShotVideo({
      shotId,
      mode: 'render',
      resolutionPreset: '720p',
      appearance: 'depth',
      contentMode: 'characters_only',
      includeCharacterAttachments: true,
      attachToShot: false,
      download: false,
    });

    expect(result.ok).toBe(true);
    expect(renderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        mode: 'render',
        resolutionPreset: '720p',
        appearance: 'depth',
        contentMode: 'characters_only',
        includeCharacterAttachments: true,
        includeDataUrl: false,
      }),
    );

    await renderAgentShotVideo({
      shotId,
      mode: 'quickPreview',
      appearance: 'projected',
      contentMode: 'full_scene',
      attachToShot: false,
      download: false,
    });
    expect(renderMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        mode: 'quickPreview',
        appearance: 'projected',
        contentMode: 'full_scene',
      }),
    );
  });

  it('attaches a rendered video and retains the attachment through project reload', async () => {
    const shotId = useProjectStore.getState().project.shots[0]!.id;
    const result = await renderAgentShotVideo({ shotId, download: false });
    expect(result.ok).toBe(true);
    expect(result.assetId).toBeTruthy();

    const saved = structuredClone(useProjectStore.getState().project);
    useProjectStore.getState().setProject(saved);
    const reloadedShot = useProjectStore.getState().project.shots[0]!;
    expect(reloadedShot.assets.cameraMoveVideoAssetId).toBe(result.assetId);
    expect(useProjectStore.getState().project.assets.assets[result.assetId!]).toBeTruthy();
  });

  it('rejects a timeline mutation during rendering without attaching stale output', async () => {
    renderMock.mockImplementation(async () => {
      const changed = structuredClone(useProjectStore.getState().project);
      changed.shots[0]!.cameraKeyframes[0]!.camera.position[0] += 1;
      useProjectStore.setState({ project: changed });
      return renderedVideo();
    });
    const shotId = useProjectStore.getState().project.shots[0]!.id;
    const result = await renderAgentShotVideo({ shotId, download: false });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('stale_revision');
    expect(useProjectStore.getState().project.shots[0]!.assets.cameraMoveVideoAssetId).toBeUndefined();
  });

  it('cancellation attaches nothing', async () => {
    renderMock.mockImplementation((_project, _shot, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const shotId = useProjectStore.getState().project.shots[0]!.id;
    const render = renderAgentShotVideo({ shotId, download: false });
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
    expect(cancelAgentShotVideoRender().ok).toBe(true);
    const result = await render;

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('video_render_cancelled');
    expect(useProjectStore.getState().project.shots[0]!.assets.cameraMoveVideoAssetId).toBeUndefined();
  });

  it('restores the previous attachment when persistence fails', async () => {
    const shotId = useProjectStore.getState().project.shots[0]!.id;
    const previous = useProjectStore.getState().attachCameraMoveVideoToShot(shotId, {
      name: 'previous.mp4',
      dataUrl: renderedVideo().dataUrl,
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 2,
      frameRate: 24,
      encodeMode: 'render',
    });
    const project = useProjectStore.getState().project;
    const flushProject = vi.fn()
      .mockResolvedValueOnce({ project: structuredClone(project) })
      .mockRejectedValueOnce(new Error('persistence failed'));
    useProjectSafetyStore.setState({ flushProject });
    const result = await renderAgentShotVideo({ shotId, download: false });

    expect(result.ok).toBe(false);
    expect(flushProject).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().project.shots[0]!.assets.cameraMoveVideoAssetId).toBe(previous.id);
    expect(useProjectStore.getState().project.assets.assets[previous.id]).toBeTruthy();
  });
});
