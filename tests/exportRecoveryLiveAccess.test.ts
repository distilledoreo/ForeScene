import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { ensureStillArtifactForExport } from '../src/engine/ensureStillArtifactForExport';
import { bindLiveProjectAccess, resetLiveProjectAccessForTests } from '../src/engine/liveProjectAccess';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import type { StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

function claySpec(project: LocationProject): StillArtifactSpecification {
  const shot = project.shots[0]!;
  return {
    kind: 'clay-viewport',
    appearance: 'clay',
    peopleVariant: 'with_people',
    width: shot.exportSettings.width,
    height: shot.exportSettings.height,
  };
}

describe('hookless export recovery live access', () => {
  beforeEach(() => {
    resetLiveProjectAccessForTests();
    resetPrepareStillArtifactInflightForTests();
    resetProjectAssetStoreForTests();
    renderWorkCoordinator.resetForTests();
  });

  afterEach(() => {
    resetLiveProjectAccessForTests();
    resetPrepareStillArtifactInflightForTests();
    resetProjectAssetStoreForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('commits a V2-style recovery to the active project so the next export is warm', async () => {
    let live = createDefaultProject();
    const shotId = live.shots[0]!.id;
    const specification = claySpec(live);
    const render = vi.fn(async () => ({
      blob: new Blob(['recovered'], { type: 'image/png' }),
      width: specification.width,
      height: specification.height,
      mimeType: 'image/png' as const,
    }));

    const unbind = bindLiveProjectAccess({
      getProject: () => live,
      commitProject: (updater) => {
        live = updater(live);
        return live;
      },
    });

    const frozenBeforeRecovery = structuredClone(live);
    const first = await ensureStillArtifactForExport({
      frozenProject: frozenBeforeRecovery,
      shotId,
      specification,
      render,
    });

    expect(first.source).toBe('render-recovery');
    expect(render).toHaveBeenCalledTimes(1);
    expect(first.assetId).toBeTruthy();
    expect(live.shots[0]!.materializedMedia).toBeDefined();
    expect(live.assets.assets[first.assetId!]).toBeDefined();

    const secondRender = vi.fn(async () => {
      throw new Error('warm export should not render');
    });
    const second = await ensureStillArtifactForExport({
      frozenProject: structuredClone(live),
      shotId,
      specification,
      render: secondRender,
    });

    expect(second.source).toBe('materialized-asset');
    expect(secondRender).not.toHaveBeenCalled();
    unbind();
  });
});
