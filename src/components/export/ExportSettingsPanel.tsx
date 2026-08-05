import React, { useMemo, useState } from 'react';
import { FileJson } from 'lucide-react';
import type {
  CharacterMotionExportFormat,
  CharacterPassExportSettings,
  ExportPackageFormat,
  LocationProject,
  PeopleExportMode,
  Shot,
  ShotDepthSettings,
  ShotExportSettings,
  VideoPerformanceProfileId,
} from '../../domain/types';
import {
  preferredShotExportMotionDefaultsForProject,
  resolveProjectVideoPerformance,
} from '../../engine/videoPerformance';
import {
  DEFAULT_CHARACTER_PASS_BACKGROUND,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
  normalizeCharacterPassExportSettings,
  normalizeShotDepthSettings,
  normalizeShotExportSettings,
} from '../../domain/defaults';
import { getShotDisplayName } from '../../domain/shotIdentity';
import {
  countExportOverrideLeaves,
  isExportFieldOverridden,
  shotHasExportOverrides,
  type ExportSettingFieldPath,
} from '../../engine/exportConfiguration';
import {
  characterPassIncludesGreenMp4,
  characterPassIncludesPngSequence,
  resolveCharacterMotionTiming,
  shotHasVisibleCharactersForPass,
  shouldWarnCharacterPngSequenceSize,
} from '../../engine/characterPassExport';
import { hasRenderableCameraMove } from '../../engine/cameraKeyframes';
import { shouldShowMissingLandmarkPromptNote } from '../../engine/warnings';
import { DepthSettingsPanel } from '../common/DepthSettingsPanel';
import { Field, IconButton, Select, TextInput } from '../common/Field';

export type ExportSettingsContext = 'scene' | 'shot';

type BooleanTopLevelKey =
  | 'includeViewport'
  | 'includeProjectedViewport'
  | 'includeProjectedCameraMoveReferenceFrames'
  | 'includeProjectedCameraMoveVideo'
  | 'includeAiResultFrame'
  | 'includePanoCrop'
  | 'includeFullPano'
  | 'includeCubemap'
  | 'includeGrayboxPano'
  | 'includeCameraMoveVideo'
  | 'includeCameraMoveReferenceFrames'
  | 'includeMetadata'
  | 'includePrompt';

const GENERATION_TOGGLES: Array<{ key: BooleanTopLevelKey; label: string }> = [
  { key: 'includeViewport', label: 'Clay control frame' },
  { key: 'includeProjectedViewport', label: 'Projected reference' },
  { key: 'includeCameraMoveVideo', label: 'Camera-motion clay video' },
  { key: 'includeProjectedCameraMoveVideo', label: 'Camera-motion projected video' },
  { key: 'includeCameraMoveReferenceFrames', label: 'Camera reference frames (clay)' },
  { key: 'includeProjectedCameraMoveReferenceFrames', label: 'Camera reference frames (projected)' },
  { key: 'includeAiResultFrame', label: 'AI result frame (if attached)' },
];

const SHARED_REF_TOGGLES: Array<{ key: BooleanTopLevelKey; label: string }> = [
  { key: 'includePanoCrop', label: 'Pano crop' },
  { key: 'includeFullPano', label: 'Canonical / styled panorama' },
  { key: 'includeCubemap', label: 'Cubemap faces' },
  { key: 'includeGrayboxPano', label: 'Graybox panorama' },
];

const TECHNICAL_TOGGLES: Array<{ key: BooleanTopLevelKey; label: string }> = [
  { key: 'includeMetadata', label: 'Camera metadata & manifests' },
];

const PROMPT_TOGGLES: Array<{ key: BooleanTopLevelKey; label: string }> = [
  { key: 'includePrompt', label: 'Image, video, and negative prompts' },
];

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="rounded-xl border border-subtle bg-surface-muted/40">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-secondary">
        {title}
      </summary>
      <div className="space-y-2 border-t border-subtle px-3 py-3">
        {children}
      </div>
    </details>
  );
}

function InheritanceBadge({ overridden }: { overridden: boolean }) {
  return (
    <span
      data-export-inheritance-badge={overridden ? 'override' : 'inherited'}
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        overridden
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-surface-muted text-muted'
      }`}
    >
      {overridden ? 'Shot override' : 'Using scene settings'}
    </span>
  );
}

function FieldHeader({
  label,
  path,
  context,
  shot,
  onReset,
}: {
  label: string;
  path: ExportSettingFieldPath;
  context: ExportSettingsContext;
  shot?: Shot;
  onReset: (path: ExportSettingFieldPath) => void;
}) {
  const overridden = context === 'shot' && isExportFieldOverridden(shot?.exportOverrides, path);
  return (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {context === 'shot' && (
        <div className="flex items-center gap-2">
          <InheritanceBadge overridden={overridden} />
          {overridden && (
            <button
              type="button"
              data-export-reset-field={path}
              className="text-[10px] font-medium text-secondary underline-offset-2 hover:text-accent hover:underline"
              onClick={() => onReset(path)}
            >
              Reset to scene settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ExportSettingsPanel({
  project,
  selectedShot,
  selectedShotIds,
  isExportingPackage,
  onExportCurrentShot,
  onAddCamera,
  patchSceneExportDefaults,
  updateShotResolvedSettings,
  resetShotExportField,
  resetShotExportOverrides,
  copyShotExportOverrides,
  promoteShotExportToSceneDefaults,
  setProjectPackageFormat,
  setProjectVideoPerformance,
}: {
  project: LocationProject;
  selectedShot?: Shot;
  selectedShotIds: Set<string>;
  isExportingPackage: boolean;
  onExportCurrentShot: () => void;
  onAddCamera: () => void;
  patchSceneExportDefaults: (patch: Partial<ShotExportSettings>) => void;
  updateShotResolvedSettings: (shotId: string, settings: ShotExportSettings) => void;
  resetShotExportField: (shotId: string, path: ExportSettingFieldPath) => void;
  resetShotExportOverrides: (shotId: string) => void;
  copyShotExportOverrides: (fromShotId: string, toShotIds: string[]) => void;
  promoteShotExportToSceneDefaults: (shotId: string) => void;
  setProjectPackageFormat: (packageFormat: ExportPackageFormat) => void;
  setProjectVideoPerformance: (
    settings: Partial<import('../../domain/types').VideoPerformanceSettings>,
  ) => void;
}) {
  const [context, setContext] = useState<ExportSettingsContext>('scene');
  /** Local drafts so Custom width/height can be edited before differing from scene defaults. */
  const [draftDimensions, setDraftDimensions] = useState<{ width?: number; height?: number }>({});
  const sceneDefaults = project.exportConfiguration?.defaults;
  const settings = context === 'scene'
    ? sceneDefaults
    : selectedShot?.exportSettings;

  const overrideCount = countExportOverrideLeaves(selectedShot?.exportOverrides);
  const checkedTargets = useMemo(
    () => [...selectedShotIds].filter((id) => id !== selectedShot?.id),
    [selectedShotIds, selectedShot?.id],
  );

  // Drop drafts when switching context/shot so stale custom editors do not linger.
  React.useEffect(() => {
    setDraftDimensions({});
  }, [context, selectedShot?.id]);

  if (!settings || !sceneDefaults) {
    return <p className="text-sm text-secondary">Select a shot to configure export settings.</p>;
  }

  const writeResolved = (next: ShotExportSettings) => {
    const normalized = normalizeShotExportSettings(next);
    if (context === 'scene') {
      patchSceneExportDefaults(normalized);
      return;
    }
    if (!selectedShot) return;
    updateShotResolvedSettings(selectedShot.id, normalized);
  };

  const patchResolved = (patch: Partial<ShotExportSettings>) => {
    writeResolved({
      ...settings,
      ...patch,
      characterPass: patch.characterPass ?? settings.characterPass,
      depth: patch.depth ?? settings.depth,
    });
  };

  const resetField = (path: ExportSettingFieldPath) => {
    if (!selectedShot) return;
    resetShotExportField(selectedShot.id, path);
  };

  const booleanControl = (key: BooleanTopLevelKey, label: string, note?: React.ReactNode) => {
    const value = Boolean(settings[key]);
    if (context === 'scene') {
      return (
        <div key={key} className="space-y-1">
          <label className="flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={value}
              onChange={(event) => patchResolved({ [key]: event.target.checked })}
              className="accent-[var(--accent)]"
              data-export-boolean={key}
            />
            {label}
          </label>
          {note}
        </div>
      );
    }

    const overridden = isExportFieldOverridden(selectedShot?.exportOverrides, key);
    const selectValue = overridden ? (value ? 'true' : 'false') : 'inherit';
    return (
      <div key={key} className="space-y-1" data-export-boolean-field={key}>
        <FieldHeader
          label={label}
          path={key}
          context={context}
          shot={selectedShot}
          onReset={resetField}
        />
        <Select
          value={selectValue}
          onChange={(event) => {
            const next = event.target.value as 'inherit' | 'true' | 'false';
            if (next === 'inherit') resetField(key);
            else patchResolved({ [key]: next === 'true' });
          }}
          data-export-boolean={key}
        >
          <option value="inherit">
            Use scene setting ({sceneDefaults[key] ? 'Enabled' : 'Disabled'})
          </option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </Select>
        {note}
      </div>
    );
  };

  const characterPass = normalizeCharacterPassExportSettings(
    settings.characterPass ?? defaultCharacterPassExportSettings,
  );
  const depth = normalizeShotDepthSettings(settings.depth ?? defaultShotDepthSettings);
  const hasMove = selectedShot ? hasRenderableCameraMove(selectedShot.cameraKeyframes) : false;
  const timing = selectedShot ? resolveCharacterMotionTiming(selectedShot) : undefined;
  const hasCharacters = selectedShot
    ? shotHasVisibleCharactersForPass(project, selectedShot, characterPass)
    : true;
  const showGreenField = characterPassIncludesGreenMp4(characterPass.motionFormat);
  const showSequenceWarn = Boolean(
    characterPass.enabled
    && characterPass.includeMotion
    && characterPassIncludesPngSequence(characterPass.motionFormat)
    && hasMove
    && timing
    && shouldWarnCharacterPngSequenceSize(timing.width, timing.height, timing.frameCount),
  );

  const writeCharacter = (next: CharacterPassExportSettings) => {
    patchResolved({ characterPass: next });
  };

  const writeDepth = (next: ShotDepthSettings) => {
    patchResolved({ depth: next });
  };

  const dimensionField = (key: 'width' | 'height', label: string) => {
    const value = settings[key];
    if (context === 'scene') {
      return (
        <Field label={label}>
          <TextInput
            type="number"
            value={value}
            onChange={(event) => patchResolved({ [key]: Number(event.target.value) })}
            data-export-dimension={key}
          />
        </Field>
      );
    }
    const overridden = isExportFieldOverridden(selectedShot?.exportOverrides, key);
    const drafting = draftDimensions[key] !== undefined;
    const showCustom = overridden || drafting;
    const inputValue = drafting ? draftDimensions[key]! : value;
    return (
      <div data-export-dimension-field={key}>
        <FieldHeader
          label={label}
          path={key}
          context={context}
          shot={selectedShot}
          onReset={(path) => {
            setDraftDimensions((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
            resetField(path);
          }}
        />
        <div className="space-y-2">
          <Select
            value={showCustom ? 'custom' : 'inherit'}
            onChange={(event) => {
              if (event.target.value === 'inherit') {
                setDraftDimensions((current) => {
                  const next = { ...current };
                  delete next[key];
                  return next;
                });
                resetField(key);
                return;
              }
              // Reveal the input immediately; persist only once the value differs.
              setDraftDimensions((current) => ({ ...current, [key]: value }));
            }}
            data-export-dimension-mode={key}
          >
            <option value="inherit">Use scene setting ({sceneDefaults[key]})</option>
            <option value="custom">Custom value</option>
          </Select>
          {showCustom && (
            <TextInput
              type="number"
              value={inputValue}
              onChange={(event) => {
                const next = Number(event.target.value);
                setDraftDimensions((current) => ({ ...current, [key]: next }));
                if (Number.isFinite(next) && next > 0 && next !== sceneDefaults[key]) {
                  patchResolved({ [key]: next });
                }
              }}
              data-export-dimension={key}
            />
          )}
        </div>
      </div>
    );
  };

  const nestedBooleanControl = (
    path: ExportSettingFieldPath,
    label: string,
    value: boolean,
    sceneValue: boolean,
    onSet: (next: boolean) => void,
    options: { disabled?: boolean; dataAttr?: string } = {},
  ) => {
    if (context === 'scene') {
      return (
        <label className="flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm text-secondary">
          <input
            type="checkbox"
            checked={value}
            disabled={options.disabled}
            onChange={(event) => onSet(event.target.checked)}
            className="accent-[var(--accent)]"
            data-export-nested-boolean={path}
            {...(options.dataAttr ? { [options.dataAttr]: true } : {})}
          />
          {label}
        </label>
      );
    }
    const overridden = isExportFieldOverridden(selectedShot?.exportOverrides, path);
    const selectValue = overridden ? (value ? 'true' : 'false') : 'inherit';
    return (
      <div className="space-y-1" data-export-nested-boolean-field={path}>
        <FieldHeader
          label={label}
          path={path}
          context={context}
          shot={selectedShot}
          onReset={resetField}
        />
        <Select
          value={selectValue}
          disabled={options.disabled}
          onChange={(event) => {
            const next = event.target.value as 'inherit' | 'true' | 'false';
            if (next === 'inherit') resetField(path);
            else onSet(next === 'true');
          }}
          data-export-nested-boolean={path}
          {...(options.dataAttr ? { [options.dataAttr]: true } : {})}
        >
          <option value="inherit">
            Use scene setting ({sceneValue ? 'Enabled' : 'Disabled'})
          </option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </Select>
      </div>
    );
  };

  const sceneCharacter = normalizeCharacterPassExportSettings(sceneDefaults.characterPass);
  const sceneDepth = normalizeShotDepthSettings(sceneDefaults.depth);

  return (
    <div className="space-y-4" data-export-settings-panel>
      <div
        data-export-settings-context-switch
        className="grid grid-cols-2 gap-1 rounded-xl border border-subtle bg-surface-muted p-1"
      >
        <button
          type="button"
          data-export-settings-context="scene"
          className={`rounded-lg px-2 py-2 text-xs font-semibold transition ${
            context === 'scene'
              ? 'bg-surface-raised text-primary shadow-sm'
              : 'text-secondary hover:text-primary'
          }`}
          onClick={() => setContext('scene')}
        >
          Scene Export Settings
        </button>
        <button
          type="button"
          data-export-settings-context="shot"
          className={`rounded-lg px-2 py-2 text-xs font-semibold transition ${
            context === 'shot'
              ? 'bg-surface-raised text-primary shadow-sm'
              : 'text-secondary hover:text-primary'
          }`}
          onClick={() => setContext('shot')}
          disabled={!selectedShot}
        >
          Customize this shot
        </button>
      </div>

      {context === 'scene' ? (
        <p
          data-export-settings-scope
          className="rounded-lg border border-subtle bg-surface-muted px-3 py-2 text-xs text-secondary"
        >
          <span className="font-semibold text-primary">Scene Export Settings</span>
          {' '}are inherited by every shot. Customize a shot only when it needs different deliverables.
        </p>
      ) : selectedShot ? (
        <div className="space-y-2">
          <p
            data-export-settings-scope
            className="rounded-lg border border-subtle bg-surface-muted px-3 py-2 text-xs text-secondary"
          >
            Customizing <span className="font-semibold text-primary">{getShotDisplayName(selectedShot)}</span>.
            {' '}Unresolved fields keep using scene settings. Changes here become a shot override.
          </p>
          <div className="flex flex-wrap gap-2" data-export-shot-override-actions>
            <span className="rounded-md bg-surface-muted px-2 py-1 text-[10px] font-medium text-secondary">
              {overrideCount === 0
                ? 'Using scene settings'
                : `${overrideCount} shot override${overrideCount === 1 ? '' : 's'}`}
            </span>
            {shotHasExportOverrides(selectedShot) && (
              <button
                type="button"
                data-export-reset-all-overrides
                className="rounded-md border border-subtle px-2 py-1 text-[10px] font-medium text-secondary hover:text-accent"
                onClick={() => resetShotExportOverrides(selectedShot.id)}
              >
                Reset to scene settings
              </button>
            )}
            {checkedTargets.length > 0 && shotHasExportOverrides(selectedShot) && (
              <button
                type="button"
                data-export-copy-overrides
                className="rounded-md border border-subtle px-2 py-1 text-[10px] font-medium text-secondary hover:text-accent"
                onClick={() => copyShotExportOverrides(selectedShot.id, checkedTargets)}
              >
                Copy overrides to {checkedTargets.length} checked shot{checkedTargets.length === 1 ? '' : 's'}
              </button>
            )}
            <button
              type="button"
              data-export-promote-overrides
              className="rounded-md border border-subtle px-2 py-1 text-[10px] font-medium text-secondary hover:text-accent"
              onClick={() => {
                const confirmed = window.confirm(
                  'Promote this shot’s resolved settings to Scene Export Settings? Other shots keep their current output by adjusting their overrides.',
                );
                if (confirmed) promoteShotExportToSceneDefaults(selectedShot.id);
              }}
            >
              Promote to scene settings
            </button>
          </div>
        </div>
      ) : null}

      <Section title="Output properties">
        <div className="grid grid-cols-2 gap-2">
          {dimensionField('width', 'Width')}
          {dimensionField('height', 'Height')}
        </div>
        {context === 'scene' ? (
          <Field label="People output" hint="Both adds matched with-people and clean-plate images/videos.">
            <Select
              value={settings.peopleExportMode ?? 'with_people'}
              onChange={(event) => patchResolved({
                peopleExportMode: event.target.value as PeopleExportMode,
              })}
              data-export-people-mode
            >
              <option value="with_people">With people</option>
              <option value="clean_plate">Clean plate</option>
              <option value="both">Both</option>
            </Select>
          </Field>
        ) : (
          <div>
            <FieldHeader
              label="People output"
              path="peopleExportMode"
              context={context}
              shot={selectedShot}
              onReset={resetField}
            />
            <Select
              value={
                isExportFieldOverridden(selectedShot?.exportOverrides, 'peopleExportMode')
                  ? (settings.peopleExportMode ?? 'with_people')
                  : 'inherit'
              }
              onChange={(event) => {
                const next = event.target.value;
                if (next === 'inherit') resetField('peopleExportMode');
                else patchResolved({ peopleExportMode: next as PeopleExportMode });
              }}
              data-export-people-mode
            >
              <option value="inherit">
                Use scene setting (
                {(sceneDefaults.peopleExportMode ?? 'with_people').replaceAll('_', ' ')}
                )
              </option>
              <option value="with_people">With people</option>
              <option value="clean_plate">Clean plate</option>
              <option value="both">Both</option>
            </Select>
          </div>
        )}
      </Section>

      <Section title="Generation controls">
        {GENERATION_TOGGLES.map(({ key, label }) => booleanControl(key, label))}
      </Section>

      <Section title="Character and compositing">
        <div className="space-y-2 rounded-xl border border-subtle p-3" data-export-character-pass>
          <p className="text-sm font-medium text-primary">Characters-only pass</p>
          {nestedBooleanControl(
            'characterPass.enabled',
            'Include character-only pass',
            characterPass.enabled,
            sceneCharacter.enabled,
            (enabled) => writeCharacter({ ...characterPass, enabled }),
            { dataAttr: 'data-export-character-pass-enabled' },
          )}
          {characterPass.enabled && (
            <>
              {selectedShot && !hasCharacters && (
                <p
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
                  data-export-character-pass-empty-warning
                >
                  No visible characters in this shot — character outputs will be skipped.
                </p>
              )}
              <div className="space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Still</p>
                {nestedBooleanControl(
                  'characterPass.includeStill',
                  'Transparent PNG',
                  characterPass.includeStill,
                  sceneCharacter.includeStill,
                  (includeStill) => writeCharacter({ ...characterPass, includeStill }),
                  { dataAttr: 'data-export-character-pass-still' },
                )}
              </div>
              <div className="space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Motion</p>
                {nestedBooleanControl(
                  'characterPass.includeMotion',
                  'Include motion output',
                  characterPass.includeMotion,
                  sceneCharacter.includeMotion,
                  (includeMotion) => writeCharacter({ ...characterPass, includeMotion }),
                  { disabled: context === 'shot' && !hasMove, dataAttr: 'data-export-character-pass-motion' },
                )}
                <div>
                  <FieldHeader
                    label="Format"
                    path="characterPass.motionFormat"
                    context={context}
                    shot={selectedShot}
                    onReset={resetField}
                  />
                  {context === 'scene' ? (
                    <Select
                      value={characterPass.motionFormat}
                      onChange={(event) => writeCharacter({
                        ...characterPass,
                        motionFormat: event.target.value as CharacterMotionExportFormat,
                      })}
                      data-export-character-pass-motion-format
                    >
                      <option value="green_mp4">Green-screen MP4</option>
                      <option value="transparent_png_sequence">Transparent PNG sequence</option>
                      <option value="both">MP4 + PNG sequence</option>
                    </Select>
                  ) : (
                    <Select
                      value={
                        isExportFieldOverridden(selectedShot?.exportOverrides, 'characterPass.motionFormat')
                          ? characterPass.motionFormat
                          : 'inherit'
                      }
                      disabled={!hasMove || !characterPass.includeMotion}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next === 'inherit') resetField('characterPass.motionFormat');
                        else {
                          writeCharacter({
                            ...characterPass,
                            motionFormat: next as CharacterMotionExportFormat,
                          });
                        }
                      }}
                      data-export-character-pass-motion-format
                    >
                      <option value="inherit">
                        Use scene setting ({sceneCharacter.motionFormat.replaceAll('_', ' ')})
                      </option>
                      <option value="green_mp4">Green-screen MP4</option>
                      <option value="transparent_png_sequence">Transparent PNG sequence</option>
                      <option value="both">MP4 + PNG sequence</option>
                    </Select>
                  )}
                  {context === 'shot' && !hasMove && (
                    <p className="mt-1 text-[11px] text-muted">
                      Capture start and end camera keyframes to enable motion export.
                    </p>
                  )}
                </div>
                {showGreenField && characterPass.includeMotion && (hasMove || context === 'scene') && (
                  <div>
                    <FieldHeader
                      label="Background"
                      path="characterPass.backgroundColor"
                      context={context}
                      shot={selectedShot}
                      onReset={resetField}
                    />
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <TextInput
                          value={characterPass.backgroundColor}
                          onChange={(event) => writeCharacter({
                            ...characterPass,
                            backgroundColor: event.target.value,
                          })}
                          onBlur={(event) => writeCharacter({
                            ...characterPass,
                            backgroundColor: event.target.value.trim() || DEFAULT_CHARACTER_PASS_BACKGROUND,
                          })}
                          data-export-character-pass-bg
                        />
                      </div>
                      <button
                        type="button"
                        className="mb-0.5 rounded-lg border border-subtle px-2 py-2 text-[11px] text-secondary transition hover:text-primary"
                        onClick={() => {
                          if (context === 'shot') resetField('characterPass.backgroundColor');
                          else {
                            writeCharacter({
                              ...characterPass,
                              backgroundColor: DEFAULT_CHARACTER_PASS_BACKGROUND,
                            });
                          }
                        }}
                        data-export-character-pass-bg-reset
                      >
                        {context === 'shot' ? 'Reset to scene settings' : 'Reset'}
                      </button>
                    </div>
                  </div>
                )}
                {hasMove && characterPass.includeMotion && timing && (
                  <p className="text-[11px] text-muted" data-export-character-pass-timing>
                    {timing.frameCount} frames · {timing.width} × {timing.height} · {timing.frameRate} fps
                  </p>
                )}
                {showSequenceWarn && (
                  <p
                    className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
                    data-export-character-pass-size-warning
                  >
                    Transparent PNG sequences at this length can use a lot of browser memory.
                    Prefer green-screen MP4 when possible, or shorten the move.
                  </p>
                )}
              </div>
              {nestedBooleanControl(
                'characterPass.includeAttachedProps',
                'Include character-linked props',
                characterPass.includeAttachedProps,
                sceneCharacter.includeAttachedProps,
                (includeAttachedProps) => writeCharacter({ ...characterPass, includeAttachedProps }),
                { dataAttr: 'data-export-character-pass-attachments' },
              )}
            </>
          )}
        </div>
      </Section>

      <Section title="Shared scene references">
        {SHARED_REF_TOGGLES.map(({ key, label }) => booleanControl(key, label))}
      </Section>

      <Section title="Prompts">
        {PROMPT_TOGGLES.map(({ key, label }) => booleanControl(
          key,
          label,
          key === 'includePrompt'
            && selectedShot
            && shouldShowMissingLandmarkPromptNote(project, selectedShot)
            ? (
              <p
                data-export-prompt-landmark-note
                className="px-1 text-[11px] leading-snug text-muted"
              >
                No continuity landmarks are pinned for this shot.
              </p>
            )
            : undefined,
        ))}
      </Section>

      {context === 'scene' && (
        <Section title="Video performance" defaultOpen>
          {(() => {
            const videoPerf = resolveProjectVideoPerformance(project.exportConfiguration);
            return (
              <>
                <Field
                  label="Motion video profile"
                  hint="Fast Control uses 720p24 with a hardware-preferring encoder for AI-generation turnaround. Standard uses 1080p30 and High Quality uses 4K30. Toggle clay/projected motion below to control which passes export generates."
                >
                  <Select
                    value={videoPerf.profileId}
                    onChange={(event) => {
                      const profileId = event.target.value as VideoPerformanceProfileId;
                      setProjectVideoPerformance({ profileId });
                      // Match setProjectExportProfile motion defaults, including clay
                      // fallback when no projected appearance is available.
                      patchResolved(preferredShotExportMotionDefaultsForProject(project, profileId));
                    }}
                    data-export-video-performance-profile
                  >
                    <option value="fast-control">Fast Control (720p24)</option>
                    <option value="standard">Standard (1080p30)</option>
                    <option value="high-quality">High Quality (4K30)</option>
                  </Select>
                </Field>
                <Field
                  label="Encoder mode"
                  hint="Fast prefers hardware H.264 + realtime latency and falls back to quality when unsupported."
                >
                  <Select
                    value={videoPerf.encoderMode}
                    onChange={(event) => setProjectVideoPerformance({
                      profileId: videoPerf.profileId,
                      encoderMode: event.target.value as 'quality' | 'fast',
                    })}
                    data-export-video-encoder-mode
                  >
                    <option value="fast">Fast (prefer hardware)</option>
                    <option value="quality">Quality</option>
                  </Select>
                </Field>
                <p className="text-[11px] text-muted" data-export-video-performance-summary>
                  {videoPerf.width}×{videoPerf.height} · {videoPerf.frameRate} fps · {videoPerf.encoderMode} encoder
                </p>
              </>
            );
          })()}
        </Section>
      )}

      {context === 'scene' && (
        <Section title="Package layout" defaultOpen={false}>
          <Field
            label="ZIP layout"
            hint="ForeScene v2 is a pilot layout: shared panoramas/cubemaps live once under shared_references/, shots get generation/prompts/technical folders, plus a START_HERE.html landing page. Legacy v1 keeps the current per-shot inputs/ layout."
          >
            <Select
              value={project.exportConfiguration?.packageFormat ?? 'legacy-v1'}
              onChange={(event) => setProjectPackageFormat(event.target.value as ExportPackageFormat)}
              data-export-package-format
            >
              <option value="legacy-v1">Legacy v1 (current)</option>
              <option value="forescene-v2">ForeScene v2 (pilot)</option>
            </Select>
          </Field>
        </Section>
      )}

      <Section title="Technical handoff" defaultOpen={false}>
        {TECHNICAL_TOGGLES.map(({ key, label }) => booleanControl(key, label))}
        <div className="space-y-2 rounded-xl border border-subtle p-3" data-export-depth-settings>
          {nestedBooleanControl(
            'depth.enabled',
            'Depth reference (linear camera depth)',
            depth.enabled,
            sceneDepth.enabled,
            (enabled) => writeDepth({ ...depth, enabled }),
            { dataAttr: 'data-export-depth-enabled' },
          )}
          {depth.enabled && (
            <>
              {nestedBooleanControl(
                'depth.includeViewportStill',
                'Viewport depth still',
                depth.includeViewportStill,
                sceneDepth.includeViewportStill,
                (includeViewportStill) => writeDepth({ ...depth, includeViewportStill }),
                { dataAttr: 'data-export-depth-viewport-still' },
              )}
              {nestedBooleanControl(
                'depth.includeReferenceFrames',
                'Camera move depth frames',
                depth.includeReferenceFrames,
                sceneDepth.includeReferenceFrames,
                (includeReferenceFrames) => writeDepth({ ...depth, includeReferenceFrames }),
                { dataAttr: 'data-export-depth-reference-frames' },
              )}
              {nestedBooleanControl(
                'depth.includeCameraMoveVideo',
                'Camera move depth MP4',
                depth.includeCameraMoveVideo,
                sceneDepth.includeCameraMoveVideo,
                (includeCameraMoveVideo) => writeDepth({ ...depth, includeCameraMoveVideo }),
                { dataAttr: 'data-export-depth-camera-move-video' },
              )}
              <div>
                <FieldHeader
                  label="Depth range / invert"
                  path="depth.rangeMode"
                  context={context}
                  shot={selectedShot}
                  onReset={resetField}
                />
                <DepthSettingsPanel
                  depth={depth}
                  resolvedRange={{
                    nearMeters: depth.nearMeters ?? 0.5,
                    farMeters: depth.farMeters ?? 18.2,
                  }}
                  onChange={writeDepth}
                  compact
                />
                {context === 'shot' && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(['depth.invert', 'depth.nearMeters', 'depth.farMeters'] as const).map((path) => (
                      isExportFieldOverridden(selectedShot?.exportOverrides, path) ? (
                        <button
                          key={path}
                          type="button"
                          data-export-reset-field={path}
                          className="rounded-md border border-subtle px-2 py-1 text-[10px] font-medium text-secondary hover:text-accent"
                          onClick={() => resetField(path)}
                        >
                          Reset {path.replace('depth.', '')} to scene
                        </button>
                      ) : null
                    ))}
                  </div>
                )}
              </div>
              <p className="text-[11px] leading-snug text-muted">
                Depth range is shared across stills, reference frames, and motion.
              </p>
            </>
          )}
        </div>
      </Section>

      <IconButton onClick={onExportCurrentShot} disabled={isExportingPackage} className="w-full">
        <FileJson className="h-4 w-4" />
        Export Final ZIP (current shot)
      </IconButton>
      <IconButton onClick={onAddCamera} disabled={isExportingPackage} className="w-full">
        Add Camera
      </IconButton>
    </div>
  );
}
