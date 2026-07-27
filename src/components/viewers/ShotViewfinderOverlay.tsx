import React, { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { computeExportFrameLayout, type ExportFrameLayout } from '../../engine/sync';
import {
  FOCAL_LENGTH_HUD_FADE_MS,
  FOCAL_LENGTH_HUD_HIDE_DELAY_MS,
  verticalFovToFocalLength,
} from '../../engine/focalLength';
import { useThemeStore } from '../../state/useThemeStore';

export function ShotViewfinderOverlay({
  containerRef,
  aspectRatio,
  cameraAspectRatio,
  fovDegrees,
  resolutionLabel,
  focalLengthHudPulse = 0,
  variant = 'full',
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  aspectRatio: number;
  cameraAspectRatio: number;
  fovDegrees: number;
  resolutionLabel: string;
  focalLengthHudPulse?: number;
  variant?: 'full' | 'compact';
}) {
  const theme = useThemeStore((state) => state.theme);
  const [frameBox, setFrameBox] = useState<ExportFrameLayout>({ left: 0, top: 0, width: 0, height: 0 });
  const [hudPhase, setHudPhase] = useState<'hidden' | 'visible' | 'fading'>(
    () => (focalLengthHudPulse > 0 ? 'visible' : 'hidden'),
  );
  const fadeCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      setFrameBox(computeExportFrameLayout(width, height, aspectRatio));
    };

    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [aspectRatio, containerRef]);

  useEffect(() => {
    if (focalLengthHudPulse <= 0) return;

    if (fadeCompleteTimerRef.current) {
      clearTimeout(fadeCompleteTimerRef.current);
      fadeCompleteTimerRef.current = undefined;
    }
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }

    setHudPhase('visible');
    hideTimerRef.current = setTimeout(() => {
      setHudPhase((phase) => {
        if (phase !== 'visible') return phase;
        fadeCompleteTimerRef.current = setTimeout(() => {
          setHudPhase('hidden');
          fadeCompleteTimerRef.current = undefined;
        }, FOCAL_LENGTH_HUD_FADE_MS);
        return 'fading';
      });
      hideTimerRef.current = undefined;
    }, FOCAL_LENGTH_HUD_HIDE_DELAY_MS);
  }, [focalLengthHudPulse]);

  useEffect(() => () => {
    if (fadeCompleteTimerRef.current) clearTimeout(fadeCompleteTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  const dimColor = theme === 'dark' ? 'rgba(8, 12, 18, 0.62)' : 'rgba(28, 25, 23, 0.28)';
  const focalLengthLabel = `${Math.round(verticalFovToFocalLength(fovDegrees, cameraAspectRatio))} mm`;

  return (
    <div className="pointer-events-none absolute inset-0 z-10" data-shot-viewfinder={variant}>
      <div
        className="absolute border-2 border-[var(--accent)] shadow-[0_0_0_9999px_var(--viewfinder-dim)]"
        style={{
          left: frameBox.left,
          top: frameBox.top,
          width: frameBox.width,
          height: frameBox.height,
          ['--viewfinder-dim' as string]: dimColor,
        }}
      >
        <CornerMark className="left-0 top-0 -translate-x-px -translate-y-px border-l-2 border-t-2" />
        <CornerMark className="right-0 top-0 translate-x-px -translate-y-px border-r-2 border-t-2" />
        <CornerMark className="bottom-0 left-0 -translate-x-px translate-y-px border-b-2 border-l-2" />
        <CornerMark className="bottom-0 right-0 translate-x-px translate-y-px border-b-2 border-r-2" />

        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className="absolute left-1/2 top-0 h-5 w-px -translate-x-1/2 bg-white/90 shadow-sm" />
          <span className="absolute left-0 top-1/2 h-px w-5 -translate-y-1/2 bg-white/90 shadow-sm" />
          <span className="absolute right-0 top-1/2 h-px w-5 -translate-y-1/2 bg-white/90 shadow-sm" />
          <span className="absolute bottom-0 left-1/2 h-5 w-px -translate-x-1/2 bg-white/90 shadow-sm" />
        </div>

        {hudPhase !== 'hidden' && (
          <div
            className="absolute right-3 top-3 text-right transition-opacity duration-300"
            data-focal-length-hud
            style={{ opacity: hudPhase === 'visible' ? 1 : 0 }}
          >
            <div className="rounded-lg border border-white/25 bg-surface-overlay/80 px-2.5 py-1.5 shadow-card backdrop-blur">
              <div className="text-[10px] font-medium text-primary">{focalLengthLabel}</div>
              <div className="text-[9px] text-muted">Full-frame equivalent</div>
            </div>
          </div>
        )}

        {variant === 'compact' ? (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/30 bg-black/45 text-white shadow-card backdrop-blur-sm">
              <Camera className="h-3.5 w-3.5 text-accent" aria-hidden />
            </span>
          </div>
        ) : (
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/25 bg-surface-overlay px-3 py-1.5 shadow-card backdrop-blur">
            <Camera className="h-3.5 w-3.5 text-accent" />
            <span className="text-[10px] font-medium text-primary">FOV {fovDegrees.toFixed(0)}°</span>
            <span className="text-[10px] text-muted">·</span>
            <span className="font-mono text-[10px] text-secondary">{resolutionLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CornerMark({ className }: { className: string }) {
  return <span className={`absolute h-3.5 w-3.5 border-[var(--accent)] ${className}`} />;
}
