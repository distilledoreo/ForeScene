import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

const validStats = {
  width: 64,
  height: 36,
  opaquePixelRatio: 1,
  luminanceMean: 0.5,
  luminanceVariance: 0.1,
  sampledUniqueColorCount: 8,
};

vi.mock('../src/engine/renderers', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/renderers')>('../src/engine/renderers');
  return {
    ...actual,
    renderShotFrame: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,Y2xheQ==', ...validStats, pixelStats: validStats })),
    renderShotProjectedFrame: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,cHJvamVjdGVk', width: 64, height: 36 })),
    renderShotCharacterFrame: vi.fn(async () => ({ blob: new Blob(['character'], { type: 'image/png' }), width: 64, height: 36 })),
    renderShotDepthFrame: vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,ZGVwdGg=',
      width: 64,
      height: 36,
      encoding: 'linear-camera-depth',
      nearMeters: 0.1,
      farMeters: 25,
      invert: false,
    })),
  };
});

vi.mock('../src/engine/previs/renderPixelStats', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/previs/renderPixelStats')>('../src/engine/previs/renderPixelStats');
  return {
    ...actual,
    computePixelStatsFromDataUrl: vi.fn(async () => validStats),
  };
});

import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';
import { computePixelStatsFromDataUrl } from '../src/engine/previs/renderPixelStats';
import {
  renderShotCharacterFrame,
  renderShotFrame,
  renderShotProjectedFrame,
} from '../src/engine/renderers';

class FakeFileReader {
  result: string | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

  readAsDataURL(): void {
    this.result = 'data:image/png;base64,Y2hhcmFjdGVy';
    this.onload?.({} as ProgressEvent<FileReader>);
  }
}

describe('agent multipass frame rendering', () => {
  beforeEach(() => {
    vi.stubGlobal('FileReader', FakeFileReader);
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.setState({ activeRevisionId: 'rev-multipass' });
    useProjectStore.setState({ project: createDefaultProject(), workspace: 'shots' });
    vi.mocked(renderShotFrame).mockClear();
    vi.mocked(renderShotProjectedFrame).mockClear();
    vi.mocked(renderShotCharacterFrame).mockClear();
  });

  it('routes clay, projected, and character-only requests to their canonical renderers', async () => {
    const project = useProjectStore.getState().project;
    const shotId = project.shots[0]!.id;
    const api = createForeSceneBrowserApi();

    const clay = await api.renderShotFrame({ shotId, appearance: 'clay', peopleVariant: 'clean_plate' });
    const projected = await api.renderShotFrame({ shotId, appearance: 'projected', peopleVariant: 'with_people' });
    const characters = await api.renderShotFrame({ shotId, appearance: 'clay', content: 'characters_only' });

    expect(clay).toMatchObject({ ok: true, source: 'canonical_clay_renderer', peopleVariant: 'clean_plate' });
    expect(projected).toMatchObject({ ok: true, source: 'canonical_projected_renderer', appearance: 'projected' });
    expect(characters).toMatchObject({ ok: true, source: 'canonical_character_renderer', content: 'characters_only' });
    expect(renderShotFrame).toHaveBeenCalledWith(expect.anything(), expect.anything(), { peopleVariant: 'clean_plate' });
    expect(renderShotProjectedFrame).toHaveBeenCalledWith(expect.anything(), expect.anything(), { peopleVariant: 'with_people' });
    expect(renderShotCharacterFrame).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      appearance: 'clay',
      includeAttachedProps: true,
    });
  });

  it('rejects an impossible character-only depth request before rendering', async () => {
    const shotId = useProjectStore.getState().project.shots[0]!.id;
    const result = await createForeSceneBrowserApi().renderShotFrame({
      shotId,
      appearance: 'depth',
      content: 'characters_only',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics?.[0]?.code).toBe('invalid_argument');
  });

  it('accepts a low-variance clean plate while still reporting canonical stats', async () => {
    const lowVarianceStats = { ...validStats, luminanceVariance: 0.00001, sampledUniqueColorCount: 1 };
    vi.mocked(renderShotFrame).mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,Y2xheQ==',
      ...lowVarianceStats,
      pixelStats: lowVarianceStats,
    });
    vi.mocked(computePixelStatsFromDataUrl).mockResolvedValueOnce(lowVarianceStats);

    const result = await createForeSceneBrowserApi().renderShotFrame({
      shotId: useProjectStore.getState().project.shots[0]!.id,
      appearance: 'clay',
      peopleVariant: 'clean_plate',
    });

    expect(result).toMatchObject({ ok: true, peopleVariant: 'clean_plate', pixelStats: lowVarianceStats });
  });
});
