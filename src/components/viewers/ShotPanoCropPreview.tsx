import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Euler, PanoCropSettings } from '../../domain/types';

const PREVIEW_MAX_WIDTH = 640;
const PREVIEW_DEBOUNCE_MS = 140;

export function ShotPanoCropPreview({
  imageUrl,
  crop,
  panoRotation = [0, 0, 0],
  label,
  matchQuality,
  matchDistanceMeters,
  disabledReason,
}: {
  imageUrl?: string;
  crop?: PanoCropSettings;
  panoRotation?: Euler;
  label?: string;
  matchQuality?: 'good' | 'moderate' | 'poor';
  matchDistanceMeters?: number;
  disabledReason?: string;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [isRendering, setIsRendering] = useState(false);

  useEffect(() => {
    if (!imageUrl || !crop || disabledReason) {
      setPreviewUrl(undefined);
      setIsRendering(false);
      return;
    }

    const scale = crop.width > PREVIEW_MAX_WIDTH ? PREVIEW_MAX_WIDTH / crop.width : 1;
    const previewCrop: PanoCropSettings = {
      ...crop,
      width: Math.max(1, Math.round(crop.width * scale)),
      height: Math.max(1, Math.round(crop.height * scale)),
    };

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setIsRendering(true);
      void (async () => {
        const { renderPanoPerspectiveCrop } = await import('../../engine/renderers');
        return renderPanoPerspectiveCrop(imageUrl, previewCrop, panoRotation);
      })()
        .then((result) => {
          if (!cancelled) setPreviewUrl(result.dataUrl);
        })
        .catch(() => {
          // Keep the last successful crop visible; exports still report renderer errors directly.
        })
        .finally(() => {
          if (!cancelled) setIsRendering(false);
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    imageUrl,
    crop?.panoId,
    crop?.yawDegrees,
    crop?.pitchDegrees,
    crop?.rollDegrees,
    crop?.fovDegrees,
    crop?.aspectRatio,
    crop?.width,
    crop?.height,
    panoRotation[0],
    panoRotation[1],
    panoRotation[2],
    disabledReason,
  ]);

  const showParallaxWarning = !disabledReason && matchQuality && matchQuality !== 'good';

  return (
    <div className="flex min-h-0 flex-col bg-surface-raised p-4 text-primary">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-primary">Pano match</h3>
        {crop && !disabledReason && (
          <span className="font-mono text-[10px] text-secondary">
            {crop.fovDegrees.toFixed(0)}° · {crop.width}×{crop.height}
          </span>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-subtle bg-surface-base">
        {!imageUrl ? (
          <div className="flex h-full min-h-[160px] items-center justify-center px-5 text-center text-xs text-secondary">
            Link a panorama reference to preview the shot crop.
          </div>
        ) : disabledReason ? (
          <div className="flex h-full min-h-[160px] items-center justify-center px-5 text-center text-xs text-secondary">
            {disabledReason}
          </div>
        ) : !crop ? (
          <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-secondary">
            No crop settings for this shot.
          </div>
        ) : isRendering && !previewUrl ? (
          <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-secondary">
            Rendering pano crop...
          </div>
        ) : previewUrl ? (
          <img
            src={previewUrl}
            alt={`Pano crop preview for ${label ?? 'shot'}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-secondary">
            No preview yet.
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <p className="text-[11px] leading-relaxed text-secondary">
          Perspective crop at the locked camera angle — same as exported <span className="font-mono">pano_crop.png</span>, including Reference yaw.
        </p>
        {showParallaxWarning && (
          <p className="flex items-start gap-2 rounded-md border border-amber-200/70 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Camera is {matchDistanceMeters?.toFixed(1)}m from the pano origin. Framing aligns by direction only — move closer to the origin for a tighter match.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
