import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefaultProject, createCameraKeyframe } from '../src/domain/defaults';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import {
  CURRENT_SCHEMA_VERSION,
  listMigrationPath,
  migrateProjectToCurrent,
  projectManifestHasEmbeddedKeyframeDataUrls,
  stripEphemeralKeyframePreviewUris,
} from '../src/engine/schemaMigrations';
import { commitKeyframePreviewAsset } from '../src/engine/keyframePreviewAssets';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import { getShotPackageBaseName } from '../src/engine/exportNaming';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'schema');

describe('schema migrations', () => {
  it('lists ordered path 0.1 → 0.2 → 1.0', () => {
    const path = listMigrationPath('0.1', '1.0');
    expect(path.map((step) => `${step.from}->${step.to}`)).toEqual(['0.1->0.2', '0.2->1.0']);
    expect(CURRENT_SCHEMA_VERSION).toBe('1.0');
  });

  it('migrates fixture 0.1 → current, save → reopen → export', async () => {
    const raw = readFileSync(join(fixturesDir, 'project-schema-0.1.json'), 'utf8');
    const loaded = parseProject(raw);
    expect(loaded.schemaVersion).toBe('1.0');
    expect(loaded.productVersion).toBe('0.1.0');
    expect(loaded.shots[0]?.camera.position[1]).toBeCloseTo(1.6, 5);

    const saved = serializeProject(loaded);
    const reopened = parseProject(saved);
    expect(reopened.schemaVersion).toBe('1.0');
    expect(reopened.name).toBe(loaded.name);
    expect(reopened.shots.length).toBe(loaded.shots.length);

    // Export path after migrate → save → reopen: real package manifest builder (no WebGL in unit env).
    const shot = reopened.shots[0];
    expect(shot).toBeDefined();
    const manifest = createShotPackageManifest(reopened, shot);
    expect(manifest).toBeTruthy();
    expect(Object.keys(manifest as object).length).toBeGreaterThan(0);
    expect(getShotPackageBaseName(shot).length).toBeGreaterThan(0);
    // Portable JSON after migration must remain parseable for package handoff.
    expect(JSON.parse(serializeProject(reopened)).schemaVersion).toBe('1.0');
  });

  it('migrates keyframe data URL previews into assets (no embedded data URLs in manifest)', () => {
    let project = createDefaultProject();
    project = {
      ...project,
      schemaVersion: '0.1',
      shots: project.shots.map((shot, index) => {
        if (index !== 0) return shot;
        const keyframe = createCameraKeyframe({
          label: 'Start',
          timeSeconds: 0,
          camera: shot.camera,
        });
        return {
          ...shot,
          cameraKeyframes: [{
            ...keyframe,
            previewUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          }],
        };
      }),
    };

    const migrated = migrateProjectToCurrent(project);
    expect(migrated.schemaVersion).toBe('1.0');
    const kf = migrated.shots[0]?.cameraKeyframes[0];
    expect(kf?.previewAssetId).toBeTruthy();
    expect(migrated.assets.assets[kf!.previewAssetId!]).toBeTruthy();

    const portable = stripEphemeralKeyframePreviewUris(migrated);
    const json = serializeProject(portable);
    expect(projectManifestHasEmbeddedKeyframeDataUrls(json)).toBe(false);
    expect(json).not.toMatch(/"previewUri"\s*:\s*"data:/);
  });

  it('commitKeyframePreviewAsset avoids data URLs in serialized project', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const keyframe = createCameraKeyframe({
      label: 'Start',
      timeSeconds: 0,
      camera: shot.camera,
    });
    const withKf = {
      ...project,
      shots: [{ ...shot, cameraKeyframes: [keyframe] }],
    };
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const committed = commitKeyframePreviewAsset({
      project: withKf,
      shotId: shot.id,
      keyframeId: keyframe.id,
      dataUrl: tinyPng,
    });
    expect(committed).toBeDefined();
    const json = serializeProject(committed!.project);
    expect(projectManifestHasEmbeddedKeyframeDataUrls(json)).toBe(false);
    const reopened = parseProject(json);
    const stored = reopened.shots[0]?.cameraKeyframes[0];
    expect(stored?.previewAssetId).toBe(committed!.previewAssetId);
  });
});
