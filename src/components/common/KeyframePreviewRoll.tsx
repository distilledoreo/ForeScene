import React, { useEffect, useState } from 'react';

/** Interval for cycling keyframe stills (GIF-like). */
export const KEYFRAME_ROLL_MS = 550;

export interface KeyframePreviewRollProps {
  uris: readonly string[];
  /** Larger chrome for full-screen media viewer. */
  size?: 'thumb' | 'full';
  className?: string;
  /** Pause autoplay (e.g. while user is scrubbing). */
  paused?: boolean;
  /** Controlled frame index; when set, autoplay is paused. */
  activeIndex?: number;
  onIndexChange?: (index: number) => void;
}

/**
 * GIF-like cycle through keyframe stills for camera-roll and full-screen preview.
 */
export function KeyframePreviewRoll({
  uris,
  size = 'thumb',
  className = '',
  paused = false,
  activeIndex,
  onIndexChange,
}: KeyframePreviewRollProps) {
  const safeUris = uris.filter(Boolean);
  const controlled = activeIndex !== undefined;
  const [internalIndex, setInternalIndex] = useState(0);
  const index = controlled
    ? Math.min(Math.max(0, activeIndex), Math.max(0, safeUris.length - 1))
    : internalIndex;

  useEffect(() => {
    if (!controlled) setInternalIndex(0);
  }, [controlled, safeUris.join('|')]);

  useEffect(() => {
    if (controlled || paused || safeUris.length < 2) return;
    const timer = window.setInterval(() => {
      setInternalIndex((current) => {
        const next = (current + 1) % safeUris.length;
        onIndexChange?.(next);
        return next;
      });
    }, KEYFRAME_ROLL_MS);
    return () => window.clearInterval(timer);
  }, [controlled, onIndexChange, paused, safeUris.length, safeUris.join('|')]);

  if (safeUris.length === 0) return null;
  const src = safeUris[Math.min(index, safeUris.length - 1)];
  const isFull = size === 'full';

  return (
    <div
      className={`relative h-full w-full ${className}`}
      data-shot-keyframe-roll
      data-shot-keyframe-roll-size={size}
      data-shot-keyframe-roll-count={safeUris.length}
      data-shot-keyframe-roll-index={index}
    >
      <img
        src={src}
        alt=""
        className={isFull ? 'h-full w-full object-contain' : 'h-full w-full object-cover'}
      />
      <span
        className={`pointer-events-none absolute rounded bg-black/70 font-bold text-white ${
          isFull
            ? 'bottom-3 right-3 px-2 py-1 text-sm'
            : 'bottom-0.5 right-0.5 px-1 py-0.5 text-[9px]'
        }`}
        data-shot-keyframe-roll-badge
      >
        {index + 1}/{safeUris.length}
      </span>
    </div>
  );
}
