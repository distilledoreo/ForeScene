/**
 * Helpers for cheap keyframe stills used by the filmstrip / camera-roll roll.
 * Generation counters invalidate in-flight renders after undo/redo restore.
 */

export function buildKeyframeThumbCacheFromKeyframes(
  keyframes: readonly { id: string; previewUri?: string }[],
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const keyframe of keyframes) {
    if (!keyframe.previewUri) continue;
    entries.push([keyframe.id, keyframe.previewUri]);
  }
  return Object.fromEntries(entries);
}

/** True when a finished render may still write into the live project/cache. */
export function shouldCommitKeyframeThumb(params: {
  renderGeneration: number;
  currentGeneration: number;
}): boolean {
  return params.renderGeneration === params.currentGeneration;
}

/**
 * Apply a completed thumb only if generation still matches.
 * Returns undefined when the write must be dropped (undo/redo raced the render).
 */
export function commitKeyframeThumbIfCurrent(params: {
  renderGeneration: number;
  currentGeneration: number;
  keyframeId: string;
  dataUrl: string;
  keyframes: readonly { id: string; previewUri?: string }[];
}): { nextCache: Record<string, string>; nextKeyframes: Array<{ id: string; previewUri?: string } & Record<string, unknown> > } | undefined {
  if (!shouldCommitKeyframeThumb(params)) return undefined;
  const nextCache = {
    ...buildKeyframeThumbCacheFromKeyframes(params.keyframes),
    [params.keyframeId]: params.dataUrl,
  };
  const nextKeyframes = params.keyframes.map((keyframe) => (
    keyframe.id === params.keyframeId
      ? { ...keyframe, previewUri: params.dataUrl }
      : { ...keyframe }
  ));
  return { nextCache, nextKeyframes };
}
