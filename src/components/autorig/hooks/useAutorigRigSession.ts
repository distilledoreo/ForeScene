/**
 * Session-facing helpers for the guided autorig wizard.
 * Persistent preview + partial rebind live in engine modules;
 * the dialog owns navigation and orchestrates correction revisions.
 */

export type AutorigPreparingPhase =
  | 'idle'
  | 'labeling'
  | 'weights'
  | 'ready';

export function preparingMessage(phase: AutorigPreparingPhase): string | null {
  if (phase === 'idle' || phase === 'ready') return null;
  return 'Preparing pose preview…';
}

export {
  createAutorigPreviewSession,
  applySkinBuffersToPreviewSession,
  applyPartialSkinUpdateToPreviewSession,
  type AutorigPreviewSession,
} from '../../../engine/autorig/previewSession';

export {
  generatePartialRegionConstrainedSkinWeights,
} from '../../../engine/autorig/regionConstrainedWeights';

export {
  buildDirtyVertexSet,
  createRegionEditFromLabels,
} from '../../../engine/autorig/dirtyRegionSet';
