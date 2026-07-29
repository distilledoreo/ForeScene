/**
 * Session-facing helpers for the guided autorig preview.
 * Mesh binding collection lives in the engine previewSession module.
 */

export {
  collectPreviewMeshBindings,
  createAutorigPreviewSession,
  applySkinBuffersToPreviewSession,
  applyPartialSkinUpdateToPreviewSession,
  type AutorigPreviewSession,
  type AutorigPreviewMeshBinding,
  type PartialSkinWeightUpdate,
} from '../../../engine/autorig/previewSession';
