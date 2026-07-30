import React from 'react';
import { LocationProject, ProjectedStyleSettings } from '../../domain/types';
import {
  listEligibleProjectedStylePanos,
  normalizeProjectedStyleSettings,
  projectedStyleStatusLabel,
  resolveProjectedStylePano,
} from '../../engine/projectedStyle';
import {
  PROJECTOR_BLEND_MODE_LABELS,
  type ProjectorBlendMode,
  canUseDualProjectorBlend,
  resolveProjectors,
} from '../../engine/multiOriginProjection';
import { useProjectStore } from '../../state/useProjectStore';
import { Field, Select, TextInput, Toggle } from './Field';
import { CoverageOptimizerPanel } from './CoverageOptimizerPanel';

const BLEND_OPTIONS: ProjectorBlendMode[] = [
  'primary_only',
  'secondary_only',
  'primary_dominant',
  'secondary_dominant',
];

export function ProjectedStylePanel({
  project,
  onChange,
  onSetCaptureOrigin,
}: {
  project: LocationProject;
  onChange: (settings: ProjectedStyleSettings) => void;
  onSetCaptureOrigin?: (origin: LocationProject['scene']['panoOrigin']) => void;
}) {
  const occlusionStatus = useProjectStore((state) => state.projectedOcclusionStatus);
  const settings = normalizeProjectedStyleSettings(project.settings.projectedStyle);
  const eligible = listEligibleProjectedStylePanos(project);
  const allPanos = project.panoRefs;
  const status = projectedStyleStatusLabel(project);
  const active = resolveProjectedStylePano(project);
  const resolved = resolveProjectors(project, settings);
  const dualStyled = eligible.length >= 2;
  const dualReady = canUseDualProjectorBlend(project, settings);
  const secondaryCandidates = allPanos.filter((pano) => pano.id !== (settings.panoId ?? active?.id));
  const blendBoth = settings.blendMode !== 'primary_only' && dualStyled;

  const update = (partial: Partial<ProjectedStyleSettings>) => {
    onChange(normalizeProjectedStyleSettings({ ...settings, ...partial }));
  };

  const occlusionStatusLabel = {
    disabled: 'Disabled',
    generating: 'Generating…',
    ready: 'Ready',
    failed: 'Unavailable — using legacy projection',
  }[occlusionStatus];

  return (
    <div className="space-y-3" data-projected-style-panel>
      <div>
        <h3 className="text-sm font-semibold text-primary">Projected Style</h3>
        <p className="mt-1 text-xs leading-relaxed text-secondary">
          Projection is strongest near each capture. Add a second vantage when distant areas look thin, then blend both.
        </p>
      </div>

      <div className="rounded-lg border border-subtle bg-surface-base px-3 py-2 text-xs text-secondary">
        <div>
          <span className="font-semibold text-primary">Primary:</span>{' '}
          {status.panoName ?? '—'}
        </div>
        <div className="mt-0.5">
          <span className="font-semibold text-primary">Origin:</span> {status.originLabel}
        </div>
        {resolved.secondary && blendBoth && (
          <div className="mt-0.5" data-projected-blend-status>
            <span className="font-semibold text-primary">Blending with:</span>{' '}
            {resolved.secondary.name}
          </div>
        )}
        {status.reason && (
          <p className="mt-1 text-amber-800 dark:text-amber-200">{status.reason}</p>
        )}
      </div>

      {dualStyled ? (
        <div data-projected-blend-toggle>
          <Field
            label="Blend both captures"
            hint="Uses the second vantage to fill areas far from the primary origin."
          >
            <Toggle
              checked={blendBoth}
              onChange={(value) => update({
                blendMode: value ? 'primary_dominant' : 'primary_only',
                secondaryPanoId: value
                  ? (settings.secondaryPanoId ?? resolved.secondary?.id ?? eligible.find((p) => p.id !== active?.id)?.id)
                  : settings.secondaryPanoId,
              })}
            />
          </Field>
        </div>
      ) : eligible.length === 1 ? (
        <p className="text-xs text-secondary" data-projected-second-tip>
          One styled capture loaded. Use <span className="font-medium text-primary">Fill missing areas</span> on
          Reference (or move the capture origin in Build) to add a second vantage for blend.
        </p>
      ) : (
        <p className="text-xs text-secondary">
          Import and align a styled panorama first for best results.
        </p>
      )}

      {blendBoth && !dualReady && (
        <p className="text-xs text-amber-800 dark:text-amber-200">
          Dual blend needs two styled panoramas with image assets.
        </p>
      )}

      <details className="rounded-lg border border-subtle bg-surface-base px-3 py-2" data-projected-style-advanced>
        <summary className="cursor-pointer select-none text-xs font-semibold text-primary">
          Advanced
        </summary>
        <div className="mt-3 space-y-3">
          <Field label="Primary panorama">
            <Select
              value={settings.panoId ?? active?.id ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                update({ panoId: value || undefined });
              }}
              disabled={allPanos.length === 0}
            >
              <option value="">Auto (canonical styled)</option>
              {allPanos.map((pano) => (
                <option key={pano.id} value={pano.id}>
                  {pano.name}
                  {pano.type === 'graybox_render' ? ' (graybox)' : ''}
                  {pano.isCanonical ? ' · canonical' : ''}
                </option>
              ))}
            </Select>
          </Field>

          {dualStyled && (
            <>
              <Field
                label="Multi-origin blend"
                hint="Preference only nudges near-equal seams; clearer quality always wins."
              >
                <Select
                  value={settings.blendMode ?? 'primary_only'}
                  onChange={(event) => {
                    update({ blendMode: event.target.value as ProjectorBlendMode });
                  }}
                  data-projected-blend-mode
                >
                  {BLEND_OPTIONS.map((mode) => (
                    <option key={mode} value={mode}>
                      {PROJECTOR_BLEND_MODE_LABELS[mode]}
                    </option>
                  ))}
                </Select>
              </Field>

              {settings.blendMode !== 'primary_only' && (
                <Field label="Secondary panorama">
                  <Select
                    value={settings.secondaryPanoId ?? resolved.secondary?.id ?? ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      update({ secondaryPanoId: value || undefined });
                    }}
                    disabled={secondaryCandidates.length === 0}
                    data-projected-secondary-pano
                  >
                    <option value="">Auto (next eligible)</option>
                    {secondaryCandidates.map((pano) => (
                      <option key={pano.id} value={pano.id}>
                        {pano.name}
                        {pano.isCanonical ? ' · canonical' : ''}
                        {` · ${pano.origin.map((v) => v.toFixed(1)).join(', ')} m`}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </>
          )}

          <Field
            label="Geometry occlusion"
            hint="Surfaces hidden behind other geometry do not receive this panorama."
          >
            <Toggle
              checked={settings.occlusionEnabled ?? true}
              onChange={(value) => update({ occlusionEnabled: value })}
            />
          </Field>

          {settings.occlusionEnabled && (
            <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-primary">Occlusion status</span>
                <span
                  data-occlusion-status={occlusionStatus}
                  className={
                    occlusionStatus === 'ready' ? 'text-green-700 dark:text-green-300'
                      : occlusionStatus === 'failed' ? 'text-amber-700 dark:text-amber-300'
                        : 'text-secondary'
                  }
                >
                  {occlusionStatusLabel}
                </span>
              </div>

              <div className="mt-2">
                <Field label="Ownership preview">
                  <Toggle
                    checked={settings.occlusionDebugMode === 'coverage'}
                    onChange={(value) => update({ occlusionDebugMode: value ? 'coverage' : 'off' })}
                  />
                </Field>
                <p className="mt-1 text-[11px] leading-snug text-secondary">
                  Cyan: primary-owned · Magenta: secondary-owned · White: feathered seam · Red: neither visible.
                </p>
              </div>

              <details className="mt-2">
                <summary className="cursor-pointer select-none text-primary">Precision</summary>
                <div className="mt-2 space-y-2">
                  <Field label={`Occlusion bias (${settings.occlusionBiasMeters?.toFixed(3)} m)`}>
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.005}
                      value={settings.occlusionBiasMeters ?? 0.04}
                      onChange={(event) => update({ occlusionBiasMeters: Number(event.target.value) })}
                      className="w-full accent-[var(--accent)]"
                    />
                  </Field>
                  <Field label={`Edge softness (${settings.occlusionSoftness?.toFixed(2)})`}>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={settings.occlusionSoftness ?? 1}
                      onChange={(event) => update({ occlusionSoftness: Number(event.target.value) })}
                      className="w-full accent-[var(--accent)]"
                    />
                  </Field>
                </div>
              </details>
            </div>
          )}

          <CoverageOptimizerPanel
            project={project}
            primaryPano={active}
            onSetCaptureOrigin={onSetCaptureOrigin}
          />

          <Field label={`Opacity (${Math.round(settings.opacity * 100)}%)`}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(settings.opacity * 100)}
              onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
              className="w-full accent-[var(--accent)]"
            />
          </Field>

          <Field label="Exposure" hint="0.25–4.0">
            <TextInput
              type="number"
              min={0.25}
              max={4}
              step={0.05}
              value={settings.exposure}
              onChange={(event) => update({ exposure: Number(event.target.value) })}
            />
          </Field>

          <Field label={`Lighting contribution (${Math.round(settings.lightingContribution * 100)}%)`}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(settings.lightingContribution * 100)}
              onChange={(event) => update({ lightingContribution: Number(event.target.value) / 100 })}
              className="w-full accent-[var(--accent)]"
            />
          </Field>

          <Field label="Unsupported-area fallback">
            <Select
              value={settings.fallbackMode}
              onChange={(event) => update({
                fallbackMode: event.target.value === 'neutral' ? 'neutral' : 'clay',
              })}
            >
              <option value="clay">Clay</option>
              <option value="neutral">Neutral</option>
            </Select>
          </Field>
        </div>
      </details>
    </div>
  );
}
