import React from 'react';
import type { HumanPose } from '../../domain/types';
import type { AutorigDeformationIssue } from '../../engine/autorig/deformationValidation';
import { HUMAN_POSE_PRESETS } from '../../engine/humanPosePresets';
import {
  AutorigCorrectionFeedback,
} from './AutorigCorrectionFeedback';
import {
  AutorigFixToolbar,
  type AutorigFixTool,
} from './AutorigFixToolbar';
import type { AutorigBodyRegionId } from '../../engine/autorig/regions';
import type { AutorigCorrectionResult } from '../../engine/autorig/regionSelection';

const PREVIEW_POSE_IDS = ['neutral', 'arms-raised', 'elbows-bent', 'sitting', 'walking', 'crouching'];

/** Pose & Fix chrome: diagnostic poses, fix toggle, and correction tools. */
export function AutorigPoseFixStep({
  view,
  onViewChange,
  meshReady,
  preparing,
  updating,
  activeTestPose,
  onSelectPose,
  fixEnabled,
  onFixEnabledChange,
  tool,
  onToolChange,
  selectedRegion,
  onSelectRegion,
  restoreAutomatic,
  onRestoreAutomaticChange,
  brushRadius,
  onBrushRadiusChange,
  showAssignments,
  onShowAssignmentsChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  correctionResult,
  onAdjustJoint,
  warnings,
  fallbackCount,
  issues,
}: {
  view: 'front' | 'side' | 'perspective';
  onViewChange: (view: 'front' | 'side' | 'perspective') => void;
  meshReady: boolean;
  preparing?: boolean;
  updating?: boolean;
  activeTestPose: string;
  onSelectPose: (poseId: string, pose: HumanPose | undefined) => void;
  fixEnabled: boolean;
  onFixEnabledChange: (value: boolean) => void;
  tool: AutorigFixTool;
  onToolChange: (tool: AutorigFixTool) => void;
  selectedRegion: AutorigBodyRegionId;
  onSelectRegion: (region: AutorigBodyRegionId) => void;
  restoreAutomatic: boolean;
  onRestoreAutomaticChange: (value: boolean) => void;
  brushRadius: number;
  onBrushRadiusChange: (radius: number) => void;
  showAssignments: boolean;
  onShowAssignmentsChange: (value: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  correctionResult?: AutorigCorrectionResult | null;
  onAdjustJoint?: () => void;
  warnings?: string[];
  fallbackCount?: number;
  issues?: AutorigDeformationIssue[];
}) {
  const visibleIssues = (issues ?? []).filter((issue) => issue.severity === 'warning' || issue.severity === 'blocking');

  return (
    <div className="space-y-3" data-autorig-pose-fix-step>
      <p className="text-sm text-secondary">
        Try example poses. Turn on Fix deformation to paint problem areas directly on the posed character.
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
        {preparing && (
          <span className="text-[10px] text-muted" data-autorig-preparing>
            Preparing pose preview…
          </span>
        )}
        {!preparing && !meshReady && (
          <span className="text-[10px] text-muted">Loading mesh…</span>
        )}
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
              disabled={preparing || !meshReady}
            >
              {preset.label}
            </button>
          ))}
      </div>

      <label className="flex items-center gap-2 text-xs font-semibold text-secondary" data-autorig-fix-toggle>
        <input
          type="checkbox"
          checked={fixEnabled}
          onChange={(event) => onFixEnabledChange(event.target.checked)}
          data-autorig-fix-deformation
        />
        Fix deformation
      </label>

      {fixEnabled && (
        <AutorigFixToolbar
          tool={tool}
          onToolChange={onToolChange}
          selectedRegion={selectedRegion}
          onSelectRegion={onSelectRegion}
          restoreAutomatic={restoreAutomatic}
          onRestoreAutomaticChange={onRestoreAutomaticChange}
          brushRadius={brushRadius}
          onBrushRadiusChange={onBrushRadiusChange}
          showAssignments={showAssignments}
          onShowAssignmentsChange={onShowAssignmentsChange}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
        />
      )}

      <AutorigCorrectionFeedback
        result={correctionResult}
        updating={updating}
        onAdjustJoint={onAdjustJoint}
      />

      {visibleIssues.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3" data-autorig-pose-issues>
          {visibleIssues.map((issue) => (
            <div key={issue.id} className="space-y-1">
              <p className="text-xs text-amber-100">{issue.message}</p>
              {issue.region && !fixEnabled && (
                <button
                  type="button"
                  className="text-[11px] font-semibold text-accent underline"
                  data-autorig-enable-fix
                  onClick={() => {
                    onFixEnabledChange(true);
                    if (issue.region) onSelectRegion(issue.region);
                  }}
                >
                  Fix deformation
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
