import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { MaterializedStillArtifact } from '../src/domain/types';
import { getReferencedProjectAssetIds, pruneUnreferencedProjectAssets } from '../src/engine/projectAssets';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import {
  stillArtifactKey,
  type StillArtifactSpecification,
} from '../src/engine/stillArtifactTypes';

function stillSpec(
  kind: StillArtifactSpecification['kind'],
  appearance: StillArtifactSpecification['appearance'],
  extra: Partial<StillArtifactSpecification> = {},
): StillArtifactSpecification {
  return {
    kind,
    appearance,
    width: 1920,
    height: 1080,
    ...extra,
  };
}

describe('stillArtifactKey', () => {
  it('includes appearance so clay and projected character stills do not collide', () => {
    const clay = stillSpec('character-still', 'clay', { contentMode: 'characters_only' });
    const projected = stillSpec('character-still', 'projected', { contentMode: 'characters_only' });

    expect(stillArtifactKey(clay)).toBe('character-still:clay:characters_only');
    expect(stillArtifactKey(projected)).toBe('character-still:projected:characters_only');
    expect(stillArtifactKey(clay)).not.toBe(stillArtifactKey(projected));
  });

  it('includes appearance for viewport and reference-frame kinds', () => {
    expect(stillArtifactKey(stillSpec('clay-viewport', 'clay', { peopleVariant: 'with_people' })))
      .toBe('clay-viewport:clay:with_people');
    expect(stillArtifactKey(stillSpec('projected-viewport', 'projected', { peopleVariant: 'clean_plate' })))
      .toBe('projected-viewport:projected:clean_plate');
    expect(stillArtifactKey(stillSpec('depth-viewport', 'depth', { peopleVariant: 'with_people' })))
      .toBe('depth-viewport:depth:with_people');
    expect(stillArtifactKey(stillSpec('clay-reference-frame', 'clay', {
      peopleVariant: 'with_people',
      frameRole: 'start',
      timeSeconds: 0,
    }))).toBe('clay-reference-frame:clay:with_people:start');
  });

  it('prefers frameRole over raw timeSeconds in the key', () => {
    const withRole = stillSpec('depth-reference-frame', 'depth', {
      peopleVariant: 'clean_plate',
      frameRole: 'middle',
      timeSeconds: 1.25,
    });
    const withTimeOnly = stillSpec('depth-reference-frame', 'depth', {
      peopleVariant: 'clean_plate',
      timeSeconds: 1.25,
    });
    expect(stillArtifactKey(withRole)).toBe('depth-reference-frame:depth:clean_plate:middle');
    expect(stillArtifactKey(withTimeOnly)).toBe('depth-reference-frame:depth:clean_plate:1.25');
  });
});

describe('computeStillArtifactFingerprint', () => {
  it('produces the same key for identical inputs', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = stillSpec('clay-viewport', 'clay', { peopleVariant: 'with_people' });
    expect(computeStillArtifactFingerprint(project, shot, spec).key)
      .toBe(computeStillArtifactFingerprint(project, shot, spec).key);
  });

  it('invalidates when camera FOV changes', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = stillSpec('clay-viewport', 'clay', { peopleVariant: 'with_people' });
    const before = computeStillArtifactFingerprint(project, shot, spec).key;
    shot.camera.fovDegrees += 5;
    expect(computeStillArtifactFingerprint(project, shot, spec).key).not.toBe(before);
  });

  it('invalidates when people variant or content mode changes', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const withPeople = computeStillArtifactFingerprint(
      project,
      shot,
      stillSpec('clay-viewport', 'clay', { peopleVariant: 'with_people' }),
    ).key;
    const cleanPlate = computeStillArtifactFingerprint(
      project,
      shot,
      stillSpec('clay-viewport', 'clay', { peopleVariant: 'clean_plate' }),
    ).key;
    expect(withPeople).not.toBe(cleanPlate);
  });

  it('invalidates when appearance changes for the same kind', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const clay = computeStillArtifactFingerprint(
      project,
      shot,
      stillSpec('character-still', 'clay', { contentMode: 'characters_only' }),
    ).key;
    const projected = computeStillArtifactFingerprint(
      project,
      shot,
      stillSpec('character-still', 'projected', { contentMode: 'characters_only' }),
    ).key;
    expect(clay).not.toBe(projected);
  });

  it('includes manual depth range and invert in depth fingerprints', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const spec = stillSpec('depth-viewport', 'depth', { peopleVariant: 'with_people' });

    shot.exportSettings.depth = {
      enabled: true,
      includeViewportStill: true,
      includeReferenceFrames: false,
      includeCameraMoveVideo: false,
      rangeMode: 'manual',
      nearMeters: 0.5,
      farMeters: 12,
      invert: false,
    };
    const base = computeStillArtifactFingerprint(project, shot, spec).key;

    shot.exportSettings.depth = {
      ...shot.exportSettings.depth,
      invert: true,
    };
    const inverted = computeStillArtifactFingerprint(project, shot, spec).key;
    expect(inverted).not.toBe(base);

    shot.exportSettings.depth = {
      ...shot.exportSettings.depth,
      invert: false,
      farMeters: 20,
    };
    const rangeChanged = computeStillArtifactFingerprint(project, shot, spec).key;
    expect(rangeChanged).not.toBe(base);
  });

  it('invalidates when shot object overrides change', () => {
    const project = createDefaultProject();
    const subject = createSceneObject('box', 1, [0, 1, 0]);
    project.scene.objects = [subject];
    const shot = project.shots[0]!;
    shot.objectOverrides = { [subject.id]: { visible: true } };
    const spec = stillSpec('clay-viewport', 'clay', { peopleVariant: 'with_people' });
    const before = computeStillArtifactFingerprint(project, shot, spec).key;

    shot.objectOverrides = {
      [subject.id]: {
        visible: true,
        transform: {
          ...subject.transform,
          position: [2, 1, 0],
        },
      },
    };
    expect(computeStillArtifactFingerprint(project, shot, spec).key).not.toBe(before);
  });

  it('excludes person objects from clean-plate dependency selection', () => {
    const project = createDefaultProject();
    const prop = createSceneObject('box', 1, [0, 1, 0]);
    prop.name = 'prop';
    const person = createSceneObject('box', 1, [1, 1, 0]);
    person.name = 'actor';
    person.stagingRole = 'person';
    project.scene.objects = [prop, person];
    const shot = project.shots[0]!;

    const full = computeStillArtifactFingerprint(
      project,
      shot,
      stillSpec('clay-viewport', 'clay', { peopleVariant: 'with_people' }),
    );
    const clean = computeStillArtifactFingerprint(
      project,
      shot,
      stillSpec('clay-viewport', 'clay', { peopleVariant: 'clean_plate' }),
    );

    expect(full.dependencyIds).toContain(`object:${person.id}`);
    expect(clean.dependencyIds).not.toContain(`object:${person.id}`);
    expect(clean.dependencyIds).toContain(`object:${prop.id}`);
    expect(full.key).not.toBe(clean.key);
  });
});

describe('materialized still asset GC references', () => {
  it('retains derived still asset ids through project asset pruning', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const assetId = 'derived-still-asset';
    project.assets.assets[assetId] = {
      id: assetId,
      type: 'image',
      name: 'shot-still.png',
      uri: '',
      mimeType: 'image/png',
      width: 1920,
      height: 1080,
      createdAt: new Date().toISOString(),
      metadata: { provenance: 'forescene-derived-still' },
    };
    const artifact: MaterializedStillArtifact = {
      id: 'still-1',
      key: 'clay-viewport:clay:with_people',
      kind: 'clay-viewport',
      assetId,
      fingerprint: 'still:test',
      dependencyIds: [`shot:${shot.id}`],
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
      peopleVariant: 'with_people',
      appearance: 'clay',
      createdAt: new Date().toISOString(),
    };
    shot.materializedMedia = { stills: { [artifact.key]: artifact } };

    expect(getReferencedProjectAssetIds(project).has(assetId)).toBe(true);
    const pruned = pruneUnreferencedProjectAssets(project);
    expect(pruned.assets.assets[assetId]).toBeDefined();
  });
});
