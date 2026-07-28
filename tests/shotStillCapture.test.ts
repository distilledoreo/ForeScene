import { describe, expect, it, vi } from 'vitest';
import { runSettledSequentially } from '../src/engine/asyncJobs';
import { buildStillCompanionJobs } from '../src/components/shots/useStillCaptureController';
import { createDefaultProject } from '../src/domain/defaults';
import type { LocationProject, Shot } from '../src/domain/types';
import {
  renderShotFrame,
  renderShotProjectedFrame,
} from '../src/engine/renderers';
import { canUseProjectedAppearance } from '../src/engine/projectedStyle';

vi.mock('../src/engine/renderers', () => ({
  renderShotFrame: vi.fn(async (_project: LocationProject, _shot: Shot, options?: { peopleVariant?: string }) => ({
    dataUrl: `data:image/png;base64,clay-${options?.peopleVariant ?? 'default'}`,
    width: 64,
    height: 36,
  })),
  renderShotProjectedFrame: vi.fn(async (_project: LocationProject, _shot: Shot, options?: { peopleVariant?: string }) => ({
    dataUrl: `data:image/png;base64,proj-${options?.peopleVariant ?? 'default'}`,
    width: 64,
    height: 36,
  })),
}));

vi.mock('../src/engine/projectedStyle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/projectedStyle')>();
  return {
    ...actual,
    canUseProjectedAppearance: vi.fn(() => true),
  };
});

describe('shot still capture scheduling', () => {
  it('builds clay+projected companion still jobs and runs them sequentially', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    expect(shot).toBeDefined();
    const shotForNaming = shot!;
    const attachments: Array<{ appearance: string; people: string; fileName: string }> = [];
    let active = 0;
    let peakActive = 0;

    const attachStillView = async (
      selection: { appearance: string; people: string },
      _dataUrl: string,
      _width: number,
      _height: number,
      fileName: string,
    ) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await Promise.resolve();
      attachments.push({
        appearance: selection.appearance,
        people: selection.people,
        fileName,
      });
      active -= 1;
    };

    expect(canUseProjectedAppearance(project)).toBe(true);

    const jobs = buildStillCompanionJobs({
      project,
      shotForNaming,
      viewportFileName: 'shot-viewport.png',
      attachStillView,
    });

    // Clay clean-plate + projected with_people + projected clean_plate when projected is available.
    expect(jobs.length).toBe(3);

    await runSettledSequentially(jobs);

    expect(peakActive).toBe(1);
    expect(attachments.map((item) => `${item.appearance}:${item.people}`)).toEqual([
      'clay:clean_plate',
      'projected:with_people',
      'projected:clean_plate',
    ]);
    // Drove the real render entry points (mocked WebGL) for each companion variant.
    expect(vi.mocked(renderShotFrame)).toHaveBeenCalled();
    expect(vi.mocked(renderShotProjectedFrame)).toHaveBeenCalled();
    expect(attachments.every((item) => item.fileName.length > 0)).toBe(true);
  });

  it('omits projected companion jobs when projected appearance is unavailable', async () => {
    vi.mocked(canUseProjectedAppearance).mockReturnValueOnce(false);
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const jobs = buildStillCompanionJobs({
      project,
      shotForNaming: shot,
      viewportFileName: 'shot-viewport.png',
      attachStillView: async () => {},
    });
    expect(jobs.length).toBe(1);
  });
});
