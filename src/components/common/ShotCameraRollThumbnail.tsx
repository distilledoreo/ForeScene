import React, { useEffect, useMemo, useState } from 'react';
import { Film, Play } from 'lucide-react';
import {
  hasShotCapture,
  resolveCameraKeyframePreviewUris,
  resolveShotMedia,
  resolveShotMediaPoster,
  shotHasCameraKeyframeMove,
  shotHasCameraMoveVideo,
} from '../../domain/shotMedia';
import { LocationProject, Shot } from '../../domain/types';

/** Interval for cycling keyframe stills in the camera roll (GIF-like). */
const KEYFRAME_ROLL_MS = 550;

function NoCapturePlaceholder({ compact }: { compact?: boolean }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center bg-zinc-900 text-white/45"
      data-shot-camera-roll-empty
    >
      <span className={compact ? 'text-[8px] font-semibold uppercase tracking-wide' : 'text-[10px] font-semibold uppercase tracking-wide'}>
        No capture
      </span>
    </div>
  );
}

function KeyframeRollAnimation({
  uris,
  compact,
}: {
  uris: string[];
  compact?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const safeUris = uris.filter(Boolean);

  useEffect(() => {
    setIndex(0);
  }, [safeUris.join('|')]);

  useEffect(() => {
    if (safeUris.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % safeUris.length);
    }, KEYFRAME_ROLL_MS);
    return () => window.clearInterval(timer);
  }, [safeUris.length, safeUris.join('|')]);

  if (safeUris.length === 0) return null;
  const src = safeUris[Math.min(index, safeUris.length - 1)];

  return (
    <div
      className="relative h-full w-full"
      data-shot-keyframe-roll
      data-shot-keyframe-roll-count={safeUris.length}
      data-shot-keyframe-roll-index={index}
    >
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
      />
      <span
        className={`pointer-events-none absolute bottom-0.5 right-0.5 rounded bg-black/70 font-bold text-white ${
          compact ? 'px-0.5 text-[7px]' : 'px-1 py-0.5 text-[9px]'
        }`}
        data-shot-keyframe-roll-badge
      >
        {index + 1}/{safeUris.length}
      </span>
    </div>
  );
}

export function ShotCameraRollThumbnail({
  project,
  shot,
  overrideSrc,
  allowLivePreview = false,
  className,
  compact,
  showMediaCount,
  showCapturedBadge,
  landed,
}: {
  project: LocationProject;
  shot: Shot;
  /** Live preview from the viewfinder — only shown when allowLivePreview is true. */
  overrideSrc?: string;
  allowLivePreview?: boolean;
  className?: string;
  compact?: boolean;
  showMediaCount?: boolean;
  showCapturedBadge?: boolean;
  landed?: boolean;
}) {
  const poster = resolveShotMediaPoster(project, shot);
  const mediaCount = resolveShotMedia(project, shot).length;
  const hasCapture = hasShotCapture(project, shot);
  const hasCameraMove = shotHasCameraMoveVideo(project, shot);
  const hasKeyframeMove = shotHasCameraKeyframeMove(shot);
  const keyframePreviewUris = useMemo(
    () => resolveCameraKeyframePreviewUris(shot),
    [shot.cameraKeyframes],
  );
  const useKeyframeRoll = keyframePreviewUris.length >= 2;
  const src = poster?.kind === 'image' ? poster.asset.uri : undefined;
  const videoSrc = poster?.kind === 'video' ? poster.asset.uri : undefined;
  const previewSrc = allowLivePreview && !hasCapture ? overrideSrc : undefined;
  const sizeClassName = className ?? 'h-full w-full';

  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-zinc-900 ${sizeClassName}`}
      data-shot-camera-roll-thumb
      data-shot-has-capture={hasCapture ? 'true' : 'false'}
      data-shot-has-keyframe-move={hasKeyframeMove ? 'true' : 'false'}
    >
      {useKeyframeRoll ? (
        <KeyframeRollAnimation uris={keyframePreviewUris} compact={compact} />
      ) : src ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : previewSrc ? (
        <img
          src={previewSrc}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : videoSrc ? (
        <video
          src={videoSrc}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
      ) : keyframePreviewUris.length === 1 ? (
        <img
          src={keyframePreviewUris[0]}
          alt=""
          className="h-full w-full object-cover"
          data-shot-keyframe-still
        />
      ) : (
        <NoCapturePlaceholder compact={compact} />
      )}

      {hasCameraMove && !useKeyframeRoll && (
        <span
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25"
          aria-hidden
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white">
            <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
          </span>
        </span>
      )}

      {hasKeyframeMove && !hasCameraMove && (
        <span
          className="pointer-events-none absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-black/65 px-1 py-0.5 text-[9px] font-semibold text-white"
          data-shot-keyframe-move-badge
          title={`${shot.cameraKeyframes.length} keyframes`}
        >
          <Film className="h-2.5 w-2.5" />
          {shot.cameraKeyframes.length}
        </span>
      )}

      {showMediaCount && mediaCount > 1 && (
        <span className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-white">
          {mediaCount}
        </span>
      )}

      {showCapturedBadge && landed && (
        <span className="absolute bottom-1 left-1 rounded bg-black/65 px-1 py-0.5 text-[9px] font-semibold text-emerald-300">
          ✓
        </span>
      )}
    </div>
  );
}
