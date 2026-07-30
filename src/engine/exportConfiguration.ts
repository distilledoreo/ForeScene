/**
 * Scene export defaults + sparse shot overrides.
 *
 * Source of truth: `project.exportConfiguration.defaults` and `shot.exportOverrides`.
 * `shot.exportSettings` is the rematerialized resolved snapshot used by existing exporters.
 */

import {
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
  defaultShotExportSettings,
  createDefaultExportConfiguration,
  normalizeCharacterPassExportSettings,
  normalizeCharacterMotionExportFormat,
  normalizeHexBackgroundColor,
  normalizeProjectExportConfiguration,
  normalizeShotDepthSettings,
  normalizeShotExportSettings,
} from '../domain/defaults';
import type {
  CharacterPassExportSettings,
  CharacterPassExportSettingsOverride,
  ExportConfigurationSchemaVersion,
  ExportProfileId,
  ExportSettingsOverride,
  LocationProject,
  PeopleExportMode,
  ProjectExportConfiguration,
  Shot,
  ShotDepthSettings,
  ShotDepthSettingsOverride,
  ShotExportSettings,
} from '../domain/types';
import { EXPORT_CONFIGURATION_SCHEMA_VERSION } from '../domain/types';

export {
  EXPORT_CONFIGURATION_SCHEMA_VERSION,
  createDefaultExportConfiguration,
  normalizeProjectExportConfiguration,
  normalizeShotExportSettings,
};

/** Top-level scalar/enum keys that can be overridden independently. */
export const EXPORT_SETTING_TOP_LEVEL_KEYS = [
  'width',
  'height',
  'peopleExportMode',
  'includeViewport',
  'includeProjectedViewport',
  'includeProjectedCameraMoveReferenceFrames',
  'includeProjectedCameraMoveVideo',
  'includeAiResultFrame',
  'includePanoCrop',
  'includeFullPano',
  'includeGrayboxPano',
  'includeCameraMoveVideo',
  'includeCameraMoveReferenceFrames',
  'includeMetadata',
  'includePrompt',
] as const;

export type ExportSettingTopLevelKey = (typeof EXPORT_SETTING_TOP_LEVEL_KEYS)[number];

export const CHARACTER_PASS_OVERRIDE_KEYS = [
  'enabled',
  'includeStill',
  'includeMotion',
  'motionFormat',
  'backgroundColor',
  'includeAttachedProps',
] as const;

export type CharacterPassOverrideKey = (typeof CHARACTER_PASS_OVERRIDE_KEYS)[number];

export const DEPTH_OVERRIDE_KEYS = [
  'enabled',
  'includeViewportStill',
  'includeReferenceFrames',
  'includeCameraMoveVideo',
  'rangeMode',
  'nearMeters',
  'farMeters',
  'invert',
] as const;

export type DepthOverrideKey = (typeof DEPTH_OVERRIDE_KEYS)[number];

/** Stable path used by reset / inheritance UI. */
export type ExportSettingFieldPath =
  | ExportSettingTopLevelKey
  | `characterPass.${CharacterPassOverrideKey}`
  | `depth.${DepthOverrideKey}`;

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizePeopleExportMode(value: unknown): PeopleExportMode {
  if (value === 'clean_plate' || value === 'both') return value;
  return 'with_people';
}

function cloneExportSettings(settings: ShotExportSettings): ShotExportSettings {
  return normalizeShotExportSettings(settings);
}

function assignLeaf(
  target: object,
  key: string,
  value: unknown,
): void {
  (target as Record<string, unknown>)[key] = value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === undefined && b === undefined) return true;
  return false;
}

function pickCharacterPassOverride(
  patch: CharacterPassExportSettingsOverride | undefined,
): CharacterPassExportSettingsOverride | undefined {
  if (!patch) return undefined;
  const next: CharacterPassExportSettingsOverride = {};
  let any = false;
  for (const key of CHARACTER_PASS_OVERRIDE_KEYS) {
    if (!hasOwn(patch, key)) continue;
    const value = patch[key];
    if (key === 'motionFormat') {
      next.motionFormat = normalizeCharacterMotionExportFormat(value);
    } else if (key === 'backgroundColor') {
      next.backgroundColor = normalizeHexBackgroundColor(value);
    } else if (typeof value === 'boolean') {
      next[key] = value;
    } else {
      continue;
    }
    any = true;
  }
  return any ? next : undefined;
}

function pickDepthOverride(
  patch: ShotDepthSettingsOverride | undefined,
): ShotDepthSettingsOverride | undefined {
  if (!patch) return undefined;
  const next: ShotDepthSettingsOverride = {};
  let any = false;
  for (const key of DEPTH_OVERRIDE_KEYS) {
    if (!hasOwn(patch, key)) continue;
    const value = patch[key];
    if (key === 'rangeMode') {
      next.rangeMode = value === 'manual' ? 'manual' : 'auto';
      any = true;
      continue;
    }
    if (key === 'nearMeters' || key === 'farMeters') {
      const numeric = Number(value);
      next[key] = Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
      any = true;
      continue;
    }
    if (typeof value === 'boolean') {
      next[key] = value;
      any = true;
    }
  }
  return any ? next : undefined;
}

/** Normalize a sparse override object; drop empty nested groups. */
export function normalizeExportSettingsOverride(
  override?: ExportSettingsOverride | null,
): ExportSettingsOverride {
  if (!override) return {};
  const next: ExportSettingsOverride = {};

  for (const key of EXPORT_SETTING_TOP_LEVEL_KEYS) {
    if (!hasOwn(override, key)) continue;
    const value = override[key];
    if (key === 'width' || key === 'height') {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) next[key] = Math.round(numeric);
      continue;
    }
    if (key === 'peopleExportMode') {
      next.peopleExportMode = normalizePeopleExportMode(value);
      continue;
    }
    if (typeof value === 'boolean') {
      next[key] = value;
    }
  }

  const characterPass = pickCharacterPassOverride(override.characterPass);
  if (characterPass) next.characterPass = characterPass;

  const depth = pickDepthOverride(override.depth);
  if (depth) next.depth = depth;

  return next;
}

function resolveCharacterPass(
  defaults: CharacterPassExportSettings | undefined,
  override: CharacterPassExportSettingsOverride | undefined,
): CharacterPassExportSettings {
  const base = normalizeCharacterPassExportSettings(defaults ?? defaultCharacterPassExportSettings);
  if (!override) return base;
  return normalizeCharacterPassExportSettings({
    ...base,
    ...override,
  });
}

function resolveDepth(
  defaults: ShotDepthSettings | undefined,
  override: ShotDepthSettingsOverride | undefined,
): ShotDepthSettings {
  const base = normalizeShotDepthSettings(defaults ?? defaultShotDepthSettings);
  if (!override) return base;
  return normalizeShotDepthSettings({
    ...base,
    ...override,
  });
}

/**
 * Resolve scene defaults + sparse shot overrides into fully normalized settings.
 * Explicit `false` overrides win; absent keys inherit. Nested objects merge leaf-wise.
 */
export function resolveExportSettings(
  defaults: ShotExportSettings,
  overrides?: ExportSettingsOverride | null,
): ShotExportSettings {
  const base = normalizeShotExportSettings(defaults);
  const sparse = normalizeExportSettingsOverride(overrides);
  if (Object.keys(sparse).length === 0) return base;

  const merged: ShotExportSettings = {
    ...base,
    characterPass: resolveCharacterPass(base.characterPass, sparse.characterPass),
    depth: resolveDepth(base.depth, sparse.depth),
  };

  for (const key of EXPORT_SETTING_TOP_LEVEL_KEYS) {
    if (!hasOwn(sparse, key)) continue;
    const value = sparse[key];
    if (key === 'width' || key === 'height') {
      if (typeof value === 'number') merged[key] = value;
      continue;
    }
    if (key === 'peopleExportMode') {
      if (value === 'with_people' || value === 'clean_plate' || value === 'both') {
        merged.peopleExportMode = value;
      }
      continue;
    }
    if (typeof value === 'boolean') {
      merged[key] = value;
    }
  }

  return normalizeShotExportSettings(merged);
}

/** Diff resolved settings against defaults into a sparse override (preserves explicit false). */
export function diffExportSettings(
  defaults: ShotExportSettings,
  resolved: ShotExportSettings,
): ExportSettingsOverride {
  const base = normalizeShotExportSettings(defaults);
  const value = normalizeShotExportSettings(resolved);
  const override: ExportSettingsOverride = {};

  for (const key of EXPORT_SETTING_TOP_LEVEL_KEYS) {
    if (!valuesEqual(base[key], value[key])) {
      assignLeaf(override, key, value[key]);
    }
  }

  const baseCharacter = normalizeCharacterPassExportSettings(base.characterPass);
  const valueCharacter = normalizeCharacterPassExportSettings(value.characterPass);
  const characterPass: CharacterPassExportSettingsOverride = {};
  for (const key of CHARACTER_PASS_OVERRIDE_KEYS) {
    if (!valuesEqual(baseCharacter[key], valueCharacter[key])) {
      assignLeaf(characterPass, key, valueCharacter[key]);
    }
  }
  if (Object.keys(characterPass).length > 0) override.characterPass = characterPass;

  const baseDepth = normalizeShotDepthSettings(base.depth);
  const valueDepth = normalizeShotDepthSettings(value.depth);
  const depth: ShotDepthSettingsOverride = {};
  for (const key of DEPTH_OVERRIDE_KEYS) {
    if (!valuesEqual(baseDepth[key], valueDepth[key])) {
      assignLeaf(depth, key, valueDepth[key]);
    }
  }
  if (Object.keys(depth).length > 0) override.depth = depth;

  return normalizeExportSettingsOverride(override);
}

export function isExportSettingsOverrideEmpty(override?: ExportSettingsOverride | null): boolean {
  if (!override) return true;
  const normalized = normalizeExportSettingsOverride(override);
  return Object.keys(normalized).length === 0
    && !normalized.characterPass
    && !normalized.depth;
}

/** Count overridden leaf fields (including nested character/depth leaves). */
export function countExportOverrideLeaves(override?: ExportSettingsOverride | null): number {
  const normalized = normalizeExportSettingsOverride(override);
  let count = 0;
  for (const key of EXPORT_SETTING_TOP_LEVEL_KEYS) {
    if (hasOwn(normalized, key)) count += 1;
  }
  if (normalized.characterPass) {
    for (const key of CHARACTER_PASS_OVERRIDE_KEYS) {
      if (hasOwn(normalized.characterPass, key)) count += 1;
    }
  }
  if (normalized.depth) {
    for (const key of DEPTH_OVERRIDE_KEYS) {
      if (hasOwn(normalized.depth, key)) count += 1;
    }
  }
  return count;
}

export function shotHasExportOverrides(shot: Pick<Shot, 'exportOverrides'>): boolean {
  return !isExportSettingsOverrideEmpty(shot.exportOverrides);
}

export function resolveShotExportSettings(
  project: Pick<LocationProject, 'exportConfiguration'>,
  shot: Pick<Shot, 'exportSettings' | 'exportOverrides'>,
): ShotExportSettings {
  const defaults = project.exportConfiguration?.defaults ?? defaultShotExportSettings;
  if (project.exportConfiguration) {
    return resolveExportSettings(defaults, shot.exportOverrides);
  }
  // Legacy projects that have not been migrated yet.
  return normalizeShotExportSettings(shot.exportSettings);
}

export function rematerializeShotExportSettings(
  defaults: ShotExportSettings,
  shot: Shot,
): Shot {
  const overrides = normalizeExportSettingsOverride(shot.exportOverrides);
  return {
    ...shot,
    exportOverrides: overrides,
    exportSettings: resolveExportSettings(defaults, overrides),
  };
}

function rematerializeAllShots(
  defaults: ShotExportSettings,
  shots: Shot[],
): Shot[] {
  return shots.map((shot) => rematerializeShotExportSettings(defaults, shot));
}

/**
 * Compact unanimous leaf customizations into scene defaults so overrides stay sparse
 * when every shot previously shared the same non-default value.
 */
function compactUnanimousDefaults(
  productDefaults: ShotExportSettings,
  resolvedShots: ShotExportSettings[],
): ShotExportSettings {
  if (resolvedShots.length === 0) return cloneExportSettings(productDefaults);
  const defaults = cloneExportSettings(productDefaults);

  for (const key of EXPORT_SETTING_TOP_LEVEL_KEYS) {
    const first = resolvedShots[0]![key];
    if (resolvedShots.every((settings) => valuesEqual(settings[key], first))) {
      assignLeaf(defaults, key, first);
    }
  }

  const character = { ...normalizeCharacterPassExportSettings(defaults.characterPass) };
  for (const key of CHARACTER_PASS_OVERRIDE_KEYS) {
    const first = normalizeCharacterPassExportSettings(resolvedShots[0]!.characterPass)[key];
    if (resolvedShots.every((settings) => {
      const value = normalizeCharacterPassExportSettings(settings.characterPass)[key];
      return valuesEqual(value, first);
    })) {
      assignLeaf(character, key, first);
    }
  }
  defaults.characterPass = character;

  const depth = { ...normalizeShotDepthSettings(defaults.depth) };
  for (const key of DEPTH_OVERRIDE_KEYS) {
    const first = normalizeShotDepthSettings(resolvedShots[0]!.depth)[key];
    if (resolvedShots.every((settings) => {
      const value = normalizeShotDepthSettings(settings.depth)[key];
      return valuesEqual(value, first);
    })) {
      assignLeaf(depth, key, first);
    }
  }
  defaults.depth = depth;

  return normalizeShotExportSettings(defaults);
}

/**
 * Migrate a project that still stores complete per-shot export settings into
 * scene defaults + sparse overrides. Idempotent when schemaVersion is already current.
 */
export function migrateProjectExportConfiguration(project: LocationProject): LocationProject {
  const existing = project.exportConfiguration;
  if (existing && existing.schemaVersion === EXPORT_CONFIGURATION_SCHEMA_VERSION) {
    const config = normalizeProjectExportConfiguration(existing);
    return {
      ...project,
      exportConfiguration: config,
      shots: rematerializeAllShots(config.defaults, project.shots.map((shot) => ({
        ...shot,
        exportOverrides: normalizeExportSettingsOverride(shot.exportOverrides),
      }))),
    };
  }

  const resolvedShots = project.shots.map((shot) => normalizeShotExportSettings(shot.exportSettings));
  const defaults = compactUnanimousDefaults(defaultShotExportSettings, resolvedShots);
  const config = createDefaultExportConfiguration(defaults);

  const shots = project.shots.map((shot, index) => {
    const resolved = resolvedShots[index]!;
    const overrides = diffExportSettings(config.defaults, resolved);
    return {
      ...shot,
      exportOverrides: overrides,
      exportSettings: resolveExportSettings(config.defaults, overrides),
    };
  });

  return {
    ...project,
    exportConfiguration: config,
    shots,
  };
}

/** Ensure export configuration exists and resolved settings match defaults+overrides. */
export function ensureProjectExportConfiguration(project: LocationProject): LocationProject {
  return migrateProjectExportConfiguration(project);
}

function requireExportConfiguration(project: LocationProject): ProjectExportConfiguration {
  return normalizeProjectExportConfiguration(
    project.exportConfiguration ?? createDefaultExportConfiguration(),
  );
}

function withUpdatedProject(
  project: LocationProject,
  config: ProjectExportConfiguration,
  shots: Shot[],
): LocationProject {
  return {
    ...project,
    exportConfiguration: config,
    shots,
  };
}

/** Replace scene defaults; rematerialize every shot (overrides unchanged). */
export function setSceneExportDefaults(
  project: LocationProject,
  defaults: ShotExportSettings,
): LocationProject {
  const config = {
    ...requireExportConfiguration(project),
    defaults: normalizeShotExportSettings(defaults),
    activeProfileId: 'custom' as ExportProfileId,
  };
  return withUpdatedProject(project, config, rematerializeAllShots(config.defaults, project.shots));
}

/** Patch scene defaults with a partial update. */
export function patchSceneExportDefaults(
  project: LocationProject,
  patch: Partial<ShotExportSettings>,
): LocationProject {
  const config = requireExportConfiguration(project);
  const nextDefaults = normalizeShotExportSettings({
    ...config.defaults,
    ...patch,
    characterPass: patch.characterPass !== undefined
      ? normalizeCharacterPassExportSettings({
        ...config.defaults.characterPass,
        ...patch.characterPass,
      })
      : config.defaults.characterPass,
    depth: patch.depth !== undefined
      ? normalizeShotDepthSettings({
        ...config.defaults.depth,
        ...patch.depth,
      })
      : config.defaults.depth,
  });
  return setSceneExportDefaults(project, nextDefaults);
}

function mergeOverrides(
  current: ExportSettingsOverride | undefined,
  patch: ExportSettingsOverride,
): ExportSettingsOverride {
  const base = normalizeExportSettingsOverride(current);
  const nextPatch = normalizeExportSettingsOverride(patch);
  const merged: ExportSettingsOverride = { ...base, ...nextPatch };

  if (nextPatch.characterPass || base.characterPass) {
    const characterPass = {
      ...base.characterPass,
      ...nextPatch.characterPass,
    };
    const normalized = pickCharacterPassOverride(characterPass);
    if (normalized) merged.characterPass = normalized;
    else delete merged.characterPass;
  }

  if (nextPatch.depth || base.depth) {
    const depth = {
      ...base.depth,
      ...nextPatch.depth,
    };
    const normalized = pickDepthOverride(depth);
    if (normalized) merged.depth = normalized;
    else delete merged.depth;
  }

  return normalizeExportSettingsOverride(merged);
}

/** Apply a sparse override patch onto one shot and rematerialize resolved settings. */
export function setShotExportOverride(
  project: LocationProject,
  shotId: string,
  patch: ExportSettingsOverride,
): LocationProject {
  const config = requireExportConfiguration(project);
  const shots = project.shots.map((shot) => {
    if (shot.id !== shotId) return shot;
    const overrides = mergeOverrides(shot.exportOverrides, patch);
    return rematerializeShotExportSettings(config.defaults, {
      ...shot,
      exportOverrides: overrides,
    });
  });
  return withUpdatedProject(project, config, shots);
}

/**
 * Replace a shot's entire override object (not merge). Used when syncing from a
 * fully resolved settings edit in the legacy UI.
 */
export function replaceShotExportOverrides(
  project: LocationProject,
  shotId: string,
  overrides: ExportSettingsOverride,
): LocationProject {
  const config = requireExportConfiguration(project);
  const shots = project.shots.map((shot) => {
    if (shot.id !== shotId) return shot;
    return rematerializeShotExportSettings(config.defaults, {
      ...shot,
      exportOverrides: normalizeExportSettingsOverride(overrides),
    });
  });
  return withUpdatedProject(project, config, shots);
}

/**
 * Sync overrides from a fully resolved settings object (e.g. Export drawer edit).
 * Diffs against scene defaults so only real differences become overrides.
 */
export function syncShotExportFromResolved(
  project: LocationProject,
  shotId: string,
  resolved: ShotExportSettings,
): LocationProject {
  const config = requireExportConfiguration(project);
  const overrides = diffExportSettings(config.defaults, resolved);
  return replaceShotExportOverrides(project, shotId, overrides);
}

function deleteTopLevelOverride(
  overrides: ExportSettingsOverride,
  key: ExportSettingTopLevelKey,
): ExportSettingsOverride {
  const next = { ...overrides };
  delete next[key];
  return next;
}

function deleteCharacterPassOverride(
  overrides: ExportSettingsOverride,
  key: CharacterPassOverrideKey,
): ExportSettingsOverride {
  if (!overrides.characterPass) return overrides;
  const characterPass = { ...overrides.characterPass };
  delete characterPass[key];
  const next = { ...overrides };
  if (Object.keys(characterPass).length === 0) delete next.characterPass;
  else next.characterPass = characterPass;
  return next;
}

function deleteDepthOverride(
  overrides: ExportSettingsOverride,
  key: DepthOverrideKey,
): ExportSettingsOverride {
  if (!overrides.depth) return overrides;
  const depth = { ...overrides.depth };
  delete depth[key];
  const next = { ...overrides };
  if (Object.keys(depth).length === 0) delete next.depth;
  else next.depth = depth;
  return next;
}

/** Reset one field on a shot back to scene inheritance. */
export function resetShotExportField(
  project: LocationProject,
  shotId: string,
  path: ExportSettingFieldPath,
): LocationProject {
  const config = requireExportConfiguration(project);
  const shots = project.shots.map((shot) => {
    if (shot.id !== shotId) return shot;
    let overrides = normalizeExportSettingsOverride(shot.exportOverrides);
    if (path.startsWith('characterPass.')) {
      overrides = deleteCharacterPassOverride(
        overrides,
        path.slice('characterPass.'.length) as CharacterPassOverrideKey,
      );
    } else if (path.startsWith('depth.')) {
      overrides = deleteDepthOverride(
        overrides,
        path.slice('depth.'.length) as DepthOverrideKey,
      );
    } else {
      overrides = deleteTopLevelOverride(overrides, path as ExportSettingTopLevelKey);
    }
    return rematerializeShotExportSettings(config.defaults, {
      ...shot,
      exportOverrides: overrides,
    });
  });
  return withUpdatedProject(project, config, shots);
}

/** Clear all overrides on a shot (full inheritance from scene defaults). */
export function resetShotExportOverrides(
  project: LocationProject,
  shotId: string,
): LocationProject {
  const config = requireExportConfiguration(project);
  const shots = project.shots.map((shot) => {
    if (shot.id !== shotId) return shot;
    return rematerializeShotExportSettings(config.defaults, {
      ...shot,
      exportOverrides: {},
    });
  });
  return withUpdatedProject(project, config, shots);
}

/** Copy one shot's overrides onto other shots. */
export function copyShotExportOverrides(
  project: LocationProject,
  fromShotId: string,
  toShotIds: string[],
): LocationProject {
  const config = requireExportConfiguration(project);
  const source = project.shots.find((shot) => shot.id === fromShotId);
  if (!source) return project;
  const overrides = normalizeExportSettingsOverride(source.exportOverrides);
  const targets = new Set(toShotIds.filter((id) => id !== fromShotId));
  if (targets.size === 0) return project;

  const shots = project.shots.map((shot) => {
    if (!targets.has(shot.id)) return shot;
    return rematerializeShotExportSettings(config.defaults, {
      ...shot,
      exportOverrides: structuredClone(overrides),
    });
  });
  return withUpdatedProject(project, config, shots);
}

/**
 * Promote one shot's resolved settings to become the new scene defaults.
 * Other shots keep the same resolved output by recomputing their overrides.
 */
export function promoteShotExportToSceneDefaults(
  project: LocationProject,
  shotId: string,
): LocationProject {
  const config = requireExportConfiguration(project);
  const source = project.shots.find((shot) => shot.id === shotId);
  if (!source) return project;

  const promoted = resolveExportSettings(config.defaults, source.exportOverrides);
  const nextConfig: ProjectExportConfiguration = {
    ...config,
    defaults: promoted,
    activeProfileId: 'custom',
  };

  const shots = project.shots.map((shot) => {
    const resolved = resolveExportSettings(config.defaults, shot.exportOverrides);
    if (shot.id === shotId) {
      return rematerializeShotExportSettings(nextConfig.defaults, {
        ...shot,
        exportOverrides: {},
      });
    }
    const overrides = diffExportSettings(nextConfig.defaults, resolved);
    return rematerializeShotExportSettings(nextConfig.defaults, {
      ...shot,
      exportOverrides: overrides,
    });
  });

  return withUpdatedProject(project, nextConfig, shots);
}

/** Field inheritance state for UI / multi-select mixed detection. */
export type ExportFieldInheritanceState = 'inherited' | 'overridden' | 'mixed';

export function getExportFieldInheritanceState(
  shots: Array<Pick<Shot, 'exportOverrides'>>,
  path: ExportSettingFieldPath,
): ExportFieldInheritanceState {
  if (shots.length === 0) return 'inherited';
  const flags = shots.map((shot) => isExportFieldOverridden(shot.exportOverrides, path));
  const first = flags[0]!;
  if (flags.every((flag) => flag === first)) {
    return first ? 'overridden' : 'inherited';
  }
  return 'mixed';
}

export function isExportFieldOverridden(
  overrides: ExportSettingsOverride | undefined,
  path: ExportSettingFieldPath,
): boolean {
  const sparse = normalizeExportSettingsOverride(overrides);
  if (path.startsWith('characterPass.')) {
    const key = path.slice('characterPass.'.length) as CharacterPassOverrideKey;
    return Boolean(sparse.characterPass && hasOwn(sparse.characterPass, key));
  }
  if (path.startsWith('depth.')) {
    const key = path.slice('depth.'.length) as DepthOverrideKey;
    return Boolean(sparse.depth && hasOwn(sparse.depth, key));
  }
  return hasOwn(sparse, path as ExportSettingTopLevelKey);
}

export function getResolvedExportFieldValue(
  settings: ShotExportSettings,
  path: ExportSettingFieldPath,
): unknown {
  const normalized = normalizeShotExportSettings(settings);
  if (path.startsWith('characterPass.')) {
    const key = path.slice('characterPass.'.length) as CharacterPassOverrideKey;
    return normalizeCharacterPassExportSettings(normalized.characterPass)[key];
  }
  if (path.startsWith('depth.')) {
    const key = path.slice('depth.'.length) as DepthOverrideKey;
    return normalizeShotDepthSettings(normalized.depth)[key];
  }
  return normalized[path as ExportSettingTopLevelKey];
}

/** Whether every selected shot shares the same resolved value for a field. */
export function getMixedResolvedExportFieldValue(
  settingsList: ShotExportSettings[],
  path: ExportSettingFieldPath,
): { mixed: true } | { mixed: false; value: unknown } {
  if (settingsList.length === 0) return { mixed: false, value: undefined };
  const first = getResolvedExportFieldValue(settingsList[0]!, path);
  for (let i = 1; i < settingsList.length; i += 1) {
    if (!valuesEqual(getResolvedExportFieldValue(settingsList[i]!, path), first)) {
      return { mixed: true };
    }
  }
  return { mixed: false, value: first };
}

export function isExportConfigurationSchemaVersion(
  value: unknown,
): value is ExportConfigurationSchemaVersion {
  return value === EXPORT_CONFIGURATION_SCHEMA_VERSION;
}
