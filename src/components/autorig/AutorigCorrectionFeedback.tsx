import React from 'react';
import type { AutorigBodyRegionId } from '../../engine/autorig/regions';
import { AUTORIG_REGION_LABELS } from '../../engine/autorig/regionOverlay';
import type { AutorigCorrectionResult } from '../../engine/autorig/regionSelection';

export function formatAutorigCorrectionMessage(
  result: AutorigCorrectionResult | null | undefined,
): string | null {
  if (!result) return null;
  switch (result.status) {
    case 'changed': {
      const label = result.newRegion === 'automatic'
        ? 'automatic'
        : AUTORIG_REGION_LABELS[result.newRegion];
      if (result.newRegion === 'automatic') {
        return `Restored ${result.affectedVertexCount} vertices to automatic.`;
      }
      return `Updated ${result.affectedVertexCount} vertices to ${label}.`;
    }
    case 'unchanged':
      return `This area already belongs to ${AUTORIG_REGION_LABELS[result.region]}. Try Adjust joint if it still bends incorrectly.`;
    case 'empty':
      return 'No character surface was selected. Paint directly over the model.';
    case 'failed':
      return result.message || 'The correction could not be applied. Your previous rig has been kept.';
    default:
      return null;
  }
}

export function AutorigCorrectionFeedback({
  result,
  updating,
  onAdjustJoint,
}: {
  result?: AutorigCorrectionResult | null;
  updating?: boolean;
  onAdjustJoint?: () => void;
}) {
  const message = updating
    ? 'Updating deformation…'
    : formatAutorigCorrectionMessage(result);

  if (!message) return null;

  const showAdjust = !updating && result?.status === 'unchanged' && onAdjustJoint;

  return (
    <div
      className="space-y-1 rounded-xl border border-subtle bg-surface-muted/60 px-3 py-2"
      data-autorig-correction-feedback
      data-status={updating ? 'updating' : result?.status}
    >
      <p className="text-xs text-secondary">{message}</p>
      {showAdjust && (
        <button
          type="button"
          className="text-[11px] font-semibold text-accent underline"
          data-autorig-adjust-joint-hint
          onClick={onAdjustJoint}
        >
          Adjust joint
        </button>
      )}
    </div>
  );
}

export type { AutorigBodyRegionId };
