import React from 'react';
import { Film, Image as ImageIcon } from 'lucide-react';
import type { VideoCaptureState } from '../../engine/cameraKeyframes';
import type { VideoAuthoringMode } from '../../engine/videoAuthoringMachine';

export interface ShotsCaptureChromeProps {
  mode: VideoAuthoringMode | 'still' | 'video';
  captureState: VideoCaptureState;
  isPreviewing: boolean;
  isExporting: boolean;
  landFlash: boolean;
  onStillMode: () => void;
  onVideoMode: () => void;
  onShutter: () => void;
  shutterLabel: string;
  notice?: string;
  error?: string;
  children?: React.ReactNode;
}

/** Bottom capture chrome: Still/Video toggle + primary shutter. */
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
  notice,
  error,
  children,
}: ShotsCaptureChromeProps) {
  return (
    <div
      data-shots-capture-chrome
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 px-3 pb-4"
    >
      {(notice || error) && (
        <div className="pointer-events-auto max-w-md rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white">
          {error ? <span className="text-red-300">{error}</span> : notice}
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-black/55 px-3 py-2 backdrop-blur">
        <button
          type="button"
          data-capture-mode-still
          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium ${
            mode === 'still' ? 'bg-white text-black' : 'text-white/80 hover:bg-white/10'
          }`}
          onClick={onStillMode}
        >
          <ImageIcon className="h-3.5 w-3.5" />
          Still
        </button>
        <button
          type="button"
          data-capture-mode-video
          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium ${
            mode === 'video' ? 'bg-white text-black' : 'text-white/80 hover:bg-white/10'
          }`}
          onClick={onVideoMode}
        >
          <Film className="h-3.5 w-3.5" />
          Video
        </button>
        <button
          type="button"
          data-capture-shutter
          data-capture-state={captureState}
          data-previewing={isPreviewing ? 'true' : 'false'}
          disabled={isExporting || isPreviewing}
          className={`relative flex h-14 w-14 items-center justify-center rounded-full border-4 border-white/90 bg-white text-[10px] font-semibold text-black shadow-lg disabled:opacity-50 ${
            landFlash ? 'ring-4 ring-emerald-400' : ''
          }`}
          onClick={onShutter}
          aria-label={shutterLabel}
        >
          <span className="max-w-[3.2rem] leading-tight text-center">{shutterLabel}</span>
        </button>
      </div>
      {children}
    </div>
  );
}
