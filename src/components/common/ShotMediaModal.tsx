import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import {
  getDefaultShotTitle,
  getShotDisplayName,
  normalizeProductionShotId,
  normalizeShotTitle,
} from '../../domain/shotIdentity';
import { resolveShotMedia, ShotMediaItem } from '../../domain/shotMedia';
import {
  hasShotStillViewVariants,
  listAvailableShotStillViews,
  resolvePreferredShotStillView,
  resolveShotStillView,
  shotStillViewKey,
  type ShotStillAppearance,
  type ShotStillPeople,
  type ShotStillViewSelection,
} from '../../domain/shotStillViews';
import { LocationProject, Shot } from '../../domain/types';
import { downloadDataUrl } from '../../engine/fileTransfers';

export interface ShotMediaModalProps {
  open: boolean;
  project: LocationProject;
  shots: Shot[];
  shotId: string | null;
  initialMediaId?: string;
  onClose: () => void;
  onOpenShot: (shotId: string) => void;
  onUpdateShot: (id: string, updates: Partial<Shot>) => void;
  onNavigateShot?: (shotId: string) => void;
}

export function ShotMediaModal({
  open,
  project,
  shots,
  shotId,
  initialMediaId,
  onClose,
  onOpenShot,
  onUpdateShot,
  onNavigateShot,
}: ShotMediaModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const touchStartX = useRef<number | null>(null);
  const [activeMediaId, setActiveMediaId] = useState<string | undefined>(initialMediaId);
  const [editingProductionId, setEditingProductionId] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftProductionId, setDraftProductionId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [stillAppearance, setStillAppearance] = useState<ShotStillAppearance>('clay');
  const [stillPeople, setStillPeople] = useState<ShotStillPeople>('with_people');

  const shotIndex = shots.findIndex((item) => item.id === shotId);
  const shot = shotIndex >= 0 ? shots[shotIndex] : undefined;
  const mediaItems = useMemo(
    () => (shot ? resolveShotMedia(project, shot) : []),
    [project, shot],
  );
  const activeMedia = mediaItems.find((item) => item.id === activeMediaId) ?? mediaItems[0];
  const stillSelection = useMemo<ShotStillViewSelection>(
    () => ({ appearance: stillAppearance, people: stillPeople }),
    [stillAppearance, stillPeople],
  );
  const availableStillViews = useMemo(
    () => (shot ? listAvailableShotStillViews(project, shot) : []),
    [project, shot],
  );
  const showStillViewToggles = Boolean(
    shot
    && activeMedia?.source === 'captured_still'
    && hasShotStillViewVariants(project, shot),
  );
  const activeStillView = shot && activeMedia?.source === 'captured_still'
    ? resolvePreferredShotStillView(project, shot, stillSelection)
    : undefined;
  const displayImageSrc = activeStillView?.asset.uri
    ?? (activeMedia?.kind === 'image' ? activeMedia.asset.uri : undefined);
  const displayDownloadAsset = activeStillView?.asset
    ?? (activeMedia?.kind === 'image' || activeMedia?.kind === 'video' ? activeMedia.asset : undefined);

  const pauseVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
  }, []);

  const syncStillViewForShot = useCallback((nextShot: Shot) => {
    const preferred = resolvePreferredShotStillView(project, nextShot, {
      appearance: stillAppearance,
      people: stillPeople,
    });
    if (preferred) {
      setStillAppearance(preferred.selection.appearance);
      setStillPeople(preferred.selection.people);
      return;
    }
    setStillAppearance('clay');
    setStillPeople('with_people');
  }, [project, stillAppearance, stillPeople]);

  const goToShot = useCallback((delta: number) => {
    if (shotIndex < 0) return;
    const nextIndex = shotIndex + delta;
    if (nextIndex < 0 || nextIndex >= shots.length) return;
    pauseVideo();
    const nextShot = shots[nextIndex];
    const nextMedia = resolveShotMedia(project, nextShot);
    setActiveMediaId(nextMedia[0]?.id);
    syncStillViewForShot(nextShot);
    onNavigateShot?.(nextShot.id);
  }, [onNavigateShot, pauseVideo, project, shotIndex, shots, syncStillViewForShot]);

  useEffect(() => {
    if (!open || !shot) return;
    setDraftProductionId(shot.productionShotId ?? '');
    setDraftTitle(shot.name);
    setEditingProductionId(false);
    setEditingTitle(false);
    const items = resolveShotMedia(project, shot);
    const preferred = items.find((item) => item.id === initialMediaId) ?? items[0];
    setActiveMediaId(preferred?.id);
    const still = resolvePreferredShotStillView(project, shot, {
      appearance: 'clay',
      people: 'with_people',
    });
    setStillAppearance(still?.selection.appearance ?? 'clay');
    setStillPeople(still?.selection.people ?? 'with_people');
  }, [open, shot?.id, initialMediaId, project]);

  useEffect(() => {
    if (!open || !shot || !showStillViewToggles) return;
    if (resolveShotStillView(project, shot, stillSelection)) return;
    const fallback = resolvePreferredShotStillView(project, shot, stillSelection);
    if (!fallback) return;
    setStillAppearance(fallback.selection.appearance);
    setStillPeople(fallback.selection.people);
  }, [open, project, shot, showStillViewToggles, stillSelection]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (editingProductionId) {
          setDraftProductionId(shot?.productionShotId ?? '');
          setEditingProductionId(false);
          return;
        }
        if (editingTitle) {
          setDraftTitle(shot?.name ?? '');
          setEditingTitle(false);
          return;
        }
        pauseVideo();
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToShot(-1);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToShot(1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    editingProductionId,
    editingTitle,
    goToShot,
    onClose,
    open,
    pauseVideo,
    shot?.name,
    shot?.productionShotId,
  ]);

  const saveProductionId = () => {
    if (!shot) return;
    onUpdateShot(shot.id, {
      productionShotId: normalizeProductionShotId(draftProductionId),
    });
    setEditingProductionId(false);
  };

  const saveTitle = () => {
    if (!shot) return;
    onUpdateShot(shot.id, {
      name: normalizeShotTitle(shot, draftTitle),
    });
    setEditingTitle(false);
  };

  const handleMediaSelect = (item: ShotMediaItem) => {
    pauseVideo();
    setActiveMediaId(item.id);
  };

  const canSelectStillView = (selection: ShotStillViewSelection) => (
    availableStillViews.some((view) => shotStillViewKey(view) === shotStillViewKey(selection))
  );

  const handleTouchStart = (event: React.TouchEvent) => {
    touchStartX.current = event.changedTouches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: React.TouchEvent) => {
    const startX = touchStartX.current;
    touchStartX.current = null;
    if (startX == null) return;
    const endX = event.changedTouches[0]?.clientX ?? startX;
    const delta = endX - startX;
    if (Math.abs(delta) < 48) return;
    goToShot(delta > 0 ? -1 : 1);
  };

  if (!open || !shot) return null;

  const displayName = getShotDisplayName(shot);
  const canGoPrevious = shotIndex > 0;
  const canGoNext = shotIndex < shots.length - 1;

  const modal = (
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-black/90 backdrop-blur-sm"
      data-shot-media-modal
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer for ${displayName}`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <button
            type="button"
            onClick={() => goToShot(-1)}
            disabled={!canGoPrevious}
            className="mt-0.5 rounded-full p-1.5 text-white/80 transition hover:bg-white/10 disabled:opacity-30"
            aria-label="Previous shot"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">{displayName}</h2>
            <p className="text-xs text-white/55">PanoRef shot {shot.shotNumber}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            pauseVideo();
            onClose();
          }}
          className="rounded-full p-1.5 text-white/80 transition hover:bg-white/10"
          aria-label="Close media viewer"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="grid gap-3 border-b border-white/10 px-4 py-3 md:grid-cols-2">
        <FieldRow
          label="Production ID"
          editing={editingProductionId}
          value={shot.productionShotId ?? ''}
          draft={draftProductionId}
          placeholder="e.g. 42A"
          onDraftChange={setDraftProductionId}
          onStartEdit={() => setEditingProductionId(true)}
          onSave={saveProductionId}
          onCancel={() => {
            setDraftProductionId(shot.productionShotId ?? '');
            setEditingProductionId(false);
          }}
        />
        <FieldRow
          label="Shot title"
          editing={editingTitle}
          value={shot.name}
          draft={draftTitle}
          placeholder={getDefaultShotTitle(shot)}
          onDraftChange={setDraftTitle}
          onStartEdit={() => setEditingTitle(true)}
          onSave={saveTitle}
          onCancel={() => {
            setDraftTitle(shot.name);
            setEditingTitle(false);
          }}
        />
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col px-4 py-4"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div className="relative mx-auto flex min-h-0 w-full max-w-5xl flex-1 items-center justify-center rounded-xl border border-white/10 bg-black/50">
          {activeMedia?.kind === 'video' ? (
            <video
              ref={videoRef}
              key={activeMedia.id}
              src={activeMedia.asset.uri}
              controls
              playsInline
              preload="metadata"
              className="max-h-full max-w-full object-contain"
            />
          ) : displayImageSrc ? (
            <img
              src={displayImageSrc}
              alt={shot.name}
              className="max-h-full max-w-full object-contain"
              data-shot-still-view={activeStillView ? shotStillViewKey(activeStillView.selection) : undefined}
            />
          ) : (
            <p className="text-sm text-white/55">No capture stored for this shot yet.</p>
          )}

          <button
            type="button"
            onClick={() => goToShot(-1)}
            disabled={!canGoPrevious}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white transition hover:bg-black/75 disabled:opacity-30"
            aria-label="Previous shot"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => goToShot(1)}
            disabled={!canGoNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-2 text-white transition hover:bg-black/75 disabled:opacity-30"
            aria-label="Next shot"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {showStillViewToggles && (
          <div
            className="mx-auto mt-3 flex max-w-5xl flex-wrap items-center justify-center gap-3"
            data-shot-still-view-toggles
          >
            <ToggleGroup
              label="Projection"
              value={stillAppearance}
              options={[
                {
                  value: 'clay' as const,
                  label: 'Clay',
                  disabled: !canSelectStillView({ appearance: 'clay', people: stillPeople })
                    && !availableStillViews.some((view) => view.appearance === 'clay'),
                },
                {
                  value: 'projected' as const,
                  label: 'Projected',
                  disabled: !canSelectStillView({ appearance: 'projected', people: stillPeople })
                    && !availableStillViews.some((view) => view.appearance === 'projected'),
                },
              ]}
              onChange={(value) => {
                const next = value as ShotStillAppearance;
                if (canSelectStillView({ appearance: next, people: stillPeople })) {
                  setStillAppearance(next);
                  return;
                }
                const fallback = availableStillViews.find((view) => view.appearance === next);
                if (!fallback) return;
                setStillAppearance(fallback.appearance);
                setStillPeople(fallback.people);
              }}
            />
            <ToggleGroup
              label="People"
              value={stillPeople}
              options={[
                {
                  value: 'with_people' as const,
                  label: 'People',
                  disabled: !canSelectStillView({ appearance: stillAppearance, people: 'with_people' })
                    && !availableStillViews.some((view) => view.people === 'with_people'),
                },
                {
                  value: 'clean_plate' as const,
                  label: 'Clean plate',
                  disabled: !canSelectStillView({ appearance: stillAppearance, people: 'clean_plate' })
                    && !availableStillViews.some((view) => view.people === 'clean_plate'),
                },
              ]}
              onChange={(value) => {
                const next = value as ShotStillPeople;
                if (canSelectStillView({ appearance: stillAppearance, people: next })) {
                  setStillPeople(next);
                  return;
                }
                const fallback = availableStillViews.find((view) => view.people === next);
                if (!fallback) return;
                setStillAppearance(fallback.appearance);
                setStillPeople(fallback.people);
              }}
            />
          </div>
        )}

        {mediaItems.length > 1 && (
          <div className="mx-auto mt-3 flex max-w-5xl flex-wrap justify-center gap-2">
            {mediaItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleMediaSelect(item)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  item.id === activeMedia?.id
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-white/10 text-white/75 hover:bg-white/15'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
        <button
          type="button"
          disabled={!displayDownloadAsset}
          onClick={() => {
            if (!displayDownloadAsset) return;
            downloadDataUrl(displayDownloadAsset.uri, displayDownloadAsset.name);
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white transition hover:bg-white/10 disabled:opacity-40"
        >
          <Download className="h-4 w-4" />
          Download
        </button>
        <button
          type="button"
          onClick={() => {
            pauseVideo();
            onOpenShot(shot.id);
          }}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Open shot
        </button>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return modal;
  return createPortal(modal, document.body);
}

function ToggleGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-2" role="group" aria-label={label}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-white/45">{label}</span>
      <div className="inline-flex rounded-full border border-white/15 bg-black/40 p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-35 ${
              value === option.value
                ? 'bg-white text-zinc-900'
                : 'text-white/75 hover:bg-white/10'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function FieldRow({
  label,
  editing,
  value,
  draft,
  placeholder,
  onDraftChange,
  onStartEdit,
  onSave,
  onCancel,
}: {
  label: string;
  editing: boolean;
  value: string;
  draft: string;
  placeholder: string;
  onDraftChange: (value: string) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <form
        className="block text-xs text-white/65"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <span className="mb-1 block font-medium">{label}</span>
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder={placeholder}
          className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-[var(--accent)]"
          autoFocus
        />
        <div className="mt-2 flex gap-2">
          <button
            type="submit"
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/80"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={onStartEdit}
      className="block w-full rounded-lg border border-transparent px-1 py-1 text-left transition hover:border-white/10 hover:bg-white/5"
    >
      <span className="mb-1 block text-xs font-medium text-white/65">{label}</span>
      <span className="block truncate text-sm text-white">{value || placeholder}</span>
    </button>
  );
}
