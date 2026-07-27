import React from 'react';
import { Check } from 'lucide-react';
import type { VideoCaptureState } from '../../engine/cameraKeyframes';
import type { VideoAuthoringMode } from '../../engine/videoAuthoringMachine';

export interface ShotsCaptureChromeProps {
  mode: VideoAuthoringMode | 'still' | 'video';
  captureState: VideoCaptureState;
  isPreviewing: boolean;
  isExporting: boolean;
  landFlash?: boolean;
  onStillMode: () => void;
  onVideoMode: () => void;
  onShutter: () => void;
  shutterLabel: string;
  shutterTitle?: string;
  notice?: string;
  error?: string;
  /** Left of shutter (library thumb). */
  librarySlot?: React.ReactNode;
  /** Right of shutter (adjacent nav). */
  navSlot?: React.ReactNode;
  /** Video filmstrip / timeline / duration chrome above the shutter row. */
  children?: React.ReactNode;
  /** Hint under shutter. */
  hint?: string;
}

/** Bottom capture chrome: Still/Video toggle + primary shutter (real composition root for capture). */
export function ShotsCaptureChrome({
  mode,
  captureState,
  isPreviewing,
  isExporting,
  landFlash,
  onStillMode,
  onVideoMode,
  onShutter,
  shutterLabel,
  shutterTitle,
  notice,
  error,
  librarySlot,
  navSlot,
  children,
  hint,
}: ShotsCaptureChromeProps) {
  const videoMode = mode === 'video';
  const finishedVideo = videoMode && captureState === 'finished';

  return (
    <div
      data-shots-capture-chrome
      data-shots-camera-chrome
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-4 pb-6 pt-10"
      style={{
        background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.35) 55%, transparent 100%)',
      }}
    >
      <div
        data-shots-mode-switcher
        className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/40 p-1 backdrop-blur-md"
      >
        <button
          type="button"
          data-capture-mode-still
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
            mode === 'still' ? 'bg-white text-black' : 'text-white/80 hover:bg-white/10'
          }`}
          onClick={onStillMode}
        >
          Still
        </button>
        <button
          type="button"
          data-capture-mode-video
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
            videoMode ? 'bg-white text-black' : 'text-white/80 hover:bg-white/10'
          }`}
          onClick={onVideoMode}
        >
          Video
        </button>
      </div>

      {children}

      {(notice || error) && (
        <div
          role="alert"
          className="pointer-events-auto max-w-md rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white"
        >
          {error ? <span className="text-red-300">{error}</span> : notice}
        </div>
      )}

      <div className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-4 px-2">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center">
          {librarySlot}
        </div>

        <button
          type="button"
          data-capture-shutter
          data-shots-shutter
          data-capture-state={captureState}
          data-previewing={isPreviewing ? 'true' : 'false'}
          data-shots-video-capture-state={videoMode ? captureState : undefined}
          data-shots-video-shutter-next={finishedVideo ? 'true' : undefined}
          disabled={isExporting || (videoMode && isPreviewing)}
          className={`group relative flex h-[4.75rem] w-[4.75rem] shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 ${
            landFlash ? 'ring-4 ring-emerald-400' : ''
          }`}
          onClick={onShutter}
          aria-label={shutterLabel}
          title={shutterTitle ?? shutterLabel}
        >
          <span className="absolute inset-0 rounded-full border-[3px] border-white/90" />
          {finishedVideo ? (
            <span className="flex h-[3.65rem] w-[3.65rem] items-center justify-center rounded-full bg-white text-zinc-900 transition group-active:scale-95">
              <Check className="h-7 w-7" strokeWidth={2.5} />
            </span>
          ) : (
            <span
              className={`h-[3.65rem] w-[3.65rem] rounded-full transition ${
                videoMode
                  ? 'bg-red-500 group-active:scale-95'
                  : 'bg-white group-active:scale-90'
              }`}
            />
          )}
        </button>

        <div className="flex h-14 w-14 shrink-0 items-center justify-center">
          {navSlot}
        </div>
      </div>

      {hint && (
        <p className="pointer-events-none text-center text-[11px] font-medium text-white/70">
          {hint}
        </p>
      )}
    </div>
  );
}
