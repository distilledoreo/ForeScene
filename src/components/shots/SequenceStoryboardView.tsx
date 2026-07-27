import React, { useEffect, useMemo, useState } from 'react';
import type { LocationProject } from '../../domain/types';
import {
  buildSequenceStoryboard,
  resolveAnimaticFrame,
  type SequenceStoryboardItem,
} from '../../engine/sequenceStoryboard';

export interface SequenceStoryboardViewProps {
  project: LocationProject;
  selectedShotId?: string;
  onSelectShot: (shotId: string) => void;
  onReorder: (shotId: string, targetIndex: number) => void;
  onCopyStagingToNext: (shotId: string) => void;
  resolveThumbnailUri?: (item: SequenceStoryboardItem) => string | undefined;
}

/** Sequence / storyboard: reorder, duration, status, animatic playback. */
export function SequenceStoryboardView({
  project,
  selectedShotId,
  onSelectShot,
  onReorder,
  onCopyStagingToNext,
  resolveThumbnailUri,
}: SequenceStoryboardViewProps) {
  const board = useMemo(() => buildSequenceStoryboard(project), [project]);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    if (!playing || board.totalDurationSeconds <= 0) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayhead((value) => {
        const next = value + dt;
        return next >= board.totalDurationSeconds ? 0 : next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, board.totalDurationSeconds]);

  const activeFrame = useMemo(
    () => resolveAnimaticFrame(board, playhead),
    [board, playhead],
  );

  useEffect(() => {
    if (playing && activeFrame?.shotId && activeFrame.shotId !== selectedShotId) {
      onSelectShot(activeFrame.shotId);
    }
  }, [playing, activeFrame?.shotId, selectedShotId, onSelectShot]);

  return (
    <div data-sequence-storyboard className="flex h-full flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Sequence</h2>
          <p className="text-xs text-[var(--muted)]">
            {board.shotCount} shots · {board.videoCount} video · {board.stillCount} still ·{' '}
            {board.totalDurationSeconds.toFixed(1)}s total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-sequence-animatic-play
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white"
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? 'Stop animatic' : 'Play animatic'}
          </button>
        </div>
      </div>

      {playing && activeFrame && (
        <div className="text-xs text-[var(--muted)]" data-sequence-playhead>
          Playhead {playhead.toFixed(1)}s · shot {activeFrame.shotId.slice(0, 8)}…
        </div>
      )}

      <div className="flex flex-1 gap-2 overflow-x-auto pb-2">
        {board.items.map((item) => {
          const thumb = resolveThumbnailUri?.(item);
          const selected = item.shotId === selectedShotId
            || (playing && activeFrame?.shotId === item.shotId);
          return (
            <div
              key={item.shotId}
              data-sequence-card
              data-shot-id={item.shotId}
              draggable
              onDragStart={() => setDragId(item.shotId)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragId) onReorder(dragId, item.index);
                setDragId(null);
              }}
              className={`flex w-36 shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg border ${
                selected ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)]'
              }`}
              onClick={() => onSelectShot(item.shotId)}
            >
              <div className="relative aspect-video bg-black/30">
                {thumb ? (
                  <img src={thumb} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-white/50">
                    No thumb
                  </div>
                )}
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white">
                  {item.index + 1}
                </span>
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] uppercase text-white">
                  {item.kind}
                </span>
              </div>
              <div className="space-y-1 p-2">
                <div className="truncate text-xs font-medium">{item.name || item.productionShotId || 'Shot'}</div>
                <div className="flex justify-between text-[10px] text-[var(--muted)]">
                  <span>{item.status}</span>
                  <span>{item.durationSeconds.toFixed(1)}s</span>
                </div>
                <button
                  type="button"
                  data-sequence-copy-staging
                  className="w-full rounded border border-[var(--border)] px-1 py-0.5 text-[10px] hover:bg-[var(--hover)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopyStagingToNext(item.shotId);
                  }}
                >
                  Copy staging → next
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
