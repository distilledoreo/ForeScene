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
import {
  canApplyPoseableRigPackage,
  isPoseableRigPackageFile,
  mergeImportedRigOntoTarget,
  parsePoseableRigPackageFile,
  POSEABLE_RIG_PACKAGE_ACCEPT,
  resolvePoseableRigPackageVertexCount,
  type ImportedPoseableRigPackage,
} from '../../engine/poseableRigPackage';
import { hydrateAutoriggedCharactersFromAssets } from '../../engine/autoriggedPoseableCharacter';
import { useContinuityStore } from '../../state/useContinuityStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { Modal } from './Modal';

const AXIS_OPTIONS: PoseableAxisHint[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

export interface PoseableCharacterImportMeta {
  /** True when a complete .panorig package was applied during import. */
  appliedSavedRig: boolean;
}

export function PoseableCharacterImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: (object: SceneObject, meta?: PoseableCharacterImportMeta) => void;
}) {
  const meshInputRef = useRef<HTMLInputElement>(null);
  const rigInputRef = useRef<HTMLInputElement>(null);
  const addPoseableCharacterImport = useContinuityStore((state) => state.addPoseableCharacterImport);
  const updatePoseableRigAsset = useContinuityStore((state) => state.updatePoseableRigAsset);
  const runDestructiveProjectMutation = useProjectSafetyStore((state) => state.runDestructiveProjectMutation);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [file, setFile] = useState<File>();
  const [rigFile, setRigFile] = useState<File>();
  const [rigPackageLabel, setRigPackageLabel] = useState<string>();
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
      setRigFile(undefined);
      setRigPackageLabel(undefined);
      setOrientation(defaultPoseableOrientation());
      setHeightMeters(DEFAULT_POSEABLE_HEIGHT_METERS);
      setPoseHint('a-pose');
      setPreviewSummary(undefined);
    }
  }, [open]);

  const selectFile = () => {
    if (!busy) meshInputRef.current?.click();
  };

  const selectRigFile = () => {
    if (!busy) rigInputRef.current?.click();
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

  const onRigFileChosen = (list: FileList | null) => {
    const next = list?.[0];
    if (!next || busy) return;
    if (!isPoseableRigPackageFile(next)) {
      setError('Attach a Continuity Stage .panorig rig package.');
      setRigFile(undefined);
      setRigPackageLabel(undefined);
      return;
    }
    setError(undefined);
    setRigFile(next);
    setRigPackageLabel(next.name);
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

      let appliedSavedRig = false;
      let importWarnings = [...result.warnings];
      let pendingPackage: ImportedPoseableRigPackage | undefined;
      if (rigFile) {
        setProgress('Reading saved rig…');
        pendingPackage = await parsePoseableRigPackageFile(rigFile);
        const packageVertexCount = await resolvePoseableRigPackageVertexCount(pendingPackage);
        const importedForCheck: ImportedPoseableRigPackage = {
          ...pendingPackage,
          rig: {
            ...pendingPackage.rig,
            regionMap: pendingPackage.rig.regionMap ?? (
              typeof packageVertexCount === 'number'
                ? {
                  version: 1,
                  regionAssetId: 'package',
                  vertexCount: packageVertexCount,
                  topologyHash: pendingPackage.manifest.topologyHash ?? 'unknown',
                  sourceAssetId: 'package',
                }
                : undefined
            ),
          },
        };
        const compatibility = canApplyPoseableRigPackage({
          targetRig: result.rig,
          imported: importedForCheck,
          meshVertexCount: result.vertexCount,
        });
        if (!compatibility.ok) {
          throw new Error(compatibility.reason);
        }
        pendingPackage = importedForCheck;
      }

      await runDestructiveProjectMutation('Before importing a poseable character', () => {
        const object = addPoseableCharacterImport({
          sourceAsset: result.sourceAsset,
          rigAsset: result.rigAsset,
          object: result.object,
        });

        if (pendingPackage) {
          const merged = mergeImportedRigOntoTarget({
            targetRig: result.rig,
            imported: pendingPackage,
          });
          // Keep the import orientation/height the user just chose when the package omits them.
          merged.orientation = orientation;
          merged.generationSettings = {
            ...merged.generationSettings,
            approximateHeightMeters: heightMeters,
            ...(poseHint ? { poseHint } : {}),
          };
          updatePoseableRigAsset(result.rigAsset.id, merged);
          useContinuityStore.setState((current) => ({
            project: {
              ...current.project,
              assets: {
                assets: {
                  ...current.project.assets.assets,
                  ...(pendingPackage.skinAsset
                    ? { [pendingPackage.skinAsset.id]: pendingPackage.skinAsset }
                    : {}),
                  ...(pendingPackage.regionAsset
                    ? { [pendingPackage.regionAsset.id]: pendingPackage.regionAsset }
                    : {}),
                },
              },
            },
          }));
          hydrateAutoriggedCharactersFromAssets(useContinuityStore.getState().project.assets);
          appliedSavedRig = true;
          importWarnings = [
            ...importWarnings,
            'Attached saved rig — skipping the rigging wizard.',
          ];
        }

        onImported?.(object, { appliedSavedRig });
      });

      if (appliedSavedRig) {
        const { ensureAutoriggedCharactersForProject } = await import('../../engine/autoriggedPoseableCharacter');
        await ensureAutoriggedCharactersForProject(useContinuityStore.getState().project);
      }

      setWarnings(importWarnings);
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
          Materials and textures are preserved. Optionally attach a previously saved Continuity Stage
          .panorig rig to skip the wizard when the mesh matches.
        </p>

        <input
          ref={meshInputRef}
          type="file"
          accept={POSEABLE_CHARACTER_IMPORT_ACCEPT}
          className="hidden"
          onChange={(event) => void onFileChosen(event.target.files)}
        />
        <input
          ref={rigInputRef}
          type="file"
          accept={POSEABLE_RIG_PACKAGE_ACCEPT}
          className="hidden"
          data-poseable-import-rig-input
          onChange={(event) => {
            onRigFileChosen(event.target.files);
            event.target.value = '';
          }}
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

        <div className="space-y-2 rounded-xl border border-subtle bg-surface-muted/40 p-3" data-poseable-import-rig-attach>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Saved rig (optional)</div>
              <p className="mt-0.5 text-[11px] text-secondary">
                Attach a .panorig from a previous Save rig if this is the same mesh.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={selectRigFile}
                disabled={busy}
                className="rounded-lg border border-subtle px-2.5 py-1.5 text-xs font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                data-poseable-import-choose-rig
              >
                {rigPackageLabel ? 'Change rig…' : 'Attach .panorig'}
              </button>
              {rigFile && (
                <button
                  type="button"
                  onClick={() => {
                    setRigFile(undefined);
                    setRigPackageLabel(undefined);
                  }}
                  disabled={busy}
                  className="rounded-lg border border-subtle px-2.5 py-1.5 text-xs font-semibold text-secondary hover:bg-surface-muted disabled:opacity-60"
                  data-poseable-import-clear-rig
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          {rigPackageLabel && (
            <p className="truncate text-xs text-primary" data-poseable-import-rig-name>
              {rigPackageLabel}
            </p>
          )}
        </div>

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
            {rigFile ? 'Import with rig' : 'Import character'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
