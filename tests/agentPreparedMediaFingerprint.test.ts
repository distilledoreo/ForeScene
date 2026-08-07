import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { commitPreparedStillArtifact } from '../src/engine/commitPreparedStillArtifact';
import { projectFingerprint } from '../src/engine/agent/planDiff';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

describe('agent authored-state fingerprint vs prepared media', () => {
  beforeEach(() => resetProjectAssetStoreForTests());
  afterEach(() => resetProjectAssetStoreForTests());

  it('ignores a derived prepared still but still detects authored camera edits', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const specification: StillArtifactSpecification = {
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'with_people',
      width: shot.exportSettings.width,
      height: shot.exportSettings.height,
    };
    const preparedFingerprint = computeStillArtifactFingerprint(project, shot, specification);
    const authoredBefore = projectFingerprint(project);

    const committed = await commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification,
      expectedFingerprint: preparedFingerprint.key,
      prepared: {
        fingerprint: preparedFingerprint,
        artifactKey: stillArtifactKey(specification),
        blob: new Blob(['prepared-reference'], { type: 'image/png' }),
        width: specification.width,
        height: specification.height,
        mimeType: 'image/png',
        cacheStatus: 'rendered',
      },
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    expect(projectFingerprint(committed.project)).toBe(authoredBefore);

    const cameraEdited = {
      ...committed.project,
      shots: committed.project.shots.map((item) =>
        item.id === shot.id
          ? {
            ...item,
            camera: {
              ...item.camera,
              fovDegrees: item.camera.fovDegrees + 1,
            },
          }
          : item
      ),
    };
    expect(projectFingerprint(cameraEdited)).not.toBe(authoredBefore);
  });
});