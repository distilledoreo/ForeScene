import React, { useRef, useState } from 'react';
import { ImagePlus, LoaderCircle } from 'lucide-react';
import { STYLED_PANO } from '../../domain/copy';
import { analyzeEquirectImage, EQUIRECT_ASPECT, isAspectRatio, preparePanoImport } from '../../engine/panoImage';
import { readFileAsDataUrl } from '../../engine/fileTransfers';
import {
  resolveStyledImportMode,
  styledImportActionHint,
  styledImportActionLabel,
} from '../../engine/panoProjectionCore';
import { useContinuityStore } from '../../state/useContinuityStore';
import { IconButton } from './Field';

export function StyledPanoImportButton({
  label,
  className,
  primary = false,
  highlighted = false,
  modeAware = false,
  onImported,
}: {
  label?: string;
  className?: string;
  primary?: boolean;
  highlighted?: boolean;
  /** When true, label/hint follow replace vs add-secondary based on capture origin. */
  modeAware?: boolean;
  onImported?: (mode: 'first' | 'replace' | 'add_secondary') => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const project = useContinuityStore((state) => state.project);
  const pendingSecondCapturePlan = useContinuityStore(
    (state) => state.pendingSecondCapturePlan,
  );
  const importStyledPano = useContinuityStore((state) => state.importStyledPano);
  const [error, setError] = useState<string | undefined>();
  const [warning, setWarning] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const mode = resolveStyledImportMode(project, { pendingSecondCapturePlan });
  const resolvedLabel = label
    ?? (modeAware ? styledImportActionLabel(mode) : STYLED_PANO.importAction);
  const hint = modeAware ? styledImportActionHint(mode) : undefined;

  const importFile = async (file?: File) => {
    if (!file || busy) return;
    setError(undefined);
    setWarning(undefined);
    setBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const dimensions = await getImageDimensions(dataUrl);
      const analysis = analyzeEquirectImage(dimensions.width, dimensions.height);
      const aspect = dimensions.width / Math.max(1, dimensions.height);
      if (
        !isAspectRatio(aspect, EQUIRECT_ASPECT)
        && !analysis.wasLetterboxed
      ) {
        setWarning(
          `Image is ${dimensions.width}×${dimensions.height} (not 2:1 equirectangular). 360 viewing may look distorted.`,
        );
      }
      const prepared = await preparePanoImport(dataUrl, dimensions.width, dimensions.height);
      const importedMode = importStyledPano({
        name: file.name,
        dataUrl: prepared.dataUrl,
        width: prepared.width,
        height: prepared.height,
        importNote: prepared.analysis.wasLetterboxed
          ? `Imported from ${dimensions.width}×${dimensions.height} letterboxed 16:9; extracted ${prepared.width}×${prepared.height} equirectangular region.`
          : undefined,
      });
      onImported?.(importedMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import panorama image.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => void importFile(event.target.files?.[0])}
      />
      <div className="space-y-1.5">
        <IconButton
          onClick={() => fileRef.current?.click()}
          highlighted={highlighted}
          disabled={busy}
          className={`w-full ${primary && !highlighted ? 'border-[var(--accent)] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]' : ''} ${className ?? ''}`}
          data-styled-pano-import
          data-import-mode={mode}
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
          {busy ? 'Importing…' : resolvedLabel}
        </IconButton>
        {hint && !error && !busy && (
          <p className="text-[11px] leading-snug text-muted">{hint}</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-500">{error}</p>
        )}
        {warning && !error && (
          <p role="status" className="text-xs text-amber-600 dark:text-amber-400">{warning}</p>
        )}
      </div>
    </>
  );
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('Image decoded with zero size.'));
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => reject(new Error('Could not decode image. Use a valid PNG, JPEG, or WebP.'));
    image.src = dataUrl;
  });
}
