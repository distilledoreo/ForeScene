import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CameraKeyframe } from '../../domain/types';
import {
  getCameraKeyframeDisplayLabel,
  getIntermediateCameraKeyframeTimeBounds,
  getSortedCameraKeyframes,
  type VideoCaptureState,
} from '../../engine/cameraKeyframes';

export interface KeyframeStripProps {
  keyframes: CameraKeyframe[];
  durationSeconds: number;
  captureState: VideoCaptureState;
  isPreviewing?: boolean;

  selectedKeyframeId: string | null;
  selectedSegmentStartId: string | null;

  onCaptureNext: () => void;
  onFinishCapture: () => void;
  onContinueCapture: () => void;
  onPreview: () => void;
  onStopPreview?: () => void;

  onSelectKeyframe: (keyframeId: string | null) => void;
  onSelectSegment: (startKeyframeId: string | null) => void;
  onInsertInSelectedSegment: () => void;

  onUpdatePose: (keyframeId: string) => void;
  onChangeTime: (keyframeId: string, time: number) => void;
  onDelete: (keyframeId: string) => void;
}

/**
 * Presentational timeline for sequential camera-keyframe authoring.
 * All store/camera/export side effects stay in the host (ShotsWorkspace).
 */
export function KeyframeStrip({
  keyframes,
  durationSeconds,
  captureState,
  isPreviewing = false,
  selectedKeyframeId,
  selectedSegmentStartId,
  onCaptureNext,
  onFinishCapture,
  onContinueCapture,
  onPreview,
  onStopPreview,
  onSelectKeyframe,
  onSelectSegment,
  onInsertInSelectedSegment,
  onUpdatePose,
  onChangeTime,
  onDelete,
}: KeyframeStripProps) {
  const sorted = useMemo(() => getSortedCameraKeyframes(keyframes), [keyframes]);
  const duration = Math.max(durationSeconds, Number.EPSILON);
  const editorId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [editorStyle, setEditorStyle] = useState<React.CSSProperties>({});
  const [timeDraft, setTimeDraft] = useState<string | null>(null);

  const selectedIndex = selectedKeyframeId
    ? sorted.findIndex((keyframe) => keyframe.id === selectedKeyframeId)
    : -1;
  const selectedKeyframe = selectedIndex >= 0 ? sorted[selectedIndex] : undefined;
  const selectedIsEndpoint = selectedIndex === 0 || selectedIndex === sorted.length - 1;
  const timeBounds = selectedKeyframe && !selectedIsEndpoint
    ? getIntermediateCameraKeyframeTimeBounds(sorted, selectedKeyframe.id)
    : undefined;

  const showSegments = sorted.length >= 2 && captureState === 'finished' && !isPreviewing;
  const canFinish = captureState === 'capturing' && sorted.length >= 2;
  const editingLocked = isPreviewing;

  useEffect(() => {
    setTimeDraft(null);
  }, [selectedKeyframeId, selectedKeyframe?.timeSeconds]);

  // Position the node editor so it stays inside the strip when near edges.
  useEffect(() => {
    if (!selectedKeyframe || !trackRef.current) {
      setEditorStyle({});
      return;
    }
    const track = trackRef.current;
    const leftPercent = (selectedKeyframe.timeSeconds / duration) * 100;
    const trackWidth = track.clientWidth || 1;
    const editorWidth = Math.min(200, Math.max(140, trackWidth));
    const centerPx = (leftPercent / 100) * trackWidth;
    let leftPx = centerPx - editorWidth / 2;
    leftPx = Math.max(0, Math.min(Math.max(0, trackWidth - editorWidth), leftPx));
    setEditorStyle({
      left: `${leftPx}px`,
      width: `${editorWidth}px`,
      maxWidth: '100%',
    });
  }, [duration, selectedKeyframe, selectedKeyframe?.timeSeconds, sorted.length]);

  useEffect(() => {
    if (!selectedKeyframe) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSelectKeyframe(null);
        trackRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSelectKeyframe, selectedKeyframe]);

  const commitTimeDraft = useCallback(() => {
    if (!selectedKeyframe || timeDraft === null) return;
    const parsed = Number(timeDraft);
    if (Number.isFinite(parsed)) {
      onChangeTime(selectedKeyframe.id, parsed);
    }
    setTimeDraft(null);
  }, [onChangeTime, selectedKeyframe, timeDraft]);

  const focusAdjacent = useCallback((fromIndex: number, direction: -1 | 1) => {
    if (editingLocked) return;
    const nextIndex = fromIndex + direction;
    if (nextIndex < 0 || nextIndex >= sorted.length) return;
    onSelectSegment(null);
    onSelectKeyframe(sorted[nextIndex].id);
  }, [editingLocked, onSelectKeyframe, onSelectSegment, sorted]);

  const handleTrackKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (sorted.length === 0 || editingLocked) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      if (selectedIndex >= 0) {
        focusAdjacent(selectedIndex, direction);
        return;
      }
      const start = direction === 1 ? 0 : sorted.length - 1;
      onSelectSegment(null);
      onSelectKeyframe(sorted[start].id);
    }
    if ((event.key === 'Enter' || event.key === ' ') && selectedIndex < 0 && sorted.length > 0) {
      event.preventDefault();
      onSelectKeyframe(sorted[0].id);
    }
  }, [editingLocked, focusAdjacent, onSelectKeyframe, onSelectSegment, selectedIndex, sorted]);

  const timeDisplay = timeDraft ?? (
    selectedKeyframe ? String(selectedKeyframe.timeSeconds) : ''
  );

  return (
    <div
      className="flex w-full flex-col gap-2"
      data-camera-keyframe-strip
      data-camera-keyframe-capture-state={captureState}
      data-camera-keyframe-previewing={isPreviewing ? 'true' : 'false'}
    >
      {sorted.length === 0 ? (
        <p className="text-center text-[11px] font-medium text-white/55">
          No camera move captured
        </p>
      ) : (
        <div
          ref={trackRef}
          className="relative h-12 w-full touch-manipulation outline-none"
          role="listbox"
          aria-label="Camera keyframes"
          aria-disabled={editingLocked || undefined}
          tabIndex={0}
          onKeyDown={handleTrackKeyDown}
        >
          {/* Baseline */}
          <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-white/25" />

          {/* Segments (finished only, not while previewing) */}
          {showSegments && sorted.slice(0, -1).map((keyframe, index) => {
            const next = sorted[index + 1];
            const startPercent = (keyframe.timeSeconds / duration) * 100;
            const endPercent = (next.timeSeconds / duration) * 100;
            const midPercent = startPercent + ((endPercent - startPercent) / 2);
            const selected = selectedSegmentStartId === keyframe.id;
            return (
              <button
                key={`seg-${keyframe.id}`}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`Insert between ${getCameraKeyframeDisplayLabel(index, sorted.length)} and ${getCameraKeyframeDisplayLabel(index + 1, sorted.length)}`}
                data-camera-keyframe-segment
                data-segment-after={keyframe.id}
                disabled={editingLocked}
                className={`absolute top-1/2 z-[1] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition disabled:opacity-40 ${
                  selected
                    ? 'bg-[var(--accent)]/30 text-white ring-2 ring-[var(--accent)]'
                    : 'text-white/70 hover:bg-white/15 hover:text-white'
                }`}
                style={{ left: `${midPercent}%` }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectKeyframe(null);
                  onSelectSegment(selected ? null : keyframe.id);
                }}
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-[11px] font-bold leading-none">
                  +
                </span>
              </button>
            );
          })}

          {/* Nodes */}
          {sorted.map((keyframe, index) => {
            const isStart = index === 0;
            const isEnd = index === sorted.length - 1;
            const isEndpoint = isStart || isEnd;
            const label = getCameraKeyframeDisplayLabel(index, sorted.length);
            const leftPercent = (keyframe.timeSeconds / duration) * 100;
            const selected = selectedKeyframeId === keyframe.id;
            return (
              <button
                key={keyframe.id}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`${label} at ${keyframe.timeSeconds.toFixed(2)} seconds`}
                data-camera-keyframe-node
                data-keyframe-id={keyframe.id}
                data-keyframe-role={isStart ? 'start' : isEnd ? 'end' : 'intermediate'}
                disabled={editingLocked}
                className={`absolute top-1/2 z-[2] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5 outline-none disabled:opacity-40 ${
                  selected ? 'z-[3]' : ''
                }`}
                style={{ left: `${leftPercent}%` }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectSegment(null);
                  onSelectKeyframe(selected ? null : keyframe.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    event.stopPropagation();
                    focusAdjacent(index, 1);
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    event.stopPropagation();
                    focusAdjacent(index, -1);
                  }
                }}
              >
                <span
                  className={`block shrink-0 transition ${
                    isEndpoint
                      ? `h-3.5 w-3.5 rounded-full bg-white ${selected ? 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-black/60' : ''}`
                      : `h-3.5 w-3.5 rotate-45 border-2 border-white bg-transparent ${selected ? 'bg-white/20 ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-black/60' : ''}`
                  }`}
                />
                <span className="pointer-events-none absolute top-[calc(100%-2px)] whitespace-nowrap text-[9px] font-semibold uppercase tracking-wide text-white/70">
                  {label}
                </span>
              </button>
            );
          })}

          {/* Selected node editor */}
          {selectedKeyframe && !editingLocked && (
            <div
              id={editorId}
              role="dialog"
              aria-label="Keyframe editor"
              data-camera-keyframe-editor-popover
              className="absolute bottom-[calc(100%+0.35rem)] z-10 box-border rounded-xl border border-white/20 bg-black/85 p-2 text-white shadow-soft backdrop-blur-md"
              style={editorStyle}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-camera-keyframe-update-pose
                  className="rounded-lg bg-white/15 px-2.5 py-1.5 text-[11px] font-semibold transition hover:bg-white/25"
                  onClick={() => onUpdatePose(selectedKeyframe.id)}
                >
                  Update pose
                </button>
                {!selectedIsEndpoint && (
                  <>
                    <label className="flex items-center gap-1 text-[11px] text-white/70">
                      <span className="sr-only">Time seconds</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        data-camera-keyframe-time
                        value={timeDisplay}
                        disabled={!timeBounds || captureState !== 'finished'}
                        onChange={(event) => setTimeDraft(event.target.value)}
                        onBlur={commitTimeDraft}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitTimeDraft();
                            (event.target as HTMLInputElement).blur();
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setTimeDraft(null);
                            (event.target as HTMLInputElement).blur();
                          }
                        }}
                        className="w-16 rounded-md border border-white/20 bg-black/40 px-1.5 py-1 text-[11px] text-white outline-none focus:border-[var(--accent)]"
                        aria-label="Keyframe time in seconds"
                      />
                      s
                    </label>
                    <button
                      type="button"
                      data-camera-keyframe-delete
                      className="rounded-lg bg-red-500/20 px-2.5 py-1.5 text-[11px] font-semibold text-red-200 transition hover:bg-red-500/35"
                      disabled={captureState !== 'finished'}
                      onClick={() => onDelete(selectedKeyframe.id)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Capture-state actions */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {captureState === 'empty' && (
          <StripAction
            dataAttr="data-camera-keyframe-capture-next"
            label="Capture start"
            onClick={onCaptureNext}
            primary
          />
        )}
        {captureState === 'capturing' && (
          <>
            <StripAction
              dataAttr="data-camera-keyframe-capture-next"
              label={sorted.length === 0 ? 'Capture start' : 'Capture next'}
              onClick={onCaptureNext}
              primary
              disabled={editingLocked}
            />
            {canFinish && (
              <StripAction
                dataAttr="data-camera-keyframe-finish"
                label="Finish capture"
                onClick={onFinishCapture}
                disabled={editingLocked}
              />
            )}
          </>
        )}
        {captureState === 'finished' && (
          <>
            {selectedSegmentStartId && !isPreviewing && (
              <StripAction
                dataAttr="data-camera-keyframe-insert"
                label="Insert here"
                onClick={onInsertInSelectedSegment}
                primary
              />
            )}
            {isPreviewing ? (
              <StripAction
                dataAttr="data-camera-keyframe-stop-preview"
                label="Stop preview"
                onClick={() => onStopPreview?.()}
                primary
              />
            ) : (
              <StripAction
                dataAttr="data-camera-keyframe-preview"
                label="Preview move"
                onClick={onPreview}
                primary={!selectedSegmentStartId}
              />
            )}
            <StripAction
              dataAttr="data-camera-keyframe-continue"
              label="Continue sequence"
              onClick={onContinueCapture}
              disabled={isPreviewing}
            />
          </>
        )}
      </div>
    </div>
  );
}

function StripAction({
  label,
  onClick,
  primary = false,
  dataAttr,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  dataAttr: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      {...{ [dataAttr]: true }}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-white text-black hover:bg-white/90'
          : 'bg-white/15 text-white hover:bg-white/25'
      }`}
    >
      {label}
    </button>
  );
}
