import { describe, expect, it, vi } from 'vitest';
import { createDefaultProject, createTransform } from '../src/domain/defaults';

let hydrated = false;

vi.mock('../src/engine/modelAssetStore', () => ({
  hydrateModelAssetKeys: vi.fn(async (keys: readonly string[]) => {
    expect(keys).toEqual(['recovery-resource/model/persisted']);
    hydrated = true;
    return [];
  }),
}));

import { prepareStillArtifact } from '../src/engine/prepareStillArtifact';

describe('prepareStillArtifact model hydration', () => {
  it('hydrates durable model keys before invoking the synchronous renderer', async () => {
    hydrated = false;
    const project = createDefaultProject();
    project.assets.assets.model = {
      id: 'model',
      type: 'model',
      name: 'Persisted model',
      uri: 'panoref-idb:recovery-resource/model/persisted',
      resolutionStatus: 'available',
      createdAt: new Date(0).toISOString(),
    };
    project.scene.objects.push({
      id: 'model-object',
      name: 'Persisted object',
      type: 'imported_model',
      transform: createTransform(),
      dimensions: [1, 1, 1],
      category: 'environment',
      locked: false,
      visible: true,
      modelAssetId: 'model',
    });
    const shot = project.shots[0]!;
    const render = vi.fn(async () => {
      expect(hydrated).toBe(true);
      return {
        blob: new Blob(['rendered'], { type: 'image/png' }),
        width: shot.exportSettings.width,
        height: shot.exportSettings.height,
        mimeType: 'image/png' as const,
      };
    });

    await prepareStillArtifact({
      projectSnapshot: project,
      shotId: shot.id,
      specification: {
        kind: 'clay-viewport',
        appearance: 'clay',
        peopleVariant: 'with_people',
        width: shot.exportSettings.width,
        height: shot.exportSettings.height,
      },
      force: true,
      render,
    });

    expect(render).toHaveBeenCalledOnce();
  });
});
