import React, { useMemo } from 'react';
import type { CameraKeyframe } from '../../domain/types';
import {
  getCameraKeyframeDisplayLabel,
  getSortedCameraKeyframes,
} from '../../engine/cameraKeyframes';

export interface CameraMovePreviewStripProps {
  keyframes: readonly CameraKeyframe[];
  durationSeconds: number;
  thumbsById: Readonly<Record<string, string>>;
  isPreviewing: boolean;
  /** When an MP4 has been encoded, prefer playing that over keyframe scrubbing. */
  exportedVideoUrl?: string;
  onPreview: () => void;
  onStopPreview: () => void;
  onSelectKeyframe?: (keyframeId: string) => void;
}

/**
 * Lightweight visual summary of a captured camera move: keyframe stills + play.
 * Does not encode video — uses live viewfinder preview and optional exported MP4.
 */
export function CameraMovePreviewStrip({
  keyframes,
  durationSeconds,
  thumbsById,
  isPreviewing,
  exportedVideoUrl,
  onPreview,
  onStopPreview,
  onSelectKeyframe,
}: CameraMovePreviewStripProps) {
  const sorted = useMemo(() => getSortedCameraKeyframes(keyframes), [keyframes]);
  if (sorted.length < 2) return null;

  const duration = Math.max(durationSeconds, Number.EPSILON);

  return (
    <div
      className="flex w-full max-w-sm flex-col gap-2 rounded-2xl border border-white/15 bg-black/50 p-2 shadow-soft backdrop-blur-md"
      data-camera-move-preview-strip
      data-previewing={isPreviewing ? 'true' : 'false'}
    >
      <div className="flex items-center justify-between gap-2 px-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-white/55">
          Move preview
        </p>
        <button
          type="button"
          data-camera-move-preview-play
          onClick={isPreviewing ? onStopPreview : onPreview}
          className="rounded-full bg-white px-3 py-1 text-[11px] font-bold text-black transition hover:bg-white/90"
        >
          {isPreviewing ? 'Stop' : exportedVideoUrl ? 'Play path' : 'Play path'}
        </button>
      </div>

      {exportedVideoUrl ? (
        <video
          src={exportedVideoUrl}
          controls
          playsInline
          className="aspect-video w-full rounded-lg border border-white/10 bg-black object-cover"
          data-camera-move-preview-video
        />
      ) : (
        <div
          className="flex gap-1.5 overflow-x-auto pb-0.5"
          role="list"
          aria-label="Keyframe stills"
          data-camera-move-preview-filmstrip
        >
          {sorted.map((keyframe, index) => {
            const label = getCameraKeyframeDisplayLabel(index, sorted.length);
            const thumb = thumbsById[keyframe.id];
            const timeLabel = `${keyframe.timeSeconds.toFixed(keyframe.timeSeconds % 1 === 0 ? 0 : 1)}s`;
            return (
              <button
                key={keyframe.id}
                type="button"
                role="listitem"
                data-camera-move-preview-frame
                data-keyframe-id={keyframe.id}
                onClick={() => onSelectKeyframe?.(keyframe.id)}
                className="group relative h-14 w-[4.5rem] shrink-0 overflow-hidden rounded-lg border border-white/20 bg-zinc-900 text-left transition hover:border-white/50"
                title={`${label} · ${timeLabel}`}
                aria-label={`${label} at ${timeLabel}`}
              >
                {thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-zinc-800 to-zinc-950 p-1.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide text-white/70">
                      {label}
                    </span>
                    <span className="text-[9px] tabular-nums text-white/45">{timeLabel}</span>
                  </div>
                )}
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1 pb-0.5 pt-3">
                  <span className="block truncate text-[9px] font-semibold text-white">
                    {label}
                    <span className="ml-1 font-normal tabular-nums text-white/70">{timeLabel}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!exportedVideoUrl && (
        <p className="px-0.5 text-[10px] leading-snug text-white/45">
          {isPreviewing
            ? 'Playing camera path in the viewfinder…'
            : `${sorted.length} poses · ${duration.toFixed(duration % 1 === 0 ? 0 : 1)}s · Play path animates the move`}
        </p>
      )}
    </div>
  );
}
