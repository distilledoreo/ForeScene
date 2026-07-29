import React from 'react';
import { FlipHorizontal2, RotateCcw } from 'lucide-react';
import type { AutorigMarker, HumanJointId } from '../../domain/types';
import { HUMAN_JOINT_LABELS } from '../../engine/humanPose';
import { markerJointsForMode } from '../../engine/autorigMarkers';

const REQUIRED_JOINTS = markerJointsForMode('full');

/** Joint-step chrome: instructions, view toggles, marker list, and actions. */
export function AutorigJointStep({
  view,
  onViewChange,
  meshReady,
  previewGlReady,
  sourceAssetId,
  selectedJointId,
  onSelectJoint,
  markers,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onMirror,
  onReset,
  onCenterDepth,
  issues,
}: {
  view: 'front' | 'side';
  onViewChange: (view: 'front' | 'side') => void;
  meshReady: boolean;
  previewGlReady: boolean;
  sourceAssetId?: string;
  selectedJointId: HumanJointId;
  onSelectJoint: (jointId: HumanJointId) => void;
  markers: AutorigMarker[];
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onMirror: () => void;
  onReset: () => void;
  onCenterDepth: () => void;
  issues: Array<{ code: string; message: string }>;
}) {
  return (
    <div className="space-y-3" data-autorig-joint-step>
      <p className="text-sm text-secondary">
        Move each dot to the matching joint. Use Side view only when the joint needs depth adjustment.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-full px-3 py-1 text-xs font-semibold ${view === 'front' ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
          onClick={() => onViewChange('front')}
          data-autorig-view-front
        >
          Front
        </button>
        <button
          type="button"
          className={`rounded-full px-3 py-1 text-xs font-semibold ${view === 'side' ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
          onClick={() => onViewChange('side')}
          data-autorig-view-side
        >
          Side
        </button>
        {sourceAssetId && (
          <span className="self-center text-[10px] text-muted" data-autorig-mesh-status>
            {!meshReady
              ? 'Loading mesh preview…'
              : previewGlReady
                ? 'Mesh preview ready'
                : 'Markers ready (mesh preview unavailable)'}
          </span>
        )}
      </div>

      <div className="space-y-2" data-autorig-marker-list>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Markers</div>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {REQUIRED_JOINTS.map((jointId) => {
            const present = markers.some((marker) => marker.jointId === jointId);
            return (
              <button
                key={jointId}
                type="button"
                onClick={() => onSelectJoint(jointId)}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs ${
                  selectedJointId === jointId ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'
                }`}
                data-autorig-marker-list-item={jointId}
              >
                <span>{HUMAN_JOINT_LABELS[jointId]}</span>
                <span className="opacity-70">{present ? '•' : '—'}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50" onClick={onUndo} disabled={!canUndo}>Undo</button>
        <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50" onClick={onRedo} disabled={!canRedo}>Redo</button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
          onClick={onMirror}
        >
          <FlipHorizontal2 className="h-3.5 w-3.5" /> Mirror left to right
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
          data-autorig-restore-suggested
          onClick={onReset}
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset suggested joints
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50"
          data-autorig-center-depth
          onClick={onCenterDepth}
          disabled={!meshReady}
        >
          Center depth
        </button>
      </div>

      {issues.length > 0 && (
        <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100" data-autorig-marker-issues>
          {issues.map((issue) => <p key={`${issue.code}-${issue.message}`}>{issue.message}</p>)}
        </div>
      )}
    </div>
  );
}
