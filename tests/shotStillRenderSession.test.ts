import { describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { ShotStillRenderSession } from '../src/engine/shotStillRenderSession';
import type { StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

const clayRenderMock = vi.hoisted(() => vi.fn(async () => ({
  dataUrl: '',
  blob: new Blob(['clay'], { type: 'image/png' }),
  width: 64,
  height: 36,
})));

const createViewportRendererMock = vi.hoisted(() => vi.fn(() => ({ domElement: {} })));

vi.mock('../src/engine/renderers', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/renderers')>('../src/engine/renderers');
  return {
    ...actual,
    renderViewportClayOnRenderer: clayRenderMock,
    createViewportRenderer: createViewportRendererMock,
    disposeViewportRenderer: vi.fn(),
  };
});

describe('ShotStillRenderSession', () => {
  it('reuses one clay renderer per layer key across identical specs in a batch', async () => {
    clayRenderMock.mockClear();
    createViewportRendererMock.mockClear();
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const session = new ShotStillRenderSession();
    const spec = (peopleVariant: 'with_people' | 'clean_plate'): StillArtifactSpecification => ({
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant,
      width: 64,
      height: 36,
    });

    await session.renderSpecification(project, shot, spec('with_people'));
    await session.renderSpecification(project, shot, spec('with_people'));
    await session.renderSpecification(project, shot, spec('clean_plate'));

    expect(clayRenderMock).toHaveBeenCalledTimes(3);
    expect(createViewportRendererMock).toHaveBeenCalledTimes(2);
    expect(createViewportRendererMock).toHaveBeenNthCalledWith(1, 64, 36);
    expect(createViewportRendererMock).toHaveBeenNthCalledWith(2, 64, 36);
    session.dispose();
  });
});
