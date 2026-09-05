import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createTransform } from '../src/domain/defaults';
import { prepareModelAssetsForRender } from '../src/engine/prepareModelAssetsForRender';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';

describe('prepareModelAssetsForRender', () => {
  beforeEach(resetModelAssetStoreForTests);

  it('fails closed with object and asset diagnostics when persisted bytes are unavailable', async () => {
    const project = createDefaultProject();
    project.assets.assets.model = {
      id: 'model',
      type: 'model',
      name: 'Missing recovery model',
      uri: 'panoref-idb:recovery-resource/model/missing',
      resolutionStatus: 'available',
      createdAt: new Date(0).toISOString(),
    };
    project.scene.objects.push({
      id: 'model-object',
      name: 'Required creature',
      type: 'imported_model',
      transform: createTransform(),
      dimensions: [1, 1, 1],
      category: 'environment',
      locked: false,
      visible: true,
      modelAssetId: 'model',
    });

    await expect(prepareModelAssetsForRender(project)).rejects.toThrow(
      'Required model asset bytes are unavailable for rendering: recovery-resource/model/missing',
    );
  });

  it('fails before rendering when a scene object references no asset record', async () => {
    const project = createDefaultProject();
    project.scene.objects.push({
      id: 'model-object',
      name: 'Required creature',
      type: 'imported_model',
      transform: createTransform(),
      dimensions: [1, 1, 1],
      category: 'environment',
      locked: false,
      visible: true,
      modelAssetId: 'absent-model',
    });

    await expect(prepareModelAssetsForRender(project)).rejects.toThrow(
      'Scene object "Required creature" (model-object) references missing model asset "absent-model"',
    );
  });

  it('does not block a resolved shot on an unrelated hidden model', async () => {
    const project = createDefaultProject();
    project.scene.objects.push({
      id: 'hidden-model-object',
      name: 'Hidden model',
      type: 'imported_model',
      transform: createTransform(),
      dimensions: [1, 1, 1],
      category: 'environment',
      locked: false,
      visible: false,
      modelAssetId: 'absent-hidden-model',
    });

    await expect(prepareModelAssetsForRender(project)).resolves.toBeUndefined();
  });
});
