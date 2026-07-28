import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FlipHorizontal2, RotateCcw, Sparkles } from 'lucide-react';
import type {
  AssetRegistry,
  AutorigMarker,
  HumanJointId,
  PoseableRigAsset,
  Vec3,
} from '../../domain/types';
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
import {
  canvasToWorld,
  computeAutorigOrthoFrame,
  drawAutorigMarkerMagnifier,
  worldToCanvas,
  type AutorigOrthoFrame,
  type OrientedMeshBounds,
} from '../../engine/autorigMarkerFrame';
import {
  createAutorigMarkerPreviewGl,
  disposeAutorigMarkerPreviewGl,
  renderAutorigMarkerPreview,
  setAutorigMarkerPreviewRoot,
  type AutorigMarkerPreviewGl,
} from '../../engine/autorigMarkerPreviewRenderer';
import {
  createAutorigPreviewInstance,
  ensureAutorigSourceTemplate,
  isAutorigSourceTemplateReady,
  subscribeAutoriggedCharacterReady,
} from '../../engine/autoriggedPoseableCharacter';
import { HUMAN_JOINT_LABELS } from '../../engine/humanPose';
import { Modal } from './Modal';

interface HistoryEntry {
  markers: AutorigMarker[];
}

const CANVAS_W = 640;
const CANVAS_H = 480;

export function AutorigMarkerWizardDialog({
  open,
  onClose,
  rig,
  onSave,
  sourceAssetId: sourceAssetIdProp,
  assets,
}: {
  open: boolean;
  onClose: () => void;
  rig: PoseableRigAsset;
  onSave: (next: PoseableRigAsset) => void;
  /** Source mesh asset for preview (original import). Falls back to rig fields. */
  sourceAssetId?: string;
  assets?: AssetRegistry;
}) {
  const height = rig.generationSettings?.approximateHeightMeters ?? 1.75;
  const sourceAssetId = sourceAssetIdProp
    ?? rig.originalSourceAssetId
    ?? rig.sourceMeshAssetId;
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
  const [meshReady, setMeshReady] = useState(false);
  const [meshBounds, setMeshBounds] = useState<OrientedMeshBounds | null>(null);

  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const meshCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<AutorigMarkerPreviewGl | null>(null);
  const frameRef = useRef<AutorigOrthoFrame | null>(null);
  const dragRef = useRef<{ jointId: HumanJointId; pointerId: number } | undefined>(undefined);
  const preDragMarkersRef = useRef<AutorigMarker[] | undefined>(undefined);

  const view = showSide ? 'side' as const : 'front' as const;

  const frame = useMemo(
    () => computeAutorigOrthoFrame({
      bounds: meshBounds,
      view,
      canvasWidth: CANVAS_W,
      canvasHeight: CANVAS_H,
      fallbackHeightMeters: height,
    }),
    [meshBounds, view, height],
  );
  frameRef.current = frame;

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

  const attachPreviewMesh = useCallback(() => {
    if (!sourceAssetId || !isAutorigSourceTemplateReady(sourceAssetId)) {
      setMeshReady(false);
      setMeshBounds(null);
      if (glRef.current) setAutorigMarkerPreviewRoot(glRef.current, null);
      return;
    }
    const preview = createAutorigPreviewInstance({
      sourceAssetId,
      assets,
      orientation: rig.orientation,
      approximateHeightMeters: height,
    });
    if (!preview || !glRef.current) {
      setMeshReady(false);
      setMeshBounds(null);
      return;
    }
    setAutorigMarkerPreviewRoot(glRef.current, preview.root);
    setMeshBounds(preview.bounds);
    setMeshReady(true);
  }, [assets, height, rig.orientation, sourceAssetId]);

  // WebGL lifecycle: create on open, dispose on close. No continuous rAF.
  useEffect(() => {
    if (!open) return;
    const meshCanvas = meshCanvasRef.current;
    if (!meshCanvas) return;

    const gl = createAutorigMarkerPreviewGl({
      width: CANVAS_W,
      height: CANVAS_H,
      canvas: meshCanvas,
    });
    glRef.current = gl;

    let cancelled = false;
    const load = async () => {
      if (!sourceAssetId) return;
      try {
        await ensureAutorigSourceTemplate(sourceAssetId, assets);
        if (cancelled) return;
        attachPreviewMesh();
      } catch {
        if (!cancelled) {
          setMeshReady(false);
          setMeshBounds(null);
        }
      }
    };
    void load();

    const unsub = subscribeAutoriggedCharacterReady(() => {
      if (!cancelled) attachPreviewMesh();
    });

    return () => {
      cancelled = true;
      unsub();
      disposeAutorigMarkerPreviewGl(glRef.current);
      glRef.current = null;
      setMeshReady(false);
      setMeshBounds(null);
    };
  }, [open, sourceAssetId, assets, attachPreviewMesh]);

  // Rebuild preview when orientation/height change while open.
  useEffect(() => {
    if (!open || !sourceAssetId) return;
    if (!isAutorigSourceTemplateReady(sourceAssetId)) return;
    attachPreviewMesh();
  }, [open, sourceAssetId, rig.orientation, height, attachPreviewMesh]);

  const renderMeshLayer = useCallback(() => {
    const gl = glRef.current;
    const activeFrame = frameRef.current;
    if (!gl || !activeFrame) return;
    renderAutorigMarkerPreview(gl, activeFrame);
  }, []);

  // On-demand mesh render: frame / bounds / view / open only — never idle rAF.
  useEffect(() => {
    if (!open) return;
    renderMeshLayer();
  }, [open, frame, meshReady, renderMeshLayer]);

  // 2D marker overlay (transparent over mesh; keeps pointer interaction).
  useEffect(() => {
    const canvas = markerCanvasRef.current;
    if (!canvas || !open) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const heightPx = canvas.height;
    ctx.clearRect(0, 0, width, heightPx);

    // Ground line
    const groundY = rig.orientation?.groundLevelMeters ?? 0;
    const ground = worldToCanvas([0, groundY, 0], frame);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.beginPath();
    ctx.moveTo(16, ground.y);
    ctx.lineTo(width - 16, ground.y);
    ctx.stroke();

    // Skeleton preview lines from fitted joints
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)';
    ctx.lineWidth = 2;
    const positions = fitted.jointPositions;
    const drawBone = (a?: Vec3, b?: Vec3) => {
      if (!a || !b) return;
      const pa = worldToCanvas(a, frame);
      const pb = worldToCanvas(b, frame);
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
      const point = worldToCanvas(marker.position, frame);
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

    // Magnifier while dragging — zooms mesh under the marker via shared frame coords.
    if (dragRef.current) {
      const marker = markers.find((item) => item.jointId === dragRef.current?.jointId);
      if (marker) {
        const point = worldToCanvas(marker.position, frame);
        // Ensure mesh layer is current before sampling.
        renderMeshLayer();
        drawAutorigMarkerMagnifier({
          ctx,
          meshCanvas: meshCanvasRef.current,
          markerCanvasX: point.x,
          markerCanvasY: point.y,
          magnifierCenterX: point.x + 56,
          magnifierCenterY: point.y - 56,
          markerFill: markerColor(marker.jointId),
        });
      }
    }
  }, [
    fitted,
    markers,
    open,
    required,
    selectedJointId,
    frame,
    rig.orientation?.groundLevelMeters,
    renderMeshLayer,
  ]);

  const hitTest = (x: number, y: number): HumanJointId | undefined => {
    for (const jointId of required) {
      const marker = markers.find((item) => item.jointId === jointId);
      if (!marker) continue;
      const point = worldToCanvas(marker.position, frame);
      if (Math.hypot(point.x - x, point.y - y) <= 12) return jointId;
    }
    return undefined;
  };

  return (
    <Modal open={open} onClose={onClose} title="Place autorig markers" size="xl">
      <div className="space-y-3" data-autorig-marker-wizard>
        <p className="text-sm text-secondary">
          Drag markers on the orthographic view over the imported mesh. Blue = left, amber = right, green = midline.
          Skeleton lines are fitted from markers; the mesh is not deformed yet.
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
            data-autorig-view-front
          >
            Front view
          </button>
          <button
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${showSide ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
            onClick={() => setShowSide(true)}
            data-autorig-view-side
          >
            Side view
          </button>
          {sourceAssetId && (
            <span className="self-center text-[10px] text-muted" data-autorig-mesh-status>
              {meshReady ? 'Mesh preview ready' : 'Loading mesh preview…'}
            </span>
          )}
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_14rem]">
          <div
            className="relative w-full overflow-hidden rounded-xl border border-subtle bg-[#0b1220]"
            data-autorig-marker-stage
          >
            {/* Bottom: on-demand WebGL mesh (non-interactive). */}
            <canvas
              ref={meshCanvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="pointer-events-none absolute inset-0 h-full w-full"
              data-autorig-mesh-canvas
              aria-hidden
            />
            {/* Top: 2D markers + skeleton; owns pointer interaction. */}
            <canvas
              ref={markerCanvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="relative z-10 w-full touch-none bg-transparent"
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
                const nextPos = canvasToWorld(x, y, frame, current);
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
          </div>

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
