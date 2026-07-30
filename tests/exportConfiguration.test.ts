import { describe, expect, it } from 'vitest';
import {
  createDefaultExportConfiguration,
  createDefaultProject,
  createShot,
  defaultShotExportSettings,
  normalizeShotExportSettings,
} from '../src/domain/defaults';
import type { LocationProject, Shot, ShotExportSettings } from '../src/domain/types';
import { EXPORT_CONFIGURATION_SCHEMA_VERSION } from '../src/domain/types';
import {
  copyShotExportOverrides,
  diffExportSettings,
  ensureProjectExportConfiguration,
  getExportFieldInheritanceState,
  isExportFieldOverridden,
  isExportSettingsOverrideEmpty,
  migrateProjectExportConfiguration,
  normalizeExportSettingsOverride,
  patchSceneExportDefaults,
  promoteShotExportToSceneDefaults,
  resetShotExportField,
  resetShotExportOverrides,
  resolveExportSettings,
  resolveShotExportSettings,
  setSceneExportDefaults,
  setShotExportOverride,
  syncShotExportFromResolved,
} from '../src/engine/exportConfiguration';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import { parseProject, serializeProject } from '../src/engine/projectIO';

function cloneProject(): LocationProject {
  return structuredClone(createDefaultProject());
}

function addShot(project: LocationProject, index: number): Shot {
  const camera = structuredClone(project.shots[0]!.camera);
  return createShot({
    index,
    camera,
    exportDefaults: project.exportConfiguration?.defaults,
  });
}

describe('export settings resolver', () => {
  it('inherits all scene defaults when overrides are empty', () => {
    const defaults = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      width: 1920,
      height: 1080,
      depth: { ...defaultShotExportSettings.depth!, enabled: true },
    });
    const resolved = resolveExportSettings(defaults, {});
    expect(resolved).toEqual(defaults);
    expect(resolved.depth?.enabled).toBe(true);
  });

  it('preserves explicit boolean false overrides', () => {
    const defaults = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      includeViewport: true,
      includePrompt: true,
    });
    const resolved = resolveExportSettings(defaults, {
      includeViewport: false,
      includePrompt: false,
      characterPass: { enabled: false, includeStill: false },
      depth: { enabled: false, includeViewportStill: false },
    });
    expect(resolved.includeViewport).toBe(false);
    expect(resolved.includePrompt).toBe(false);
    expect(resolved.characterPass?.enabled).toBe(false);
    expect(resolved.characterPass?.includeStill).toBe(false);
    expect(resolved.depth?.enabled).toBe(false);
    expect(resolved.depth?.includeViewportStill).toBe(false);
    // Unmentioned nested fields still inherit.
    expect(resolved.characterPass?.includeMotion).toBe(true);
    expect(resolved.depth?.includeReferenceFrames).toBe(true);
  });

  it('applies numeric and enum overrides without shallow-spreading nested objects away', () => {
    const defaults = normalizeShotExportSettings(defaultShotExportSettings);
    const resolved = resolveExportSettings(defaults, {
      width: 1280,
      height: 720,
      peopleExportMode: 'both',
      characterPass: {
        enabled: true,
        motionFormat: 'transparent_png_sequence',
        backgroundColor: '#FF00FF',
      },
      depth: {
        enabled: true,
        rangeMode: 'manual',
        nearMeters: 0.5,
        farMeters: 40,
        invert: true,
      },
    });
    expect(resolved.width).toBe(1280);
    expect(resolved.height).toBe(720);
    expect(resolved.peopleExportMode).toBe('both');
    expect(resolved.characterPass).toMatchObject({
      enabled: true,
      includeStill: true,
      includeMotion: true,
      motionFormat: 'transparent_png_sequence',
      backgroundColor: '#FF00FF',
      includeAttachedProps: true,
    });
    expect(resolved.depth).toMatchObject({
      enabled: true,
      includeViewportStill: true,
      includeReferenceFrames: true,
      includeCameraMoveVideo: true,
      rangeMode: 'manual',
      nearMeters: 0.5,
      farMeters: 40,
      invert: true,
    });
  });

  it('diffs only changed leaves into a sparse override', () => {
    const defaults = normalizeShotExportSettings(defaultShotExportSettings);
    const resolved = resolveExportSettings(defaults, {
      includeFullPano: false,
      depth: { enabled: true },
    });
    const override = diffExportSettings(defaults, resolved);
    expect(override).toEqual({
      includeFullPano: false,
      depth: { enabled: true },
    });
    expect(isExportSettingsOverrideEmpty(override)).toBe(false);
    expect(isExportSettingsOverrideEmpty({})).toBe(true);
  });
});

describe('export settings operations', () => {
  it('resets one field back to scene inheritance', () => {
    let project = cloneProject();
    const shotId = project.shots[0]!.id;
    project = setShotExportOverride(project, shotId, {
      includeViewport: false,
      depth: { enabled: true },
    });
    expect(project.shots[0]!.exportSettings.includeViewport).toBe(false);
    expect(project.shots[0]!.exportSettings.depth?.enabled).toBe(true);

    project = resetShotExportField(project, shotId, 'includeViewport');
    expect(project.shots[0]!.exportOverrides?.includeViewport).toBeUndefined();
    expect(project.shots[0]!.exportSettings.includeViewport).toBe(true);
    expect(project.shots[0]!.exportSettings.depth?.enabled).toBe(true);

    project = resetShotExportField(project, shotId, 'depth.enabled');
    expect(project.shots[0]!.exportOverrides?.depth).toBeUndefined();
    expect(project.shots[0]!.exportSettings.depth?.enabled).toBe(false);
  });

  it('resets an entire shot to scene settings', () => {
    let project = cloneProject();
    const shotId = project.shots[0]!.id;
    project = setShotExportOverride(project, shotId, {
      width: 1920,
      includeMetadata: false,
      characterPass: { enabled: true },
    });
    project = resetShotExportOverrides(project, shotId);
    expect(project.shots[0]!.exportOverrides).toEqual({});
    expect(project.shots[0]!.exportSettings).toEqual(project.exportConfiguration!.defaults);
  });

  it('copies overrides to other shots and reports mixed inheritance', () => {
    let project = cloneProject();
    const first = project.shots[0]!;
    const second = addShot(project, 2);
    const third = addShot(project, 3);
    project = { ...project, shots: [first, second, third] };

    project = setShotExportOverride(project, first.id, {
      includeGrayboxPano: false,
      depth: { enabled: true },
    });
    project = copyShotExportOverrides(project, first.id, [second.id]);

    expect(project.shots[1]!.exportOverrides).toEqual(project.shots[0]!.exportOverrides);
    expect(project.shots[1]!.exportSettings.includeGrayboxPano).toBe(false);
    expect(project.shots[2]!.exportOverrides).toEqual({});

    expect(getExportFieldInheritanceState(project.shots, 'includeGrayboxPano')).toBe('mixed');
    expect(getExportFieldInheritanceState([project.shots[0]!, project.shots[1]!], 'depth.enabled'))
      .toBe('overridden');
    expect(isExportFieldOverridden(project.shots[2]!.exportOverrides, 'includeGrayboxPano')).toBe(false);
  });

  it('changing scene defaults updates non-overridden shots only', () => {
    let project = cloneProject();
    const first = project.shots[0]!;
    const second = addShot(project, 2);
    project = { ...project, shots: [first, second] };

    project = setShotExportOverride(project, first.id, { width: 1280 });
    project = patchSceneExportDefaults(project, { width: 1920, height: 1080 });

    expect(project.exportConfiguration!.defaults.width).toBe(1920);
    expect(project.exportConfiguration!.defaults.height).toBe(1080);
    expect(project.shots[0]!.exportSettings.width).toBe(1280);
    expect(project.shots[0]!.exportSettings.height).toBe(1080);
    expect(project.shots[1]!.exportSettings.width).toBe(1920);
    expect(project.shots[1]!.exportSettings.height).toBe(1080);
  });

  it('promotes a shot’s resolved settings to scene defaults without changing others’ resolved output', () => {
    let project = cloneProject();
    const first = project.shots[0]!;
    const second = addShot(project, 2);
    project = { ...project, shots: [first, second] };

    project = setShotExportOverride(project, first.id, {
      includeViewport: false,
      depth: { enabled: true },
    });
    project = setShotExportOverride(project, second.id, {
      includePrompt: false,
    });

    const beforeFirst = structuredClone(project.shots[0]!.exportSettings);
    const beforeSecond = structuredClone(project.shots[1]!.exportSettings);

    project = promoteShotExportToSceneDefaults(project, first.id);

    expect(project.exportConfiguration!.defaults).toEqual(beforeFirst);
    expect(project.shots[0]!.exportOverrides).toEqual({});
    expect(project.shots[0]!.exportSettings).toEqual(beforeFirst);
    expect(project.shots[1]!.exportSettings).toEqual(beforeSecond);
    expect(project.shots[1]!.exportOverrides).toEqual({
      includeViewport: true,
      includePrompt: false,
      depth: { enabled: false },
    });
  });

  it('syncs legacy resolved exportSettings edits into sparse overrides', () => {
    let project = cloneProject();
    const shotId = project.shots[0]!.id;
    const nextResolved: ShotExportSettings = normalizeShotExportSettings({
      ...project.exportConfiguration!.defaults,
      includeCameraMoveVideo: false,
      characterPass: {
        ...project.exportConfiguration!.defaults.characterPass!,
        enabled: true,
        motionFormat: 'both',
      },
    });
    project = syncShotExportFromResolved(project, shotId, nextResolved);
    expect(project.shots[0]!.exportOverrides).toEqual({
      includeCameraMoveVideo: false,
      characterPass: { enabled: true, motionFormat: 'both' },
    });
    expect(resolveShotExportSettings(project, project.shots[0]!)).toEqual(nextResolved);
  });

  it('replacing scene defaults rematerializes every shot', () => {
    let project = cloneProject();
    const nextDefaults = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      includeMetadata: false,
      includePrompt: false,
    });
    project = setSceneExportDefaults(project, nextDefaults);
    expect(project.exportConfiguration!.activeProfileId).toBe('custom');
    expect(project.shots[0]!.exportSettings.includeMetadata).toBe(false);
    expect(project.shots[0]!.exportSettings.includePrompt).toBe(false);
  });
});

describe('export configuration migration', () => {
  it('migrates legacy per-shot settings into defaults + overrides without changing resolved output', () => {
    const project = createDefaultProject();
    const legacyShotA = structuredClone(project.shots[0]!);
    legacyShotA.exportSettings = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      width: 1920,
      height: 1080,
      includeFullPano: false,
      depth: { ...defaultShotExportSettings.depth!, enabled: true },
    });
    delete legacyShotA.exportOverrides;

    const legacyShotB = addShot(project, 2);
    legacyShotB.exportSettings = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      width: 1920,
      height: 1080,
      includePrompt: false,
    });
    delete legacyShotB.exportOverrides;

    const legacy: LocationProject = {
      ...project,
      exportConfiguration: undefined,
      shots: [legacyShotA, legacyShotB],
    };

    const before = legacy.shots.map((shot) => normalizeShotExportSettings(shot.exportSettings));
    const migrated = migrateProjectExportConfiguration(legacy);

    expect(migrated.exportConfiguration?.schemaVersion).toBe(EXPORT_CONFIGURATION_SCHEMA_VERSION);
    expect(migrated.exportConfiguration?.packageFormat).toBe('legacy-v1');
    expect(migrated.exportConfiguration?.defaults.width).toBe(1920);
    expect(migrated.exportConfiguration?.defaults.height).toBe(1080);

    expect(migrated.shots.map((shot) => shot.exportSettings)).toEqual(before);
    expect(migrated.shots[0]!.exportOverrides).toEqual({
      includeFullPano: false,
      depth: { enabled: true },
    });
    expect(migrated.shots[1]!.exportOverrides).toEqual({
      includePrompt: false,
    });
  });

  it('is idempotent across repeated migration and parse/serialize', () => {
    const project = createDefaultProject();
    const customized = setShotExportOverride(project, project.shots[0]!.id, {
      includeViewport: false,
      depth: { enabled: true, invert: true },
    });

    const once = migrateProjectExportConfiguration(customized);
    const twice = migrateProjectExportConfiguration(once);
    expect(twice).toEqual(once);

    const reopened = parseProject(serializeProject(once));
    expect(reopened.exportConfiguration).toEqual(once.exportConfiguration);
    expect(reopened.shots[0]!.exportOverrides).toEqual(once.shots[0]!.exportOverrides);
    expect(reopened.shots[0]!.exportSettings).toEqual(once.shots[0]!.exportSettings);

    // Manifest still consumes rematerialized shot.exportSettings.
    const manifest = createShotPackageManifest(reopened, reopened.shots[0]!);
    expect(manifest.files.some((file) => file.path.includes('viewport_clay'))).toBe(false);
  });

  it('ensures brand-new projects already carry export configuration', () => {
    const project = createDefaultProject();
    expect(project.exportConfiguration?.schemaVersion).toBe(2);
    expect(project.shots[0]!.exportOverrides).toEqual({});
    expect(ensureProjectExportConfiguration(project).exportConfiguration).toEqual(
      project.exportConfiguration,
    );
  });

  it('normalizes sparse override objects and drops empty nested groups', () => {
    expect(normalizeExportSettingsOverride({
      includeViewport: false,
      characterPass: {},
      depth: { enabled: true },
    })).toEqual({
      includeViewport: false,
      depth: { enabled: true },
    });
  });

  it('createDefaultExportConfiguration stamps schema metadata', () => {
    const config = createDefaultExportConfiguration();
    expect(config.schemaVersion).toBe(2);
    expect(config.activeProfileId).toBe('custom');
    expect(config.packageFormat).toBe('legacy-v1');
    expect(config.defaults).toEqual(normalizeShotExportSettings(defaultShotExportSettings));
  });
});
