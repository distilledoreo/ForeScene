import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { CheckCircle2, FlipHorizontal2, RotateCcw } from 'lucide-react';
import type {
  AssetRegistry,
  AutorigMarker,
  HumanJointId,
  HumanPose,
  PoseableRigAsset,
  Vec3,
} from '../../domain/types';
import {
  applyFittedSkeletonToRig,
  centerAutorigMarkersDepth,
  fitSkeletonFromMarkers,
  markerColor,
  markerJointsForMode,
  mirrorAllMarkers,
  sanitizeAutorigMarkers,
  suggestAutorigMarkers,
  upsertMarker,
  validateAutorigMarkers,
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
import { extractCanonicalTopology, extractCanonicalVertexPositions } from '../../engine/autorigCanonicalMesh';
import { buildSkinnedCharacterFromTemplate } from '../../engine/autorigSkinnedMesh';
import { generateDeterministicSkinWeights } from '../../engine/autorigSkinWeights';
import {
  createAutorigPreviewInstance,
  ensureAutorigSourceTemplate,
  isAutorigSourceTemplateReady,
  subscribeAutoriggedCharacterReady,
} from '../../engine/autoriggedPoseableCharacter';
import { HUMAN_JOINT_LABELS } from '../../engine/humanPose';
import { HUMAN_POSE_PRESETS } from '../../engine/humanPosePresets';
import { applySemanticPoseToBones, captureBoneRests, updateSkinnedMeshes } from '../../engine/poseableCharacter';
import { Modal } from './Modal';

interface HistoryEntry {
  markers: AutorigMarker[];
}

const CANVAS_W = 640;
const CANVAS_H = 480;

const REQUIRED_JOINTS = markerJointsForMode('full');
const PREVIEW_POSE_IDS = ['neutral', 'arms-raised', 'elbows-bent', 'sitting', 'walking', 'crouching'];

/** Preview instances own their material but share template geometry — dispose materials only. */
function disposePreviewMaterials(root: THREE.Object3D | null): void {
  root?.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material?.dispose();
  });
}

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
  const poseHint = rig.generationSettings?.poseHint;
  const sourceAssetId = sourceAssetIdProp
    ?? rig.originalSourceAssetId
    ?? rig.sourceMeshAssetId;
  const [markers, setMarkers] = useState<AutorigMarker[]>(() => {
    const fromRig = sanitizeAutorigMarkers(rig.markers);
    if (fromRig.length > 0) return fromRig;
    return suggestAutorigMarkers({
      size: [height * 0.4, height, height * 0.22],
      heightMeters: height,
      groundLevelMeters: rig.orientation?.groundLevelMeters ?? 0,
      poseHint,
    });
  });
  const [selectedJointId, setSelectedJointId] = useState<HumanJointId>('hips');
  const [past, setPast] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);
  const [showSide, setShowSide] = useState(false);
  const [meshReady, setMeshReady] = useState(false);
  const [meshBounds, setMeshBounds] = useState<OrientedMeshBounds | null>(null);
  const [meshSource, setMeshSource] = useState<THREE.Object3D | null>(null);
  const [showTestPose, setShowTestPose] = useState(false);
  const [activeTestPose, setActiveTestPose] = useState('neutral');

  const suggested = useMemo(
    () => suggestAutorigMarkers({
      // Prefer actual mesh bounds once known; otherwise use height-scaled defaults (not a fixed mannequin).
      size: meshBounds
        ? [
          Math.max(meshBounds.max[0] - meshBounds.min[0], height * 0.2),
          Math.max(meshBounds.max[1] - meshBounds.min[1], height * 0.5),
          Math.max(meshBounds.max[2] - meshBounds.min[2], height * 0.12),
        ]
        : [height * 0.4, height, height * 0.22],
      heightMeters: height,
      groundLevelMeters: rig.orientation?.groundLevelMeters ?? 0,
      poseHint,
    }),
    [height, meshBounds, poseHint, rig.orientation?.groundLevelMeters],
  );

  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const meshCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<AutorigMarkerPreviewGl | null>(null);
  const frameRef = useRef<AutorigOrthoFrame | null>(null);
  const dragRef = useRef<{ jointId: HumanJointId; pointerId: number } | undefined>(undefined);
  const preDragMarkersRef = useRef<AutorigMarker[] | undefined>(undefined);
  const depthCenteredRef = useRef(false);
  const previewRootRef = useRef<THREE.Object3D | null>(null);

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
    const fromRig = sanitizeAutorigMarkers(rig.markers);
    setMarkers(fromRig.length > 0 ? fromRig : suggested);
    setPast([]);
    setFuture([]);
    depthCenteredRef.current = false;
    setShowTestPose(false);
    setActiveTestPose('neutral');
  }, [open, rig, suggested]);

  // Always sanitize: selected autorig characters mount this dialog even when closed.
  const safeMarkers = useMemo(() => sanitizeAutorigMarkers(markers), [markers]);
  const issues = validateAutorigMarkers(safeMarkers, 'full');
  const fitted = useMemo(() => fitSkeletonFromMarkers(safeMarkers, 'full'), [safeMarkers]);

  // Heavy preview inputs (skin weights) track the fitted skeleton only between
  // drags — never once per pointermove.
  const [isDragging, setIsDragging] = useState(false);
  const [previewFitted, setPreviewFitted] = useState(fitted);
  useEffect(() => {
    if (!isDragging) setPreviewFitted(fitted);
  }, [fitted, isDragging]);

  const commit = (next: AutorigMarker[]) => {
    setPast((stack) => [...stack, { markers: safeMarkers }]);
    setFuture([]);
    setMarkers(sanitizeAutorigMarkers(next));
  };

  const centerDepth = () => {
    if (!meshSource) return;
    const result = centerAutorigMarkersDepth(safeMarkers, meshSource, view);
    commit(result.markers);
  };

  const undo = () => {
    setPast((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1]!;
      setFuture((ahead) => [{ markers: safeMarkers }, ...ahead]);
      setMarkers(sanitizeAutorigMarkers(previous.markers));
      return stack.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((stack) => {
      if (stack.length === 0) return stack;
      const next = stack[0]!;
      setPast((behind) => [...behind, { markers: safeMarkers }]);
      setMarkers(sanitizeAutorigMarkers(next.markers));
      return stack.slice(1);
    });
  };

  const attachPreviewMesh = useCallback(() => {
    const replacePreviewRoot = (root: THREE.Object3D | null) => {
      disposePreviewMaterials(previewRootRef.current);
      previewRootRef.current = root;
      setMeshSource(root);
    };
    if (!sourceAssetId || !isAutorigSourceTemplateReady(sourceAssetId)) {
      setMeshReady(false);
      setMeshBounds(null);
      replacePreviewRoot(null);
      return;
    }
    const preview = createAutorigPreviewInstance({
      sourceAssetId,
      assets,
      orientation: rig.orientation,
      approximateHeightMeters: height,
    });
    if (!preview) {
      setMeshReady(false);
      setMeshBounds(null);
      replacePreviewRoot(null);
      return;
    }
    replacePreviewRoot(preview.root);
    setMeshBounds(preview.bounds);
    setMeshReady(true);
    if (!rig.markers?.length && !depthCenteredRef.current) {
      const centered = centerAutorigMarkersDepth(suggested, preview.root);
      if (centered.centeredJointIds.length > 0) setMarkers(centered.markers);
      depthCenteredRef.current = true;
    }
  }, [assets, height, rig.markers, rig.orientation, sourceAssetId, suggested]);

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
      disposePreviewMaterials(previewRootRef.current);
      previewRootRef.current = null;
      setMeshSource(null);
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


  // ---- Deformation preview (built once per marker set; pose chips re-pose for free) ----
  const meshData = useMemo(() => {
    if (!showTestPose || !meshSource) return null;
    return {
      positions: extractCanonicalVertexPositions(meshSource),
      topology: extractCanonicalTopology(meshSource),
    };
  }, [showTestPose, meshSource]);

  const previewRig = useMemo(() => applyFittedSkeletonToRig(rig, previewFitted), [rig, previewFitted]);

  const previewBuffers = useMemo(() => {
    if (!meshData || !meshBounds) return undefined;
    return generateDeterministicSkinWeights({
      positions: meshData.positions,
      jointPositions: previewFitted.jointPositions,
      heightMeters: height,
      meshSize: [meshBounds.max[0] - meshBounds.min[0], height, meshBounds.max[2] - meshBounds.min[2]],
      topologyIndices: meshData.topology,
    });
  }, [meshData, meshBounds, previewFitted, height]);

  const deformationPreview = useMemo(() => {
    if (!previewBuffers || !meshSource) return null;
    const root = buildSkinnedCharacterFromTemplate({ template: meshSource, rig: previewRig, buffers: previewBuffers });
    const bones = new Map<HumanJointId, THREE.Bone>();
    root.traverse((node) => {
      const bone = node as THREE.Bone;
      const jointId = bone.userData.humanJointId as HumanJointId | undefined;
      if (bone.isBone && jointId) bones.set(jointId, bone);
    });
    return { root, bones, rests: captureBoneRests(bones) };
  }, [meshSource, previewRig, previewBuffers]);

  // Swap the GL layer between the static clay mesh and the deformation preview.
  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !open) return;
    setAutorigMarkerPreviewRoot(gl, deformationPreview ? deformationPreview.root : meshSource);
    renderMeshLayer();
  }, [open, deformationPreview, meshSource, renderMeshLayer]);

  // Deformation previews own cloned geometries (materials are shared with the clay
  // preview) — dispose geometries when a preview is replaced or the dialog unmounts.
  useEffect(() => {
    if (!deformationPreview) return;
    return () => {
      deformationPreview.root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
      });
    };
  }, [deformationPreview]);

  const previewTestPose = (poseId: string, pose: HumanPose | undefined) => {
    if (!deformationPreview) return;
    applySemanticPoseToBones({
      bones: deformationPreview.bones,
      rests: deformationPreview.rests,
      pose,
      canonicalPoseBases: previewRig.canonicalPoseBases,
    });
    updateSkinnedMeshes(deformationPreview.root);
    renderMeshLayer();
    setActiveTestPose(poseId);
  };


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

    for (const jointId of REQUIRED_JOINTS) {
      const marker = safeMarkers.find((item) => item.jointId === jointId);
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

    // Magnifier while dragging — samples the already-rendered mesh canvas (no re-render).
    if (dragRef.current) {
      const marker = safeMarkers.find((item) => item.jointId === dragRef.current?.jointId);
      if (marker) {
        const point = worldToCanvas(marker.position, frame);
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
    safeMarkers,
    open,
    selectedJointId,
    frame,
    rig.orientation?.groundLevelMeters,
  ]);

  const hitTest = (x: number, y: number): HumanJointId | undefined => {
    for (const jointId of REQUIRED_JOINTS) {
      const marker = safeMarkers.find((item) => item.jointId === jointId);
      if (!marker) continue;
      const point = worldToCanvas(marker.position, frame);
      if (Math.hypot(point.x - x, point.y - y) <= 12) return jointId;
    }
    return undefined;
  };


  return (
    <Modal open={open} onClose={onClose} title="Rig character" size="xl">
      <div className="space-y-3" data-autorig-marker-wizard>
        <p className="text-sm text-secondary">
          Markers are placed for you — drag any that are off onto the matching joint
          (blue = left, amber = right, green = midline), then click Rig character.
          {' '}Front adjusts left/right and height; Side adjusts depth only so the two views do not fight.
        </p>

        <div className="flex flex-wrap items-center gap-2">
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
          <div className="relative" style={{ width: CANVAS_W, maxWidth: '100%' }}>
            <canvas
              ref={meshCanvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              data-autorig-mesh-canvas
              className="pointer-events-none absolute inset-0 h-full w-full rounded-xl border border-subtle bg-surface"
            />
            <canvas
              ref={markerCanvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="relative h-full w-full cursor-crosshair rounded-xl"
              data-autorig-marker-canvas
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const x = ((event.clientX - rect.left) / rect.width) * event.currentTarget.width;
                const y = ((event.clientY - rect.top) / rect.height) * event.currentTarget.height;
                const hit = hitTest(x, y);
                if (!hit) return;
                setSelectedJointId(hit);
                preDragMarkersRef.current = safeMarkers;
                dragRef.current = { jointId: hit, pointerId: event.pointerId };
                setIsDragging(true);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = ((event.clientX - rect.left) / rect.width) * event.currentTarget.width;
                const y = ((event.clientY - rect.top) / rect.height) * event.currentTarget.height;
                const current = safeMarkers.find((item) => item.jointId === dragRef.current!.jointId)?.position ?? [0, 0, 0];
                const nextPos = canvasToWorld(x, y, frame, current);
                setMarkers((currentMarkers) => upsertMarker(currentMarkers, dragRef.current!.jointId, nextPos));
              }}
              onPointerUp={(event) => {
                if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
                const draggedJointId = dragRef.current.jointId;
                if (preDragMarkersRef.current) {
                  setPast((stack) => [...stack, { markers: preDragMarkersRef.current! }]);
                  setFuture([]);
                }
                preDragMarkersRef.current = undefined;
                dragRef.current = undefined;
                setIsDragging(false);
                // Front: snap Z through mesh thickness so markers sit mid-body after X/Y placement.
                // Side is depth-only — do not re-center X here or it undoes Front lateral work.
                if (meshSource && view === 'front') {
                  setMarkers((currentMarkers) => centerAutorigMarkersDepth(
                    currentMarkers,
                    meshSource,
                    'front',
                    draggedJointId,
                  ).markers);
                }
              }}
              onPointerCancel={() => {
                preDragMarkersRef.current = undefined;
                dragRef.current = undefined;
                setIsDragging(false);
              }}
            />
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Markers</div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {REQUIRED_JOINTS.map((jointId) => {
                const present = safeMarkers.some((marker) => marker.jointId === jointId);
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
          <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50" onClick={undo} disabled={past.length === 0}>Undo</button>
          <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50" onClick={redo} disabled={future.length === 0}>Redo</button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
            onClick={() => commit(mirrorAllMarkers(markers))}
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" /> Mirror L→R
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
            data-autorig-restore-suggested
            onClick={() => commit(suggested)}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset markers
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50"
            data-autorig-center-depth
            onClick={centerDepth}
            disabled={!meshReady}
          >
            Center depth
          </button>
        </div>

        <div className="space-y-2 rounded-xl border border-subtle bg-surface-muted/40 p-3" data-autorig-test-poses>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-primary">Deformation preview (optional)</div>
              <div className="text-[11px] text-muted">
                {showTestPose ? 'Pick a pose to check how the rig deforms.' : 'Check how the rig bends before applying it.'}
              </div>
            </div>
            <button
              type="button"
              className={`rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${showTestPose ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
              onClick={() => setShowTestPose((current) => !current)}
              disabled={!meshReady}
              data-autorig-toggle-preview
            >
              {showTestPose ? 'Hide preview' : 'Preview deformation'}
            </button>
          </div>
          {showTestPose && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {HUMAN_POSE_PRESETS
                  .filter((preset) => PREVIEW_POSE_IDS.includes(preset.id))
                  .map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`rounded-lg border px-2 py-1.5 text-xs font-semibold ${
                        activeTestPose === preset.id
                          ? 'border-accent text-accent'
                          : 'border-subtle text-secondary'
                      }`}
                      data-autorig-test-pose={preset.id}
                      onClick={() => previewTestPose(preset.id, preset.id === 'neutral' ? undefined : preset.pose)}
                    >
                      {preset.label}
                    </button>
                  ))}
              </div>
              {previewBuffers && (
                <p className="text-[11px] text-muted" data-autorig-fallback-count>
                  Weight quality: {(previewBuffers.fallbackVertexCount ?? 0) === 0
                    ? 'all vertices assigned to bones'
                    : `${previewBuffers.fallbackVertexCount} vertices use hips fallback (unmatched)`}
                  {previewBuffers.warnings?.length ? ` · ${previewBuffers.warnings[0]}` : ''}
                </p>
              )}
            </div>
          )}
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
            Rig character
          </button>
        </div>
      </div>
    </Modal>
  );
}

