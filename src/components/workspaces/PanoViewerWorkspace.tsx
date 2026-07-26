import React, { useRef, useState } from 'react';
import { Download, ImagePlus, Loader2 } from 'lucide-react';
import { Euler, PanoViewState } from '../../domain/types';
import { preparePanoImport } from '../../engine/panoImage';
import { downloadDataUrl, readFileAsDataUrl } from '../../engine/fileTransfers';
import { PrimaryCTA } from '../common/PrimaryCTA';
import { PanoViewer } from '../viewers/PanoViewer';
import { FullBleedLayout } from './WorkspaceShell';

const DEFAULT_DOWNLOAD_WIDTH = 3840;
const DEFAULT_DOWNLOAD_HEIGHT = 2160;
const DEFAULT_VIEW: PanoViewState = { yawDegrees: 0, pitchDegrees: 0, fovDegrees: 75 };
const IDENTITY_ROTATION: Euler = [0, 0, 0];

/**
 * Simple 360 viewer — fully isolated from Continuity Stage project state.
 * Importing a pano here uses local component state only (no project mutations).
 */
export function PanoViewerWorkspace() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [imageName, setImageName] = useState('pano');
  const [imageWidth, setImageWidth] = useState(DEFAULT_DOWNLOAD_WIDTH);
  const [imageHeight, setImageHeight] = useState(DEFAULT_DOWNLOAD_HEIGHT);
  const [view, setView] = useState<PanoViewState>(DEFAULT_VIEW);

  const importPano = async (file?: File) => {
    if (!file) return;
    setIsImporting(true);
    setError(undefined);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const dimensions = await getImageDimensions(dataUrl);
      const prepared = await preparePanoImport(dataUrl, dimensions.width, dimensions.height);
      setImageUrl(prepared.dataUrl);
      setImageName(file.name || 'pano.png');
      setImageWidth(prepared.width);
      setImageHeight(prepared.height);
      setView(DEFAULT_VIEW);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import pano.');
    } finally {
      setIsImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadCurrentView = async () => {
    if (!imageUrl) return;
    setIsDownloading(true);
    setError(undefined);
    try {
      const width = DEFAULT_DOWNLOAD_WIDTH;
      const height = DEFAULT_DOWNLOAD_HEIGHT;
      const { renderPanoPerspectiveCrop } = await import('../../engine/renderers');
      const frame = await renderPanoPerspectiveCrop(
        imageUrl,
        {
          panoId: 'simple-viewer',
          yawDegrees: view.yawDegrees,
          pitchDegrees: view.pitchDegrees,
          rollDegrees: 0,
          fovDegrees: view.fovDegrees,
          aspectRatio: width / height,
          width,
          height,
        },
        IDENTITY_ROTATION,
      );
      const baseName = imageName
        .replace(/\.[^.]+$/, '')
        .replace(/\s+/g, '_')
        .toLowerCase() || 'pano_view';
      downloadDataUrl(frame.dataUrl, `${baseName}_${width}x${height}.png`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download current view.');
    } finally {
      setIsDownloading(false);
    }
  };

  const onViewChange = (updates: Partial<PanoViewState>) => {
    setView((current) => ({ ...current, ...updates }));
  };

  return (
    <FullBleedLayout reserveHeader>
      <div className="relative h-full min-h-0 w-full" data-pano-viewer-workspace data-pano-viewer-isolated>
        <PanoViewer
          imageUrl={imageUrl}
          view={view}
          onViewChange={onViewChange}
          label={imageUrl ? imageName : undefined}
          panoRotation={IDENTITY_ROTATION}
        />

        {!imageUrl && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div className="pointer-events-auto max-w-md space-y-3 rounded-[var(--radius-card)] border border-subtle bg-surface-overlay p-6 text-center shadow-soft backdrop-blur-sm">
              <h2 className="text-lg font-semibold text-primary">Import a 360 pano</h2>
              <p className="text-sm text-secondary">
                Drop in an equirectangular image, look around, then download the current view as a flat PNG.
                This mode does not change your Continuity Stage project.
              </p>
              <p className="text-xs text-muted">Use Import pano in the bottom bar to get started.</p>
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-3 p-5">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              data-pano-viewer-import-input
              onChange={(event) => void importPano(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={isImporting}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-subtle bg-surface-overlay/90 px-3 py-2 text-xs font-semibold text-secondary shadow-card backdrop-blur-sm transition hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {isImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
              {isImporting ? 'Importing…' : imageUrl ? 'Replace pano' : 'Import pano'}
            </button>
            {imageUrl && (
              <label className="inline-flex items-center gap-2 rounded-xl border border-subtle bg-surface-overlay/90 px-3 py-2 text-xs text-secondary shadow-card backdrop-blur-sm">
                <span className="font-medium">FOV</span>
                <input
                  type="range"
                  min={30}
                  max={120}
                  step={1}
                  value={view.fovDegrees}
                  onChange={(event) => onViewChange({ fovDegrees: Number(event.target.value) })}
                  className="w-24 accent-[var(--accent)]"
                  aria-label="Field of view"
                />
                <span className="w-8 tabular-nums text-primary">{Math.round(view.fovDegrees)}°</span>
              </label>
            )}
            {imageUrl && (
              <span className="rounded-full bg-black/40 px-2 py-1 text-[10px] font-medium text-white/70 backdrop-blur-sm">
                {imageWidth}×{imageHeight}
              </span>
            )}
          </div>

          {imageUrl && (
            <div className="pointer-events-auto">
              <PrimaryCTA
                icon={isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                label={isDownloading ? 'Rendering…' : 'Download current view'}
                hint="Saves a flat PNG of what you are looking at right now."
                onClick={() => void downloadCurrentView()}
                disabled={isDownloading}
                highlighted
              />
            </div>
          )}
        </div>

        {error && (
          <div
            className="absolute left-1/2 top-[calc(var(--stage-header-safe)+0.75rem)] z-30 max-w-md -translate-x-1/2 rounded-lg border border-red-400/70 bg-surface-overlay px-3 py-2 text-sm text-primary shadow-card"
            role="alert"
          >
            {error}
          </div>
        )}
      </div>
    </FullBleedLayout>
  );
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Could not read image dimensions.'));
    image.src = dataUrl;
  });
}
