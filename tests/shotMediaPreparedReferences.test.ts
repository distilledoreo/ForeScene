import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { resolveShotMedia } from '../src/domain/shotMedia';
import type { MaterializedStillArtifact, ProjectAsset } from '../src/domain/types';

function imageAsset(id: string, name: string): ProjectAsset {
  return {
    id,
    type: 'image',
    name,
    uri: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    width: 64,
    height: 36,
    createdAt: new Date(0).toISOString(),
  };
}

function stillArtifact(
  id: string,
  key: string,
  assetId: string,
  kind: MaterializedStillArtifact['kind'],
  appearance: MaterializedStillArtifact['appearance'],
): MaterializedStillArtifact {
  return {
    id,
    key,
    kind,
    assetId,
    fingerprint: `fp:${id}`,
    dependencyIds: [],
    width: 64,
    height: 36,
    mimeType: 'image/png',
    appearance,
    peopleVariant: 'with_people',
    createdAt: new Date(0).toISOString(),
  };
}

describe('shot media prepared references', () => {
  it('keeps the primary viewport in its existing captured-still UI and adds other prepared references', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const primary = imageAsset('asset-primary', 'primary.png');
    const depth = imageAsset('asset-depth', 'depth.png');
    project.assets.assets[primary.id] = primary;
    project.assets.assets[depth.id] = depth;
    shot.assets.viewportRenderAssetId = primary.id;
    shot.materializedMedia = {
      stills: {
        primary: stillArtifact(
          'still-primary',
          'clay-viewport:clay:with_people',
          primary.id,
          'clay-viewport',
          'clay',
        ),
        depth: stillArtifact(
          'still-depth',
          'depth-viewport:depth:with_people',
          depth.id,
          'depth-viewport',
          'depth',
        ),
      },
    };

    const media = resolveShotMedia(project, shot);
    expect(media.filter((item) => item.asset.id === primary.id)).toHaveLength(1);
    expect(media.find((item) => item.asset.id === primary.id)?.source).toBe('captured_still');
    expect(media.find((item) => item.asset.id === depth.id)).toMatchObject({
      source: 'prepared_reference',
      label: 'Depth viewport · with people',
    });
  });
});
