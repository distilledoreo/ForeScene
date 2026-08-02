import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createCameraKeyframe } from '../src/domain/defaults';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import {
  CURRENT_SCHEMA_VERSION,
  collectPendingInlineProjectAssets,
  listMigrationPath,
  migrateProjectToCurrent,
  migrateProjectToCurrentResult,
  projectManifestHasEmbeddedKeyframeDataUrls,
  stripEphemeralKeyframePreviewUris,
} from '../src/engine/schemaMigrations';
import { commitKeyframePreviewAsset } from '../src/engine/keyframePreviewAssets';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import { getShotPackageBaseName } from '../src/engine/exportNaming';
import {
  getProjectAssetBlob,
  listProjectAssetBlobKeys,
  resetProjectAssetStoreForTests,
} from '../src/engine/projectAssetStore';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'schema');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('schema migrations', () => {
  afterEach(() => {
    resetProjectAssetStoreForTests();
  });

  it('lists ordered path 0.1 → 0.2 → 1.0', () => {
    const path = listMigrationPath('0.1', '1.0');
    expect(path.map((step) => `${step.from}->${step.to}`)).toEqual(['0.1->0.2', '0.2->1.0']);
    expect(CURRENT_SCHEMA_VERSION).toBe('1.1');
  });

  it('migrates fixture 0.1 → current, save → reopen → export', async () => {
    const raw = readFileSync(join(fixturesDir, 'project-schema-0.1.json'), 'utf8');
    const loaded = parseProject(raw);
    expect(loaded.schemaVersion).toBe('1.1');
    expect(loaded.productVersion).toBe('0.1.0');
    expect(loaded.shots[0]?.camera.position[1]).toBeCloseTo(1.6, 5);

    const saved = serializeProject(loaded);
    const reopened = parseProject(saved);
    expect(reopened.schemaVersion).toBe('1.1');
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
    expect(JSON.parse(serializeProject(reopened)).schemaVersion).toBe('1.1');
  });

  it('parse/migrate leave local asset storage untouched (pure validators)', async () => {
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
            previewUri: TINY_PNG,
          }],
        };
      }),
    };

    const beforeKeys = await listProjectAssetBlobKeys();
    const result = migrateProjectToCurrentResult(project);
    const parsed = parseProject(JSON.stringify(project));
    const afterKeys = await listProjectAssetBlobKeys();

    expect(afterKeys).toEqual(beforeKeys);
    expect(result.pendingAssets.length).toBe(1);
    expect(result.pendingAssets[0]?.blob).toBeInstanceOf(Blob);
    expect(result.project.assets.assets[result.pendingAssets[0]!.asset.id]?.uri.startsWith('data:')).toBe(true);

    const kf = parsed.shots[0]?.cameraKeyframes[0];
    expect(kf?.previewAssetId).toBeTruthy();
    const asset = parsed.assets.assets[kf!.previewAssetId!];
    expect(asset?.uri.startsWith('data:')).toBe(true);
    // Planned key is recorded but not written until accept/hydrate.
    expect(asset?.storageKey).toBeTruthy();
    expect(await getProjectAssetBlob(asset!.storageKey!)).toBeUndefined();
    expect(collectPendingInlineProjectAssets(parsed).length).toBe(1);
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
            previewUri: TINY_PNG,
          }],
        };
      }),
    };

    const migrated = migrateProjectToCurrent(project);
    expect(migrated.schemaVersion).toBe('1.1');
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
    const committed = commitKeyframePreviewAsset({
      project: withKf,
      shotId: shot.id,
      keyframeId: keyframe.id,
      dataUrl: TINY_PNG,
    });
    expect(committed).toBeDefined();
    const json = serializeProject(committed!.project);
    expect(projectManifestHasEmbeddedKeyframeDataUrls(json)).toBe(false);
    const reopened = parseProject(json);
    const stored = reopened.shots[0]?.cameraKeyframes[0];
    expect(stored?.previewAssetId).toBe(committed!.previewAssetId);
  });

  it('commitKeyframePreviewAsset reuses preview asset id and does not leak manifests', () => {
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
    const first = commitKeyframePreviewAsset({
      project: withKf,
      shotId: shot.id,
      keyframeId: keyframe.id,
      dataUrl: TINY_PNG,
    });
    expect(first).toBeDefined();
    const second = commitKeyframePreviewAsset({
      project: first!.project,
      shotId: shot.id,
      keyframeId: keyframe.id,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC',
    });
    expect(second).toBeDefined();
    expect(second!.previewAssetId).toBe(first!.previewAssetId);
    expect(Object.keys(second!.project.assets.assets).filter((id) => id === first!.previewAssetId)).toHaveLength(1);
    // Only one keyframe preview asset should remain referenced for that keyframe.
    const previewIds = second!.project.shots[0]!.cameraKeyframes
      .map((kf) => kf.previewAssetId)
      .filter(Boolean);
    expect(new Set(previewIds).size).toBe(previewIds.length);
    const orphanPreviews = Object.values(second!.project.assets.assets).filter((asset) => (
      asset.name.startsWith('keyframe-preview-') && !previewIds.includes(asset.id)
    ));
    expect(orphanPreviews).toHaveLength(0);
  });
});
