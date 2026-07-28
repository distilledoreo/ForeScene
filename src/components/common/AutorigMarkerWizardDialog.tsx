import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FlipHorizontal2, RotateCcw, Sparkles } from 'lucide-react';
import type { AutorigMarker, HumanJointId, PoseableRigAsset, Vec3 } from '../../domain/types';
import {
  AUTORIG_MARKER_MIRROR,
  applyFittedSkeletonToRig,
  fitSkeletonFromMarkers,
  markerColor,
  markerJointsForMode,
  mirrorAllMarkers,
  mirrorMarkerAcrossSagittal,
  suggestAutorigMarkers,
  upsertMarker,
  validateAutorigMarkers,
  type AutorigMarkerMode,
} from '../../engine/autorigMarkers';
import { HUMAN_JOINT_LABELS } from '../../engine/humanPose';
import { Modal } from './Modal';

interface HistoryEntry {
  markers: AutorigMarker[];
}

export function AutorigMarkerWizardDialog({
  open,
  onClose,
  rig,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  rig: PoseableRigAsset;
  onSave: (next: PoseableRigAsset) => void;
}) {
  const height = rig.generationSettings?.approximateHeightMeters ?? 1.75;
  const suggested = useMemo(
    () => suggestAutorigMarkers({
      size: [height * 0.45, height, height * 0.25],
      heightMeters: height,
      groundLevelMeters: rig.orientation?.groundLevelMeters ?? 0,
    }),
    [height, rig.orientation?.groundLevelMeters],
  );

  const [mode, setMode] = useState<AutorigMarkerMode>('full');
  const [markers, setMarkers] = useState<AutorigMarker[]>(rig.markers?.length ? rig.markers : suggested);
  const [selectedJointId, setSelectedJointId] = useState<HumanJointId>('hips');
  const [past, setPast] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);
  const [showSide, setShowSide] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ jointId: HumanJointId; pointerId: number } | undefined>(undefined);
  const preDragMarkersRef = useRef<AutorigMarker[] | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setMarkers(rig.markers?.length ? rig.markers : suggested);
    setPast([]);
    setFuture([]);
  }, [open, rig, suggested]);

  const required = markerJointsForMode(mode);
  const issues = validateAutorigMarkers(markers, mode);
  const fitted = fitSkeletonFromMarkers(markers, mode);

  const commit = (next: AutorigMarker[]) => {
    setPast((stack) => [...stack, { markers }]);
    setFuture([]);
    setMarkers(next);
  };

  const undo = () => {
    setPast((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1]!;
      setFuture((ahead) => [{ markers }, ...ahead]);
      setMarkers(previous.markers);
      return stack.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((stack) => {
      if (stack.length === 0) return stack;
      const next = stack[0]!;
      setPast((behind) => [...behind, { markers }]);
      setMarkers(next.markers);
      return stack.slice(1);
    });
  };

  const worldToCanvas = (
    position: Vec3,
    width: number,
    heightPx: number,
    view: 'front' | 'side',
  ): { x: number; y: number } => {
    const margin = 24;
    const usableW = width - margin * 2;
    const usableH = heightPx - margin * 2;
    const span = Math.max(height * 1.15, 1);
    const xWorld = view === 'front' ? position[0] : position[2];
    const yWorld = position[1];
    return {
      x: margin + usableW * 0.5 + (xWorld / span) * usableW,
      y: margin + usableH * (1 - yWorld / span),
    };
  };

  const canvasToWorld = (
    x: number,
    y: number,
    width: number,
    heightPx: number,
    view: 'front' | 'side',
    current: Vec3,
  ): Vec3 => {
    const margin = 24;
    const usableW = width - margin * 2;
    const usableH = heightPx - margin * 2;
    const span = Math.max(height * 1.15, 1);
    const xWorld = ((x - margin) / usableW - 0.5) * span;
    const yWorld = (1 - (y - margin) / usableH) * span;
    if (view === 'front') return [xWorld, yWorld, current[2]];
    return [current[0], yWorld, xWorld];
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const heightPx = canvas.height;
    ctx.clearRect(0, 0, width, heightPx);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, heightPx);

    // Ground line
    const ground = worldToCanvas([0, rig.orientation?.groundLevelMeters ?? 0, 0], width, heightPx, showSide ? 'side' : 'front');
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(16, ground.y);
    ctx.lineTo(width - 16, ground.y);
    ctx.stroke();

    // Skeleton preview lines from fitted joints
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.lineWidth = 2;
    const positions = fitted.jointPositions;
    const drawBone = (a?: Vec3, b?: Vec3) => {
      if (!a || !b) return;
      const pa = worldToCanvas(a, width, heightPx, showSide ? 'side' : 'front');
      const pb = worldToCanvas(b, width, heightPx, showSide ? 'side' : 'front');
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    };
    drawBone(positions.hips, positions.spine);
    drawBone(positions.spine, positions.chest);
    drawBone(positions.chest, positions.neck);
    drawBone(positions.neck, positions.head);
    drawBone(positions.chest, positions.leftUpperArm);
    drawBone(positions.leftUpperArm, positions.leftLowerArm);
    drawBone(positions.leftLowerArm, positions.leftHand);
    drawBone(positions.chest, positions.rightUpperArm);
    drawBone(positions.rightUpperArm, positions.rightLowerArm);
    drawBone(positions.rightLowerArm, positions.rightHand);
    drawBone(positions.hips, positions.leftUpperLeg);
    drawBone(positions.leftUpperLeg, positions.leftLowerLeg);
    drawBone(positions.leftLowerLeg, positions.leftFoot);
    drawBone(positions.hips, positions.rightUpperLeg);
    drawBone(positions.rightUpperLeg, positions.rightLowerLeg);
    drawBone(positions.rightLowerLeg, positions.rightFoot);

    for (const jointId of required) {
      const marker = markers.find((item) => item.jointId === jointId);
      if (!marker) continue;
      const point = worldToCanvas(marker.position, width, heightPx, showSide ? 'side' : 'front');
      const selected = selectedJointId === jointId;
      ctx.beginPath();
      ctx.fillStyle = markerColor(jointId);
      ctx.arc(point.x, point.y, selected ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Magnifier while dragging
    if (dragRef.current) {
      const marker = markers.find((item) => item.jointId === dragRef.current?.jointId);
      if (marker) {
        const point = worldToCanvas(marker.position, width, heightPx, showSide ? 'side' : 'front');
        const radius = 48;
        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x + 56, point.y - 56, radius, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = '#111827';
        ctx.fillRect(point.x + 56 - radius, point.y - 56 - radius, radius * 2, radius * 2);
        ctx.beginPath();
        ctx.fillStyle = markerColor(marker.jointId);
        ctx.arc(point.x + 56, point.y - 56, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = '#94a3b8';
        ctx.beginPath();
        ctx.arc(point.x + 56, point.y - 56, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [fitted, markers, open, required, selectedJointId, showSide, height, rig.orientation?.groundLevelMeters]);

  const hitTest = (x: number, y: number): HumanJointId | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    for (const jointId of required) {
      const marker = markers.find((item) => item.jointId === jointId);
      if (!marker) continue;
      const point = worldToCanvas(marker.position, canvas.width, canvas.height, showSide ? 'side' : 'front');
      if (Math.hypot(point.x - x, point.y - y) <= 12) return jointId;
    }
    return undefined;
  };

  return (
    <Modal open={open} onClose={onClose} title="Place autorig markers" size="xl">
      <div className="space-y-3" data-autorig-marker-wizard>
        <p className="text-sm text-secondary">
          Drag markers in the orthographic view. Blue = left, amber = right, green = midline.
          The fitted skeleton is shown as lines; the mesh is not deformed yet.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${mode === 'full' ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
            onClick={() => setMode('full')}
            data-autorig-mode-full
          >
            Full (13)
          </button>
          <button
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${mode === 'simple' ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
            onClick={() => setMode('simple')}
            data-autorig-mode-simple
          >
            Simple (9)
          </button>
          <button
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${!showSide ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
            onClick={() => setShowSide(false)}
          >
            Front view
          </button>
          <button
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${showSide ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
            onClick={() => setShowSide(true)}
          >
            Side view
          </button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_14rem]">
          <canvas
            ref={canvasRef}
            width={640}
            height={480}
            className="w-full rounded-xl border border-subtle bg-black touch-none"
            data-autorig-marker-canvas
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const x = ((event.clientX - rect.left) / rect.width) * event.currentTarget.width;
              const y = ((event.clientY - rect.top) / rect.height) * event.currentTarget.height;
              const hit = hitTest(x, y) ?? selectedJointId;
              setSelectedJointId(hit);
              preDragMarkersRef.current = markers;
              dragRef.current = { jointId: hit, pointerId: event.pointerId };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const x = ((event.clientX - rect.left) / rect.width) * event.currentTarget.width;
              const y = ((event.clientY - rect.top) / rect.height) * event.currentTarget.height;
              const current = markers.find((item) => item.jointId === dragRef.current!.jointId)?.position ?? [0, 0, 0];
              const nextPos = canvasToWorld(x, y, event.currentTarget.width, event.currentTarget.height, showSide ? 'side' : 'front', current);
              setMarkers((currentMarkers) => upsertMarker(currentMarkers, dragRef.current!.jointId, nextPos));
            }}
            onPointerUp={(event) => {
              if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
              if (preDragMarkersRef.current) {
                setPast((stack) => [...stack, { markers: preDragMarkersRef.current! }]);
                setFuture([]);
              }
              preDragMarkersRef.current = undefined;
              dragRef.current = undefined;
            }}
          />

          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Markers</div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {required.map((jointId) => {
                const present = markers.some((marker) => marker.jointId === jointId);
                return (
                  <button
                    key={jointId}
                    type="button"
                    onClick={() => setSelectedJointId(jointId)}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs ${
                      selectedJointId === jointId ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'
                    }`}
                    data-autorig-marker-list-item={jointId}
                  >
                    <span>{HUMAN_JOINT_LABELS[jointId]}</span>
                    <span className="opacity-70">{present ? '•' : '—'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary" onClick={undo} disabled={past.length === 0}>Undo</button>
          <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary" onClick={redo} disabled={future.length === 0}>Redo</button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
            data-autorig-mirror-marker
            onClick={() => commit(mirrorMarkerAcrossSagittal(markers, selectedJointId))}
            disabled={!AUTORIG_MARKER_MIRROR[selectedJointId]}
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" /> Mirror marker
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
            onClick={() => commit(mirrorAllMarkers(markers))}
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" /> Mirror all L→R
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
            data-autorig-restore-suggested
            onClick={() => {
              const suggestion = suggested.find((marker) => marker.jointId === selectedJointId);
              if (!suggestion) return;
              commit(upsertMarker(markers, selectedJointId, suggestion.position));
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Restore suggested
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
            onClick={() => commit(suggested)}
          >
            <Sparkles className="h-3.5 w-3.5" /> Reset all suggested
          </button>
        </div>

        {issues.length > 0 && (
          <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100" data-autorig-marker-issues>
            {issues.map((issue) => <p key={`${issue.code}-${issue.message}`}>{issue.message}</p>)}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-subtle pt-3">
          <button type="button" className="rounded-xl border border-subtle px-3 py-2 text-sm font-semibold text-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            data-autorig-apply-skeleton
            disabled={issues.some((issue) => issue.code === 'missing')}
            onClick={() => {
              const nextRig = applyFittedSkeletonToRig(rig, fitted);
              onSave(nextRig);
              onClose();
            }}
          >
            <CheckCircle2 className="h-4 w-4" />
            Apply skeleton
          </button>
        </div>
      </div>
    </Modal>
  );
}
