import React, { useEffect, useRef, useState } from 'react';
import { Download, MoreHorizontal, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { getShotPrimaryLabel, hasCustomShotTitle } from '../../domain/shotIdentity';
import { resolveShotMedia, resolveShotMediaPoster } from '../../domain/shotMedia';
import { LocationProject, ProjectAsset, Shot } from '../../domain/types';
import { getBackgroundVideoServiceStatus } from '../../engine/backgroundVideoService';
import { buildVideoArtifactSpecificationsForShot } from '../../engine/backgroundVideoPreparation';
import { downloadDataUrl } from '../../engine/fileTransfers';
import {
  cancelShotStillPreparation,
  regenerateShotStills,
  retryFailedShotStills,
} from '../../engine/shotStillActions';
import { inspectShotStillRuntime } from '../../engine/stillArtifactRuntime';
import { usePreparedMediaRuntimeTick } from '../../hooks/usePreparedMediaRuntimeTick';
import { useProjectStore } from '../../state/useProjectStore';
import { AnchoredMenuPopover } from './AnchoredMenuPopover';
import { ShotCameraRollThumbnail } from './ShotCameraRollThumbnail';

export function ShotsLibraryCard({
  project,
  shot,
  selected,
  landed,
  canDelete,
  sheetOpen,
  onOpenMedia,
  onOpenShot,
  onRename,
  onRequestDelete,
}: {
  project: LocationProject;
  shot: Shot;
  selected: boolean;
  landed: boolean;
  canDelete: boolean;
  sheetOpen: boolean;
  onOpenMedia: (shotId: string) => void;
  onOpenShot: (shotId: string) => void;
  onRename: (shotId: string, updates: { productionShotId?: string; name: string }) => void;
  onRequestDelete: (shot: Shot) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [preparedActionBusy, setPreparedActionBusy] = useState(false);
  const [draftProductionId, setDraftProductionId] = useState(shot.productionShotId ?? '');
  const [draftTitle, setDraftTitle] = useState(shot.name);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const poster = resolveShotMediaPoster(project, shot);
  const primaryLabel = getShotPrimaryLabel(shot);
  const customTitle = hasCustomShotTitle(shot);

  // Runtime preparation state intentionally lives outside the project document.
  // One shared clock keeps cards current while queued/running jobs change.
  usePreparedMediaRuntimeTick();
  const preparedStatus = inspectShotStillRuntime(project, shot);
  const preparedUpdating = preparedStatus.artifacts.some(
    (artifact) => artifact.status === 'queued' || artifact.status === 'rendering',
  );
  const preparedNeedsAttention = preparedStatus.artifacts.some(
    (artifact) => artifact.status === 'failed'
      || artifact.status === 'missing'
      || artifact.status === 'stale',
  );
  const videoRequested = buildVideoArtifactSpecificationsForShot(project, shot).length > 0;
  const backgroundVideoStatus = getBackgroundVideoServiceStatus();
  const backgroundVideoActive = selected
    && videoRequested
    && (backgroundVideoStatus.running || backgroundVideoStatus.pending > 0);

  useEffect(() => {
    if (!sheetOpen) setMenuOpen(false);
  }, [sheetOpen]);

  useEffect(() => {
    if (!renaming) {
      setDraftProductionId(shot.productionShotId ?? '');
      setDraftTitle(shot.name);
    }
  }, [renaming, shot.productionShotId, shot.name]);

  const commitRename = () => {
    onRename(shot.id, {
      productionShotId: draftProductionId,
      name: draftTitle,
    });
    setRenaming(false);
  };

  const cancelRename = () => {
    setDraftProductionId(shot.productionShotId ?? '');
    setDraftTitle(shot.name);
    setRenaming(false);
  };

  const downloadPrimaryAsset = () => {
    const media = resolveShotMedia(project, shot);
    const item = media[0];
    if (!item) return;
    downloadAsset(item.asset);
    setMenuOpen(false);
  };

  const requestDelete = () => {
    setMenuOpen(false);
    if (!canDelete) return;
    onRequestDelete(shot);
  };

  const preparedActionParams = () => ({
    project: useProjectStore.getState().project,
    shotId: shot.id,
    getLiveProject: () => useProjectStore.getState().project,
    commitLiveProject: (updater: (live: LocationProject) => LocationProject) => {
      useProjectStore.setState((current) => ({
        project: updater(current.project),
      }));
      return useProjectStore.getState().project;
    },
  });

  const runRegenerate = () => {
    setMenuOpen(false);
    setPreparedActionBusy(true);
    void regenerateShotStills(preparedActionParams())
      .finally(() => setPreparedActionBusy(false));
  };

  const runRetry = () => {
    setMenuOpen(false);
    setPreparedActionBusy(true);
    void retryFailedShotStills(preparedActionParams())
      .finally(() => setPreparedActionBusy(false));
  };

  const runCancel = () => {
    cancelShotStillPreparation(shot.id);
    setPreparedActionBusy(false);
    setMenuOpen(false);
  };

  return (
    <div
      className={`relative w-28 shrink-0 overflow-hidden rounded-xl border transition ${
        selected ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]' : 'border-white/15'
      }`}
      data-shots-library-card
      data-shot-id={shot.id}
    >
      <button
        type="button"
        onClick={() => onOpenMedia(shot.id)}
        className="block w-full"
        aria-label={`Inspect capture for ${primaryLabel}`}
        data-shots-library-thumb
      >
        <ShotCameraRollThumbnail
          project={project}
          shot={shot}
          className="h-20 w-28 object-cover"
          showMediaCount
          showCapturedBadge
          landed={landed}
          animateKeyframeRoll={selected}
        />
      </button>

      <div className="space-y-0.5 bg-zinc-950/90 px-2 py-1.5">
        {renaming ? (
          <form
            className="space-y-1"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <input
              value={draftProductionId}
              onChange={(event) => setDraftProductionId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              placeholder="Production ID"
              className="w-full rounded border border-white/15 bg-black/40 px-1.5 py-0.5 text-[10px] text-white outline-none focus:border-[var(--accent)]"
              aria-label="Production shot ID"
            />
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              className="w-full rounded border border-white/15 bg-black/40 px-1.5 py-0.5 text-[10px] text-white outline-none focus:border-[var(--accent)]"
              aria-label="Shot title"
            />
            <div className="flex gap-1">
              <button
                type="submit"
                className="flex-1 rounded bg-[var(--accent)] px-2 py-0.5 text-[10px] font-semibold text-white"
              >
                Save
              </button>
              <button
                type="button"
                onClick={cancelRename}
                className="flex-1 rounded border border-white/15 px-2 py-0.5 text-[10px] font-semibold text-white/80"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setRenaming(true)}
              className="group flex w-full items-start gap-1 text-left"
              aria-label={`Rename ${primaryLabel}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-semibold text-white">{primaryLabel}</p>
                {customTitle && (
                  <p className="truncate text-[10px] text-white/65">{shot.name}</p>
                )}
              </div>
              <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-white/35 opacity-0 transition group-hover:opacity-100" />
            </button>
            <p
              className={`truncate text-[9px] ${
                preparedStatus.overall === 'failed'
                  ? 'text-red-300'
                  : preparedUpdating
                    ? 'text-amber-200'
                    : preparedStatus.overall === 'ready'
                      ? 'text-emerald-300'
                      : 'text-white/55'
              }`}
              title={preparedStatus.label}
              data-prepared-media-status
            >
              {preparedStatus.label}
            </p>
            {backgroundVideoActive && (
              <p className="truncate text-[9px] text-sky-300" data-background-video-status>
                Background video preparing…
              </p>
            )}
          </>
        )}
      </div>

      <div className="absolute right-1 top-1 flex items-center gap-0.5">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white/90 backdrop-blur-sm transition hover:bg-black/80"
          aria-label={`More actions for ${primaryLabel}`}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        <AnchoredMenuPopover
          open={menuOpen}
          anchorRef={menuButtonRef}
          onClose={() => setMenuOpen(false)}
          className="min-w-[11rem] rounded-lg border border-white/10 bg-zinc-900 py-1 shadow-soft"
          aria-label={`Actions for ${primaryLabel}`}
        >
          <MenuButton label="Rename" onClick={() => { setRenaming(true); setMenuOpen(false); }} />
          <MenuButton label="Open shot" onClick={() => { onOpenShot(shot.id); setMenuOpen(false); }} />
          <MenuButton label="Inspect references" onClick={() => { onOpenMedia(shot.id); setMenuOpen(false); }} />
          <MenuButton
            label="Regenerate references"
            onClick={runRegenerate}
            disabled={preparedActionBusy || preparedUpdating}
            icon={<RefreshCw className="h-3 w-3" />}
          />
          <MenuButton
            label="Retry failed references"
            onClick={runRetry}
            disabled={preparedActionBusy || preparedUpdating || !preparedNeedsAttention}
            icon={<RefreshCw className="h-3 w-3" />}
          />
          <MenuButton
            label="Cancel preparation"
            onClick={runCancel}
            disabled={!preparedUpdating}
            icon={<X className="h-3 w-3" />}
          />
          <MenuButton
            label="Download"
            onClick={downloadPrimaryAsset}
            disabled={!poster}
            icon={<Download className="h-3 w-3" />}
          />
          <MenuButton
            label="Delete"
            onClick={requestDelete}
            disabled={!canDelete}
            destructive
          />
        </AnchoredMenuPopover>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            requestDelete();
          }}
          disabled={!canDelete}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white/90 backdrop-blur-sm transition hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
          aria-label={canDelete ? `Delete shot ${primaryLabel}` : 'Cannot delete the only shot'}
          title={canDelete ? 'Delete shot' : 'Keep at least one shot'}
          data-shots-library-delete
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function MenuButton({
  label,
  onClick,
  disabled,
  destructive,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
        destructive ? 'text-red-300 hover:bg-red-950/50' : 'text-white/85 hover:bg-white/10'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function downloadAsset(asset: ProjectAsset) {
  downloadDataUrl(asset.uri, asset.name);
}
