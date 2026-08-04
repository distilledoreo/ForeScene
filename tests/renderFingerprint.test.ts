import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  computeRenderFingerprint,
  createRenderCacheIndex,
  explainRenderCacheHit,
  invalidateRenderDependencies,
  inspectRenderCache,
  recordRenderCacheEntry,
  type RenderFingerprint,
} from '../src/engine/previs/renderCache';
import { RAPID_REVIEW_PROFILE } from '../src/engine/previs/renderProfiles';
import {
  clearAgentRenderCache,
  explainAgentRenderCacheHit,
  inspectAgentRenderCache,
  invalidateAgentRenderDependencies,
  recordAgentRenderCacheEntry,
  resetAgentRenderCacheForTests,
} from '../src/engine/agent/renderCacheControl';

describe('content-addressed render fingerprints', () => {
  it('changes for camera and relevant staging edits but not unused dynamic objects', () => {
    const project = createDefaultProject();
    const subject = createSceneObject('box', 1, [0, 1, 0]);
    subject.name = 'subject';
    subject.productionClass = 'dynamic_subject';
    const unused = createSceneObject('box', 1, [4, 1, 0]);
    unused.name = 'unused';
    unused.productionClass = 'dynamic_subject';
    project.scene.objects = [subject, unused];
    const shot = project.shots[0]!;
    shot.objectOverrides = { [subject.id]: { visible: true } };

    const first = computeRenderFingerprint({ project, shot, profile: RAPID_REVIEW_PROFILE });
    unused.transform.position[0] += 2;
    const unchanged = computeRenderFingerprint({ project, shot, profile: RAPID_REVIEW_PROFILE });
    expect(unchanged.key).toBe(first.key);

    shot.camera.fovDegrees += 4;
    const cameraChanged = computeRenderFingerprint({ project, shot, profile: RAPID_REVIEW_PROFILE });
    expect(cameraChanged.key).not.toBe(first.key);
    expect(cameraChanged.dependencyIds).toContain(`object:${subject.id}`);
  });

  it('explains hits and invalidates dependent entries', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const fingerprint = computeRenderFingerprint({ project, shot, profile: RAPID_REVIEW_PROFILE });
    let cache = createRenderCacheIndex();
    cache = recordRenderCacheEntry(cache, fingerprint, {
      artifactPath: 'shots/001.png',
      sourceRevisionId: 'revision-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(explainRenderCacheHit(cache, fingerprint).hit).toBe(true);

    cache = invalidateRenderDependencies(cache, fingerprint.dependencyIds.slice(0, 1));
    expect(explainRenderCacheHit(cache, fingerprint).hit).toBe(false);
    expect(inspectRenderCache(cache).invalidatedEntries).toBe(1);
  });

  it('exposes the same cache lifecycle through the browser adapter', () => {
    const projectId = 'browser-cache-test';
    resetAgentRenderCacheForTests();
    const fingerprint: RenderFingerprint = {
      key: 'render:browser-cache-test',
      dependencyIds: ['shot:shot-1', 'object:subject-1'],
      details: {
        rendererVersion: 'test',
        renderProfile: 'rapid-review',
        shotId: 'shot-1',
        timeSeconds: 0,
      },
    };

    recordAgentRenderCacheEntry({ projectId, fingerprint, artifactId: 'artifact-1' });
    expect(inspectAgentRenderCache({ projectId }).readyEntries).toBe(1);
    expect(explainAgentRenderCacheHit({ projectId, fingerprint }).hit).toBe(true);

    invalidateAgentRenderDependencies({ projectId, dependencyIds: ['object:subject-1'] });
    expect(explainAgentRenderCacheHit({ projectId, fingerprint }).hit).toBe(false);
    expect(inspectAgentRenderCache({ projectId }).invalidatedEntries).toBe(1);
    expect(clearAgentRenderCache({ projectId }).totalEntries).toBe(0);
  });
});
