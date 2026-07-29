import React from 'react';
import type { HumanPose } from '../../domain/types';
import type { AutorigDeformationIssue } from '../../engine/autorig/deformationValidation';
import { HUMAN_POSE_PRESETS } from '../../engine/humanPosePresets';

const PREVIEW_POSE_IDS = ['neutral', 'arms-raised', 'elbows-bent', 'sitting', 'walking', 'crouching'];

/** Check-pose chrome: instructions, view toggles, diagnostic poses, and plain-language issues. */
export function AutorigPoseCheckStep({
  view,
  onViewChange,
  meshReady,
  generating,
  activeTestPose,
  onSelectPose,
  warnings,
  fallbackCount,
  issues,
  onFixBodyParts,
}: {
  view: 'front' | 'side' | 'perspective';
  onViewChange: (view: 'front' | 'side' | 'perspective') => void;
  meshReady: boolean;
  generating: boolean;
  activeTestPose: string;
  onSelectPose: (poseId: string, pose: HumanPose | undefined) => void;
  warnings?: string[];
  fallbackCount?: number;
  issues?: AutorigDeformationIssue[];
  onFixBodyParts?: () => void;
}) {
  const visibleIssues = (issues ?? []).filter((issue) => issue.severity === 'warning' || issue.severity === 'blocking');
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

      {visibleIssues.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3" data-autorig-pose-issues>
          {visibleIssues.map((issue) => (
            <div key={issue.id} className="space-y-1">
              <p className="text-xs text-amber-100">{issue.message}</p>
              {issue.region && onFixBodyParts && (
                <button
                  type="button"
                  className="text-[11px] font-semibold text-accent underline"
                  data-autorig-fix-region={issue.region}
                  onClick={onFixBodyParts}
                >
                  Fix body parts
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {typeof fallbackCount === 'number' && (
        <p className="text-[11px] text-muted" data-autorig-fallback-count>
          {fallbackCount === 0
            ? 'All vertices assigned to bones'
            : `${fallbackCount} vertices use a nearby bone fallback`}
          {warnings?.length ? ` · ${warnings[0]}` : ''}
        </p>
      )}
    </div>
  );
}
