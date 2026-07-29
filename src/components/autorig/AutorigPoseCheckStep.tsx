import React from 'react';
import type { HumanPose } from '../../domain/types';
import { HUMAN_POSE_PRESETS } from '../../engine/humanPosePresets';

const PREVIEW_POSE_IDS = ['neutral', 'arms-raised', 'elbows-bent', 'sitting', 'walking', 'crouching'];

/** Check-pose chrome: instructions, view toggles, and diagnostic pose chips. */
export function AutorigPoseCheckStep({
  view,
  onViewChange,
  meshReady,
  generating,
  activeTestPose,
  onSelectPose,
  warnings,
  fallbackCount,
}: {
  view: 'front' | 'side' | 'perspective';
  onViewChange: (view: 'front' | 'side' | 'perspective') => void;
  meshReady: boolean;
  generating: boolean;
  activeTestPose: string;
  onSelectPose: (poseId: string, pose: HumanPose | undefined) => void;
  warnings?: string[];
  fallbackCount?: number;
}) {
  return (
    <div className="space-y-3" data-autorig-pose-check-step>
      <p className="text-sm text-secondary">
        Try several example poses. If part of the model bends with the wrong limb, return to Body Parts and relabel that area.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {([
          ['front', 'Front'],
          ['side', 'Side'],
          ['perspective', 'Perspective'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${view === id ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
            onClick={() => onViewChange(id)}
            data-autorig-preview-view={id}
          >
            {label}
          </button>
        ))}
        {generating && <span className="text-[10px] text-muted">Generating rig…</span>}
        {!generating && !meshReady && <span className="text-[10px] text-muted">Loading mesh…</span>}
      </div>

      <div className="flex flex-wrap gap-2" data-autorig-test-poses>
        {HUMAN_POSE_PRESETS
          .filter((preset) => PREVIEW_POSE_IDS.includes(preset.id))
          .map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`rounded-lg border px-2 py-1.5 text-xs font-semibold ${
                activeTestPose === preset.id
                  ? 'border-accent text-accent'
                  : 'border-subtle text-secondary'
              }`}
              data-autorig-test-pose={preset.id}
              onClick={() => onSelectPose(preset.id, preset.id === 'neutral' ? undefined : preset.pose)}
              disabled={generating || !meshReady}
            >
              {preset.label}
            </button>
          ))}
      </div>

      {typeof fallbackCount === 'number' && (
        <p className="text-[11px] text-muted" data-autorig-fallback-count>
          {fallbackCount === 0
            ? 'All vertices assigned to bones'
            : `${fallbackCount} vertices use a fallback bone`}
          {warnings?.length ? ` · ${warnings[0]}` : ''}
        </p>
      )}
    </div>
  );
}
