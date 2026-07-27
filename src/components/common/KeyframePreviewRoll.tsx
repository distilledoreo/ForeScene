import React, { useEffect, useMemo, useState } from 'react';
import type { KeyframePreviewFrame } from '../../domain/shotMedia';
import { keyframePreviewFramesSignature } from '../../domain/shotMedia';

/** Interval for cycling keyframe stills (GIF-like). */
export const KEYFRAME_ROLL_MS = 550;

export interface KeyframePreviewRollProps {
  frames: readonly KeyframePreviewFrame[];
  /** Larger chrome for full-screen media viewer. */
  size?: 'thumb' | 'full';
  className?: string;
  /**
   * When false, shows the first frame only (no interval).
   * Camera-roll thumbs should animate only when hovered/selected.
   */
  animate?: boolean;
  /** Pause autoplay while still showing a controlled frame (e.g. scrubbing). */
  paused?: boolean;
  /** Controlled keyframe id; when set with paused, freezes on that frame. */
  activeKeyframeId?: string | null;
  onActiveKeyframeIdChange?: (keyframeId: string) => void;
}

/**
 * GIF-like cycle through keyframe stills for camera-roll and full-screen preview.
 * Selection and animation are always keyed by keyframeId.
 */
export function KeyframePreviewRoll({
  frames,
  size = 'thumb',
  className = '',
  animate = true,
  paused = false,
  activeKeyframeId,
  onActiveKeyframeIdChange,
}: KeyframePreviewRollProps) {
  const signature = useMemo(() => keyframePreviewFramesSignature(frames), [frames]);
  const frameList = frames;
  const controlled = activeKeyframeId != null && activeKeyframeId !== '';
  const [internalKeyframeId, setInternalKeyframeId] = useState<string | null>(
    frameList[0]?.keyframeId ?? null,
  );

  const activeId = controlled ? activeKeyframeId : internalKeyframeId;
  const activeIndex = Math.max(
    0,
    frameList.findIndex((frame) => frame.keyframeId === activeId),
  );
  const safeIndex = frameList.length === 0 ? 0 : activeIndex >= 0 ? activeIndex : 0;
  const current = frameList[safeIndex];

  useEffect(() => {
    if (controlled) return;
    setInternalKeyframeId(frameList[0]?.keyframeId ?? null);
  }, [controlled, signature, frameList]);

  useEffect(() => {
    if (!animate || controlled || paused || frameList.length < 2) return;
    const timer = window.setInterval(() => {
      setInternalKeyframeId((currentId) => {
        const currentIdx = Math.max(
          0,
          frameList.findIndex((frame) => frame.keyframeId === currentId),
        );
        const next = frameList[(currentIdx + 1) % frameList.length];
        if (next) onActiveKeyframeIdChange?.(next.keyframeId);
        return next?.keyframeId ?? currentId;
      });
    }, KEYFRAME_ROLL_MS);
    return () => window.clearInterval(timer);
  }, [animate, controlled, frameList, onActiveKeyframeIdChange, paused, signature]);

  if (!current) return null;
  const isFull = size === 'full';

  return (
    <div
      className={`relative h-full w-full ${className}`}
      data-shot-keyframe-roll
      data-shot-keyframe-roll-size={size}
      data-shot-keyframe-roll-count={frameList.length}
      data-shot-keyframe-roll-keyframe-id={current.keyframeId}
      data-shot-keyframe-roll-index={safeIndex}
      data-shot-keyframe-roll-animate={animate && !paused ? 'true' : 'false'}
    >
      <img
        src={current.uri}
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
        {safeIndex + 1}/{frameList.length}
      </span>
    </div>
  );
}
