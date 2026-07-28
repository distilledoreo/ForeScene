import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, Upload, UserRound } from 'lucide-react';
import type { PoseableAxisHint, PoseableCharacterOrientation, SceneObject } from '../../domain/types';
import {
  DEFAULT_POSEABLE_HEIGHT_METERS,
  MAX_POSEABLE_HEIGHT_METERS,
  MIN_POSEABLE_HEIGHT_METERS,
  POSEABLE_CHARACTER_IMPORT_ACCEPT,
  defaultPoseableOrientation,
  importPoseableCharacter,
  loadPoseableCharacterPreview,
} from '../../engine/poseableCharacterImport';
import { useContinuityStore } from '../../state/useContinuityStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { Modal } from './Modal';

const AXIS_OPTIONS: PoseableAxisHint[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

export function PoseableCharacterImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: (object: SceneObject) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addPoseableCharacterImport = useContinuityStore((state) => state.addPoseableCharacterImport);
  const runDestructiveProjectMutation = useProjectSafetyStore((state) => state.runDestructiveProjectMutation);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [file, setFile] = useState<File>();
  const [orientation, setOrientation] = useState<PoseableCharacterOrientation>(defaultPoseableOrientation);
  const [heightMeters, setHeightMeters] = useState(DEFAULT_POSEABLE_HEIGHT_METERS);
  const [poseHint, setPoseHint] = useState<'a-pose' | 't-pose'>('a-pose');
  const [previewSummary, setPreviewSummary] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setBusy(false);
      setProgress(undefined);
      setError(undefined);
      setWarnings([]);
      setFile(undefined);
      setOrientation(defaultPoseableOrientation());
      setHeightMeters(DEFAULT_POSEABLE_HEIGHT_METERS);
      setPoseHint('a-pose');
      setPreviewSummary(undefined);
    }
  }, [open]);

  const selectFile = () => {
    if (!busy) inputRef.current?.click();
  };

  const onFileChosen = async (list: FileList | null) => {
    const next = list?.[0];
    if (!next || busy) return;
    setError(undefined);
    setWarnings([]);
    setFile(next);
    setBusy(true);
    setProgress('Loading mesh preview…');
    abortRef.current = new AbortController();
    try {
      const preview = await loadPoseableCharacterPreview(next, abortRef.current.signal);
      setHeightMeters(preview.suggestedHeightMeters);
      setWarnings(preview.warnings);
      setPreviewSummary(
        `${preview.meshCount} mesh${preview.meshCount === 1 ? '' : 'es'} · `
        + `bounds ${preview.size.map((v) => v.toFixed(2)).join(' × ')} m`,
      );
    } catch (err) {
      setFile(undefined);
      setPreviewSummary(undefined);
      setError(err instanceof Error ? err.message : 'Could not load the selected file.');
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  const importSelected = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(undefined);
    abortRef.current = new AbortController();
    try {
      const result = await importPoseableCharacter({
        file,
        orientation,
        approximateHeightMeters: heightMeters,
        poseHint,
        signal: abortRef.current.signal,
        onProgress: setProgress,
      });
      if (!runDestructiveProjectMutation) {
        throw new Error('Local recovery is still starting. Please wait before importing a poseable character.');
      }
      await runDestructiveProjectMutation('Before importing a poseable character', () => {
        const object = addPoseableCharacterImport({
          sourceAsset: result.sourceAsset,
          rigAsset: result.rigAsset,
          object: result.object,
        });
        onImported?.(object);
      });
      setWarnings(result.warnings);
      onClose();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Import cancelled.');
      } else {
        setError(err instanceof Error ? err.message : 'Poseable character import failed.');
      }
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) abortRef.current?.abort();
        onClose();
      }}
      title="Import poseable character"
      size="lg"
    >
      <div className="space-y-4" data-poseable-character-import-dialog>
        <p className="text-sm text-secondary">
          Separate from ordinary graybox import. Accepts one upright A-pose or T-pose humanoid GLB/glTF.
          Materials and textures are preserved. Skin weights are not generated yet — this step stores the
          source and orientation so autorigging can be retried later.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={POSEABLE_CHARACTER_IMPORT_ACCEPT}
          className="hidden"
          onChange={(event) => void onFileChosen(event.target.files)}
        />

        <button
          type="button"
          onClick={selectFile}
          disabled={busy}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-subtle px-3 py-3 text-sm font-semibold text-secondary transition hover:border-accent hover:text-accent disabled:opacity-60"
          data-poseable-import-choose-file
        >
          <Upload className="h-4 w-4" />
          {file ? file.name : 'Choose GLB / glTF'}
        </button>

        {previewSummary && (
          <p className="text-xs text-muted" data-poseable-import-preview-summary>{previewSummary}</p>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-secondary">
            <span className="font-semibold uppercase tracking-wide text-muted">Front</span>
            <select
              value={orientation.frontAxis}
              disabled={busy}
              onChange={(event) => setOrientation((current) => ({
                ...current,
                frontAxis: event.target.value as PoseableAxisHint,
              }))}
              className="w-full rounded-lg border border-subtle bg-surface px-2 py-2 text-sm text-primary"
              data-poseable-import-front-axis
            >
              {AXIS_OPTIONS.map((axis) => <option key={axis} value={axis}>{axis}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-secondary">
            <span className="font-semibold uppercase tracking-wide text-muted">Up</span>
            <select
              value={orientation.upAxis}
              disabled={busy}
              onChange={(event) => setOrientation((current) => ({
                ...current,
                upAxis: event.target.value as PoseableAxisHint,
              }))}
              className="w-full rounded-lg border border-subtle bg-surface px-2 py-2 text-sm text-primary"
              data-poseable-import-up-axis
            >
              {AXIS_OPTIONS.map((axis) => <option key={axis} value={axis}>{axis}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-secondary">
            <span className="font-semibold uppercase tracking-wide text-muted">Ground (m)</span>
            <input
              type="number"
              step={0.01}
              value={orientation.groundLevelMeters}
              disabled={busy}
              onChange={(event) => setOrientation((current) => ({
                ...current,
                groundLevelMeters: Number(event.target.value) || 0,
              }))}
              className="w-full rounded-lg border border-subtle bg-surface px-2 py-2 text-sm text-primary"
              data-poseable-import-ground-level
            />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-secondary">
            <span className="font-semibold uppercase tracking-wide text-muted">Approx. height (m)</span>
            <input
              type="number"
              min={MIN_POSEABLE_HEIGHT_METERS}
              max={MAX_POSEABLE_HEIGHT_METERS}
              step={0.01}
              value={heightMeters}
              disabled={busy}
              onChange={(event) => setHeightMeters(Number(event.target.value) || DEFAULT_POSEABLE_HEIGHT_METERS)}
              className="w-full rounded-lg border border-subtle bg-surface px-2 py-2 text-sm text-primary"
              data-poseable-import-height
            />
          </label>
          <label className="space-y-1 text-xs text-secondary">
            <span className="font-semibold uppercase tracking-wide text-muted">Rest pose hint</span>
            <select
              value={poseHint}
              disabled={busy}
              onChange={(event) => setPoseHint(event.target.value as 'a-pose' | 't-pose')}
              className="w-full rounded-lg border border-subtle bg-surface px-2 py-2 text-sm text-primary"
              data-poseable-import-pose-hint
            >
              <option value="a-pose">A-pose</option>
              <option value="t-pose">T-pose</option>
            </select>
          </label>
        </div>

        {warnings.length > 0 && (
          <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200" data-poseable-import-warnings>
            {warnings.map((warning) => (
              <p key={warning} className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{warning}</span>
              </p>
            ))}
          </div>
        )}

        {error && (
          <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" data-poseable-import-error>
            {error}
          </p>
        )}

        {progress && (
          <p className="inline-flex items-center gap-2 text-xs text-muted" data-poseable-import-progress>
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {progress}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-subtle pt-3">
          <button
            type="button"
            className="rounded-xl border border-subtle px-3 py-2 text-sm font-semibold text-secondary hover:bg-surface-muted"
            onClick={() => {
              abortRef.current?.abort();
              onClose();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!file || busy}
            onClick={() => void importSelected()}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            data-poseable-import-confirm
          >
            <UserRound className="h-4 w-4" />
            Import character
          </button>
        </div>
      </div>
    </Modal>
  );
}
