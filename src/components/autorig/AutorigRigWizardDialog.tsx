import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { CheckCircle2 } from 'lucide-react';
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
  clampAutorigMarkersToMeshBounds,
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
  type AutorigMarkerView,
  type AutorigOrthoFrame,
  type OrientedMeshBounds,
} from '../../engine/autorigMarkerFrame';
import {
  createAutorigMarkerPreviewGl,
  disposeAutorigMarkerPreviewGl,
  renderAutorigMarkerPreview,
  replaceAutorigMarkerPreviewCanvas,
  setAutorigMarkerPreviewRoot,
  type AutorigMarkerPreviewGl,
} from '../../engine/autorigMarkerPreviewRenderer';
import {
  buildCanonicalAutorigTopology,
  type CanonicalAutorigTopology,
} from '../../engine/autorig/topology';
import {
  applyRegionEditDelta,
  createRegionEditDelta,
  mirrorRegionOverrides,
  resolveRegionLabels,
  type AutorigBodyRegionId,
  type RegionEditHistoryEntry,
} from '../../engine/autorig/regions';
import {
  applyLassoRegionCorrection,
  type LassoPoint,
} from '../../engine/autorig/regionSelection';
import {
  createRegionSelectionPass,
  disposeRegionSelectionPass,
  pickVisibleTrianglesInLasso,
  type RegionSelectionPass,
} from '../../engine/autorig/regionSelectionPass';
import {
  applyRegionColorsToPreviewRoot,
  updateRegionColorsOnPreviewRoot,
} from '../../engine/autorig/regionPreviewColors';
import {
  clearAutorigWizardDraft,
  decodeRegionDraftBytes,
  encodeRegionDraftBytes,
  loadAutorigWizardDraft,
  saveAutorigWizardDraft,
  type AutorigWizardStepId,
} from '../../engine/autorig/regionDraftStore';
import { autoLabelBodyRegions } from '../../engine/autorig/regions';
import { extractCanonicalTopology, extractCanonicalVertexPositions } from '../../engine/autorigCanonicalMesh';
import { buildSkinnedCharacterFromTemplate } from '../../engine/autorigSkinnedMesh';
import { generateDeterministicSkinWeights } from '../../engine/autorigSkinWeights';
import {
  createAutorigPreviewInstance,
  ensureAutorigSourceTemplate,
  isAutorigSourceTemplateReady,
  subscribeAutoriggedCharacterReady,
} from '../../engine/autoriggedPoseableCharacter';
import { applySemanticPoseToBones, captureBoneRests, updateSkinnedMeshes } from '../../engine/poseableCharacter';
import { Modal } from '../common/Modal';
import { AutorigWizardProgress } from './AutorigWizardProgress';
import { AutorigJointStep } from './AutorigJointStep';
import { AutorigBodyPartsStep, type AutorigBodyPartsView } from './AutorigBodyPartsStep';
import { AutorigPoseCheckStep } from './AutorigPoseCheckStep';
import { AutorigLassoOverlay } from './AutorigLassoOverlay';

interface MarkerHistoryEntry {
  markers: AutorigMarker[];
}

const CANVAS_W = 640;
const CANVAS_H = 480;
const REQUIRED_JOINTS = markerJointsForMode('full');

/** Preview instances own their material but share template geometry — dispose materials only. */
function disposePreviewMaterials(root: THREE.Object3D | null): void {
  root?.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material?.dispose();
  });
}

function eventToCanvasPoint(
  event: React.PointerEvent<HTMLCanvasElement>,
): LassoPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * event.currentTarget.width,
    y: ((event.clientY - rect.top) / rect.height) * event.currentTarget.height,
  };
}

/**
 * Three-stage guided autorig wizard: Joints → Body Parts → Check Pose.
 * Keeps Binder V1 weight generation for preview/apply until Binder V2 lands.
 */
export interface AutorigWizardSaveOptions {
  regionOverrides?: Uint8Array | null;
  suggestedRegions?: Uint8Array | null;
  topologyHash?: string;
}

export function AutorigRigWizardDialog({
  open,
  onClose,
  rig,
  onSave,
  sourceAssetId: sourceAssetIdProp,
  assets,
  initialStep,
}: {
  open: boolean;
  onClose: () => void;
  rig: PoseableRigAsset;
  onSave: (next: PoseableRigAsset, options?: AutorigWizardSaveOptions) => void;
  sourceAssetId?: string;
  assets?: AssetRegistry;
  /** Open directly on a step (e.g. Body Parts after topology-compatible rerig). */
  initialStep?: AutorigWizardStepId;
}) {
  const height = rig.generationSettings?.approximateHeightMeters ?? 1.75;
  const poseHint = rig.generationSettings?.poseHint;
  const sourceAssetId = sourceAssetIdProp
    ?? rig.originalSourceAssetId
    ?? rig.sourceMeshAssetId;

  const [step, setStep] = useState<AutorigWizardStepId>(initialStep ?? 'joints');
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
  const [markerPast, setMarkerPast] = useState<MarkerHistoryEntry[]>([]);
  const [markerFuture, setMarkerFuture] = useState<MarkerHistoryEntry[]>([]);
  const [jointView, setJointView] = useState<'front' | 'side'>('front');
  const [regionView, setRegionView] = useState<AutorigBodyPartsView>('front');
  const [previewView, setPreviewView] = useState<'front' | 'side' | 'perspective'>('front');
  const [meshReady, setMeshReady] = useState(false);
  const [meshBounds, setMeshBounds] = useState<OrientedMeshBounds | null>(null);
  const [meshSource, setMeshSource] = useState<THREE.Object3D | null>(null);
  const [previewGlReady, setPreviewGlReady] = useState(false);
  const [activeTestPose, setActiveTestPose] = useState('neutral');
  const [selectedRegion, setSelectedRegion] = useState<AutorigBodyRegionId>('torso');
  const [suggestedRegions, setSuggestedRegions] = useState<Uint8Array | null>(null);
  const [regionOverrides, setRegionOverrides] = useState<Uint8Array | null>(null);
  const [regionConfidence, setRegionConfidence] = useState<Float32Array | null>(null);
  const [regionPast, setRegionPast] = useState<RegionEditHistoryEntry[]>([]);
  const [regionFuture, setRegionFuture] = useState<RegionEditHistoryEntry[]>([]);
  const [labeling, setLabeling] = useState(false);
  const [topology, setTopology] = useState<CanonicalAutorigTopology | null>(null);
  const [lassoPoints, setLassoPoints] = useState<LassoPoint[]>([]);
  const [lassoDrawing, setLassoDrawing] = useState(false);
  const [dirty, setDirty] = useState(false);

  const suggested = useMemo(
    () => suggestAutorigMarkers({
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
  const suggestedRef = useRef(suggested);
  const attachPreviewMeshRef = useRef<() => void>(() => {});
  const assetsRef = useRef(assets);
  const regionColorDisposerRef = useRef<(() => void) | null>(null);
  const selectionPassRef = useRef<RegionSelectionPass | null>(null);
  const lassoPointsRef = useRef<LassoPoint[]>([]);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  suggestedRef.current = suggested;
  assetsRef.current = assets;

  const orthoView: AutorigMarkerView = step === 'regions'
    ? regionView
    : step === 'preview'
      ? (previewView === 'side' ? 'side' : 'front')
      : jointView;

  const frame = useMemo(
    () => computeAutorigOrthoFrame({
      bounds: meshBounds,
      view: orthoView,
      canvasWidth: CANVAS_W,
      canvasHeight: CANVAS_H,
      fallbackHeightMeters: height,
    }),
    [meshBounds, orthoView, height],
  );
  frameRef.current = frame;

  // Seed markers / draft once per open / rig identity.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fromRig = sanitizeAutorigMarkers(rig.markers);
    setMarkers(fromRig.length > 0 ? fromRig : suggestedRef.current);
    setMarkerPast([]);
    setMarkerFuture([]);
    setRegionPast([]);
    setRegionFuture([]);
    setSuggestedRegions(null);
    setRegionOverrides(null);
    setRegionConfidence(null);
    setTopology(null);
    setStep(initialStep ?? 'joints');
    setActiveTestPose('neutral');
    setDirty(false);
    depthCenteredRef.current = false;

    void loadAutorigWizardDraft(rig.id).then((draft) => {
      if (cancelled || !draft) return;
      try {
        const draftMarkers = sanitizeAutorigMarkers(JSON.parse(draft.markersJson) as AutorigMarker[]);
        if (draftMarkers.length > 0) setMarkers(draftMarkers);
        if (draft.step) setStep(draft.step);
        const suggestedBytes = decodeRegionDraftBytes(draft.suggestedB64);
        const overrideBytes = decodeRegionDraftBytes(draft.overridesB64);
        if (suggestedBytes) setSuggestedRegions(suggestedBytes);
        if (overrideBytes) setRegionOverrides(overrideBytes);
        if (draft.previewPoseId) setActiveTestPose(draft.previewPoseId);
        setDirty(true);
      } catch {
        // Ignore corrupt drafts.
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, rig, initialStep]);

  const safeMarkers = useMemo(() => sanitizeAutorigMarkers(markers), [markers]);
  const issues = validateAutorigMarkers(safeMarkers, 'full');

  const [isDragging, setIsDragging] = useState(false);
  const fitted = useMemo(() => {
    if (isDragging) return null;
    return fitSkeletonFromMarkers(safeMarkers, 'full');
  }, [safeMarkers, isDragging]);
  const [previewFitted, setPreviewFitted] = useState(() => fitSkeletonFromMarkers(safeMarkers, 'full'));
  useEffect(() => {
    if (!isDragging && fitted) setPreviewFitted(fitted);
  }, [fitted, isDragging]);
  const displayFitted = fitted ?? previewFitted;
  const applyFitted = fitted ?? previewFitted;

  const resolvedRegions = useMemo(() => {
    if (!suggestedRegions) return null;
    return resolveRegionLabels({ suggested: suggestedRegions, overrides: regionOverrides });
  }, [suggestedRegions, regionOverrides]);

  const commitMarkers = (next: AutorigMarker[]) => {
    setMarkerPast((stack) => [...stack, { markers: safeMarkers }]);
    setMarkerFuture([]);
    setMarkers(sanitizeAutorigMarkers(next));
    setDirty(true);
  };

  const centerDepth = () => {
    if (!meshSource) return;
    const result = centerAutorigMarkersDepth(safeMarkers, meshSource, jointView);
    commitMarkers(result.markers);
  };

  const undoMarkers = () => {
    setMarkerPast((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1]!;
      setMarkerFuture((ahead) => [{ markers: safeMarkers }, ...ahead]);
      setMarkers(sanitizeAutorigMarkers(previous.markers));
      setDirty(true);
      return stack.slice(0, -1);
    });
  };

  const redoMarkers = () => {
    setMarkerFuture((stack) => {
      if (stack.length === 0) return stack;
      const next = stack[0]!;
      setMarkerPast((behind) => [...behind, { markers: safeMarkers }]);
      setMarkers(sanitizeAutorigMarkers(next.markers));
      setDirty(true);
      return stack.slice(1);
    });
  };

  const commitRegionOverrides = (next: Uint8Array) => {
    if (!regionOverrides) {
      setRegionOverrides(next);
      setDirty(true);
      return;
    }
    const delta = createRegionEditDelta(regionOverrides, next);
    if (!delta) return;
    setRegionPast((stack) => [...stack, delta]);
    setRegionFuture([]);
    setRegionOverrides(next);
    setDirty(true);
  };

  const undoRegions = () => {
    if (!regionOverrides || regionPast.length === 0) return;
    const entry = regionPast[regionPast.length - 1]!;
    const next = new Uint8Array(regionOverrides);
    applyRegionEditDelta(next, entry, 'undo');
    setRegionPast((stack) => stack.slice(0, -1));
    setRegionFuture((ahead) => [entry, ...ahead]);
    setRegionOverrides(next);
    setDirty(true);
  };

  const redoRegions = () => {
    if (!regionOverrides || regionFuture.length === 0) return;
    const entry = regionFuture[0]!;
    const next = new Uint8Array(regionOverrides);
    applyRegionEditDelta(next, entry, 'redo');
    setRegionFuture((stack) => stack.slice(1));
    setRegionPast((behind) => [...behind, entry]);
    setRegionOverrides(next);
    setDirty(true);
  };

  const mirrorLabels = () => {
    if (!topology || !regionOverrides) return;
    const next = mirrorRegionOverrides({
      positions: topology.positions,
      overrides: regionOverrides,
      topologyHash: topology.topologyHash,
    });
    commitRegionOverrides(next);
  };

  const attachPreviewMesh = useCallback(() => {
    const replacePreviewRoot = (root: THREE.Object3D | null) => {
      regionColorDisposerRef.current?.();
      regionColorDisposerRef.current = null;
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
      assets: assetsRef.current,
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
      const centered = centerAutorigMarkersDepth(suggestedRef.current, preview.root);
      setMarkers(clampAutorigMarkersToMeshBounds(centered.markers, preview.bounds));
      depthCenteredRef.current = true;
    }
  }, [height, rig.markers, rig.orientation, sourceAssetId]);
  attachPreviewMeshRef.current = attachPreviewMesh;

  // WebGL lifecycle: create on open, dispose on close.
  useEffect(() => {
    if (!open) return;
    let meshCanvas = meshCanvasRef.current;
    if (!meshCanvas) return;

    let cancelled = false;
    let gl: AutorigMarkerPreviewGl | null = null;

    const tryCreate = (canvas: HTMLCanvasElement): AutorigMarkerPreviewGl | null => {
      try {
        return createAutorigMarkerPreviewGl({
          width: CANVAS_W,
          height: CANVAS_H,
          canvas,
        });
      } catch {
        return null;
      }
    };

    gl = tryCreate(meshCanvas);
    if (!gl) {
      meshCanvas = replaceAutorigMarkerPreviewCanvas(meshCanvas, CANVAS_W, CANVAS_H);
      meshCanvasRef.current = meshCanvas;
      gl = tryCreate(meshCanvas);
    }
    glRef.current = gl;
    setPreviewGlReady(Boolean(gl));

    const load = async () => {
      if (!sourceAssetId) return;
      try {
        await ensureAutorigSourceTemplate(sourceAssetId, assetsRef.current);
        if (cancelled) return;
        attachPreviewMeshRef.current();
      } catch {
        if (!cancelled) {
          setMeshReady(false);
          setMeshBounds(null);
        }
      }
    };
    void load();

    const unsub = subscribeAutoriggedCharacterReady(() => {
      if (!cancelled) attachPreviewMeshRef.current();
    });

    return () => {
      cancelled = true;
      unsub();
      disposeRegionSelectionPass(selectionPassRef.current);
      selectionPassRef.current = null;
      regionColorDisposerRef.current?.();
      regionColorDisposerRef.current = null;
      disposeAutorigMarkerPreviewGl(glRef.current);
      glRef.current = null;
      setPreviewGlReady(false);
      disposePreviewMaterials(previewRootRef.current);
      previewRootRef.current = null;
      // Do not clear meshBounds here — that recomputes `suggested` and used to
      // retrigger this effect via attachPreviewMesh, freezing the dialog.
      setMeshSource(null);
      setMeshReady(false);
    };
  }, [open, sourceAssetId]);

  useEffect(() => {
    if (open) return;
    setMeshBounds(null);
    setMeshSource(null);
    setMeshReady(false);
    setPreviewGlReady(false);
  }, [open]);

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

  useEffect(() => {
    if (!open) return;
    renderMeshLayer();
  }, [open, frame, meshReady, step, renderMeshLayer, resolvedRegions]);

  // Auto-label when entering Body Parts with fitted joints + mesh.
  useEffect(() => {
    if (!open || step !== 'regions' || !meshSource) return;
    if (suggestedRegions && topology) return;
    let cancelled = false;
    setLabeling(true);
    try {
      const built = buildCanonicalAutorigTopology(meshSource);
      if (cancelled) return;
      setTopology(built);
      const labeled = autoLabelBodyRegions({
        topology: built,
        jointPositions: applyFitted.jointPositions,
        poseHint,
      });
      if (cancelled) return;
      setSuggestedRegions((current) => current ?? labeled.suggested);
      setRegionOverrides((current) => current ?? new Uint8Array(labeled.suggested.length));
      setRegionConfidence(labeled.confidence);
    } finally {
      if (!cancelled) setLabeling(false);
    }
    return () => {
      cancelled = true;
    };
  }, [open, step, meshSource, suggestedRegions, topology, applyFitted.jointPositions, poseHint]);

  // Region color overlay while on Body Parts.
  useEffect(() => {
    if (!open || step !== 'regions' || !meshSource || !resolvedRegions) {
      regionColorDisposerRef.current?.();
      regionColorDisposerRef.current = null;
      const gl = glRef.current;
      if (gl && meshSource && step !== 'preview') {
        setAutorigMarkerPreviewRoot(gl, meshSource);
        renderMeshLayer();
      }
      return;
    }
    if (!regionColorDisposerRef.current) {
      regionColorDisposerRef.current = applyRegionColorsToPreviewRoot({
        root: meshSource,
        labels: resolvedRegions,
        confidence: regionConfidence,
      });
    } else {
      updateRegionColorsOnPreviewRoot({
        root: meshSource,
        labels: resolvedRegions,
        confidence: regionConfidence,
      });
    }
    const gl = glRef.current;
    if (gl) {
      setAutorigMarkerPreviewRoot(gl, meshSource);
      renderMeshLayer();
    }
  }, [open, step, meshSource, resolvedRegions, regionConfidence, renderMeshLayer]);

  // Selection pass lifecycle for Body Parts.
  useEffect(() => {
    if (!open || step !== 'regions' || !topology) {
      disposeRegionSelectionPass(selectionPassRef.current);
      selectionPassRef.current = null;
      return;
    }
    try {
      selectionPassRef.current = createRegionSelectionPass({
        topology,
        width: CANVAS_W,
        height: CANVAS_H,
      });
    } catch {
      selectionPassRef.current = null;
    }
    return () => {
      disposeRegionSelectionPass(selectionPassRef.current);
      selectionPassRef.current = null;
    };
  }, [open, step, topology]);

  // ---- Deformation preview (Binder V1 until PR 78) ----
  const meshData = useMemo(() => {
    if (step !== 'preview' || !meshSource) return null;
    return {
      positions: extractCanonicalVertexPositions(meshSource),
      topology: extractCanonicalTopology(meshSource),
    };
  }, [step, meshSource]);

  const previewRig = useMemo(() => applyFittedSkeletonToRig(rig, previewFitted), [rig, previewFitted]);

  const previewBuffers = useMemo(() => {
    if (!meshData || !meshBounds || step !== 'preview') return undefined;
    return generateDeterministicSkinWeights({
      positions: meshData.positions,
      jointPositions: previewFitted.jointPositions,
      heightMeters: height,
      meshSize: [meshBounds.max[0] - meshBounds.min[0], height, meshBounds.max[2] - meshBounds.min[2]],
      topologyIndices: meshData.topology,
    });
  }, [meshData, meshBounds, previewFitted, height, step]);

  const deformationPreview = useMemo(() => {
    if (!previewBuffers || !meshSource || step !== 'preview') return null;
    const root = buildSkinnedCharacterFromTemplate({ template: meshSource, rig: previewRig, buffers: previewBuffers });
    const bones = new Map<HumanJointId, THREE.Bone>();
    root.traverse((node) => {
      const bone = node as THREE.Bone;
      const jointId = bone.userData.humanJointId as HumanJointId | undefined;
      if (bone.isBone && jointId) bones.set(jointId, bone);
    });
    return { root, bones, rests: captureBoneRests(bones) };
  }, [meshSource, previewRig, previewBuffers, step]);

  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !open) return;
    if (step === 'preview' && deformationPreview) {
      setAutorigMarkerPreviewRoot(gl, deformationPreview.root);
    } else if (meshSource) {
      setAutorigMarkerPreviewRoot(gl, meshSource);
    }
    renderMeshLayer();
  }, [open, step, deformationPreview, meshSource, renderMeshLayer]);

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

  // 2D marker overlay (joints step only).
  useEffect(() => {
    const canvas = markerCanvasRef.current;
    if (!canvas || !open || step !== 'joints') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const heightPx = canvas.height;
    ctx.clearRect(0, 0, width, heightPx);

    const groundY = rig.orientation?.groundLevelMeters ?? 0;
    const ground = worldToCanvas([0, groundY, 0], frame);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.beginPath();
    ctx.moveTo(16, ground.y);
    ctx.lineTo(width - 16, ground.y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)';
    ctx.lineWidth = 2;
    const positions = displayFitted.jointPositions;
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
    drawBone(positions.chest, positions.upperSpine);
    drawBone(positions.upperSpine, positions.neck);
    drawBone(positions.neck, positions.head);
    drawBone(positions.upperSpine, positions.leftClavicle);
    drawBone(positions.leftClavicle, positions.leftUpperArm);
    drawBone(positions.leftUpperArm, positions.leftLowerArm);
    drawBone(positions.leftLowerArm, positions.leftHand);
    drawBone(positions.upperSpine, positions.rightClavicle);
    drawBone(positions.rightClavicle, positions.rightUpperArm);
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
    displayFitted,
    safeMarkers,
    open,
    step,
    selectedJointId,
    frame,
    isDragging,
    rig.orientation?.groundLevelMeters,
  ]);

  // Draft autosave (debounced).
  useEffect(() => {
    if (!open || !dirty) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      void saveAutorigWizardDraft({
        rigId: rig.id,
        step,
        markersJson: JSON.stringify(safeMarkers),
        topologyHash: topology?.topologyHash,
        suggestedB64: suggestedRegions ? encodeRegionDraftBytes(suggestedRegions) : undefined,
        overridesB64: regionOverrides ? encodeRegionDraftBytes(regionOverrides) : undefined,
        previewPoseId: activeTestPose,
        updatedAt: Date.now(),
      });
    }, 400);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [
    open,
    dirty,
    rig.id,
    step,
    safeMarkers,
    topology?.topologyHash,
    suggestedRegions,
    regionOverrides,
    activeTestPose,
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

  const finishLasso = () => {
    const points = lassoPointsRef.current;
    setLassoDrawing(false);
    setLassoPoints([]);
    lassoPointsRef.current = [];
    if (!topology || !suggestedRegions || !regionOverrides || !resolvedRegions) return;
    if (points.length < 3) return;

    let visibleTriangleIds: Uint32Array | null = null;
    const pass = selectionPassRef.current;
    if (pass) {
      try {
        visibleTriangleIds = pickVisibleTrianglesInLasso({
          pass,
          frame,
          polygon: points,
        });
      } catch {
        visibleTriangleIds = null;
      }
    }

    const result = applyLassoRegionCorrection({
      topology,
      suggested: suggestedRegions,
      overrides: regionOverrides,
      resolved: resolvedRegions,
      region: selectedRegion,
      polygon: points,
      projectVertex: (vertexIndex) => {
        const i = vertexIndex * 3;
        const position: Vec3 = [
          topology.positions[i]!,
          topology.positions[i + 1]!,
          topology.positions[i + 2]!,
        ];
        return worldToCanvas(position, frame);
      },
      visibleTriangleIds,
    });
    if (result.affectedVertices.length === 0) return;
    commitRegionOverrides(result.overrides);
  };

  const canContinueJoints = !issues.some((issue) => issue.code === 'missing');
  const canContinueRegions = Boolean(resolvedRegions) && !labeling;
  const uncertainHint = regionConfidence && suggestedRegions
    ? (() => {
      let uncertain = 0;
      for (let i = 0; i < regionConfidence.length; i += 1) {
        if ((regionConfidence[i] ?? 1) < 0.22) uncertain += 1;
      }
      if (uncertain === 0) return null;
      return 'Pale areas are less certain — check those first.';
    })()
    : null;

  const handleApply = () => {
    const nextRig = applyFittedSkeletonToRig(rig, applyFitted);
    onSave(nextRig, {
      regionOverrides,
      suggestedRegions,
      topologyHash: topology?.topologyHash,
    });
    void clearAutorigWizardDraft(rig.id);
    setDirty(false);
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Rig character" size="xl">
      <div className="space-y-3" data-autorig-rig-wizard data-autorig-marker-wizard>
        <AutorigWizardProgress step={step} />

        <div className="grid gap-3 lg:grid-cols-[1fr_16rem]">
          <div className="relative" style={{ width: CANVAS_W, maxWidth: '100%' }}>
            <canvas
              ref={meshCanvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              data-autorig-mesh-canvas
              className="pointer-events-none absolute inset-0 h-full w-full rounded-xl border border-subtle bg-[#1c1f26]"
            />
            {step === 'joints' && (
              <canvas
                ref={markerCanvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                className="relative h-full w-full cursor-crosshair rounded-xl bg-transparent"
                data-autorig-marker-canvas
                onPointerDown={(event) => {
                  const point = eventToCanvasPoint(event);
                  const hit = hitTest(point.x, point.y);
                  if (!hit) return;
                  setSelectedJointId(hit);
                  preDragMarkersRef.current = safeMarkers;
                  dragRef.current = { jointId: hit, pointerId: event.pointerId };
                  setIsDragging(true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
                  const point = eventToCanvasPoint(event);
                  const jointId = dragRef.current.jointId;
                  const current = safeMarkers.find((item) => item.jointId === jointId)?.position ?? [0, 0, 0];
                  const nextPos = canvasToWorld(point.x, point.y, frame, current);
                  setMarkers((currentMarkers) => upsertMarker(currentMarkers, jointId, nextPos));
                }}
                onPointerUp={(event) => {
                  if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
                  const draggedJointId = dragRef.current.jointId;
                  if (preDragMarkersRef.current) {
                    setMarkerPast((stack) => [...stack, { markers: preDragMarkersRef.current! }]);
                    setMarkerFuture([]);
                  }
                  preDragMarkersRef.current = undefined;
                  dragRef.current = undefined;
                  setIsDragging(false);
                  setDirty(true);
                  if (meshSource && jointView === 'front') {
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
            )}
            {step === 'regions' && (
              <AutorigLassoOverlay
                width={CANVAS_W}
                height={CANVAS_H}
                points={lassoPoints}
                drawing={lassoDrawing}
                className="relative h-full w-full cursor-crosshair rounded-xl bg-transparent"
                onPointerDown={(event) => {
                  const point = eventToCanvasPoint(event);
                  lassoPointsRef.current = [point];
                  setLassoPoints([point]);
                  setLassoDrawing(true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!lassoDrawing) return;
                  const point = eventToCanvasPoint(event);
                  lassoPointsRef.current = [...lassoPointsRef.current, point];
                  setLassoPoints(lassoPointsRef.current);
                }}
                onPointerUp={() => {
                  if (!lassoDrawing) return;
                  finishLasso();
                }}
                onPointerCancel={() => {
                  setLassoDrawing(false);
                  setLassoPoints([]);
                  lassoPointsRef.current = [];
                }}
              />
            )}
            {step === 'preview' && (
              <div
                className="relative h-full w-full rounded-xl"
                style={{ width: CANVAS_W, height: CANVAS_H }}
                aria-hidden
              />
            )}
          </div>

          <div>
            {step === 'joints' && (
              <AutorigJointStep
                view={jointView}
                onViewChange={setJointView}
                meshReady={meshReady}
                previewGlReady={previewGlReady}
                sourceAssetId={sourceAssetId}
                selectedJointId={selectedJointId}
                onSelectJoint={setSelectedJointId}
                markers={safeMarkers}
                canUndo={markerPast.length > 0}
                canRedo={markerFuture.length > 0}
                onUndo={undoMarkers}
                onRedo={redoMarkers}
                onMirror={() => commitMarkers(mirrorAllMarkers(markers))}
                onReset={() => commitMarkers(suggested)}
                onCenterDepth={centerDepth}
                issues={issues}
              />
            )}
            {step === 'regions' && (
              <AutorigBodyPartsStep
                view={regionView}
                onViewChange={setRegionView}
                selectedRegion={selectedRegion}
                onSelectRegion={setSelectedRegion}
                meshReady={meshReady}
                labeling={labeling}
                uncertainHint={uncertainHint}
                canUndo={regionPast.length > 0}
                canRedo={regionFuture.length > 0}
                onUndo={undoRegions}
                onRedo={redoRegions}
                onMirrorLabels={mirrorLabels}
              />
            )}
            {step === 'preview' && (
              <AutorigPoseCheckStep
                view={previewView}
                onViewChange={setPreviewView}
                meshReady={meshReady}
                generating={!previewBuffers && meshReady}
                activeTestPose={activeTestPose}
                onSelectPose={previewTestPose}
                warnings={previewBuffers?.warnings}
                fallbackCount={previewBuffers?.fallbackVertexCount}
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap justify-between gap-2 border-t border-subtle pt-3">
          <div className="flex flex-wrap gap-2">
            {step !== 'joints' && (
              <button
                type="button"
                className="rounded-xl border border-subtle px-3 py-2 text-sm font-semibold text-secondary"
                data-autorig-back
                onClick={() => setStep(step === 'preview' ? 'regions' : 'joints')}
              >
                {step === 'preview' ? 'Fix body parts' : 'Adjust joints'}
              </button>
            )}
            {step === 'preview' && (
              <button
                type="button"
                className="rounded-xl border border-subtle px-3 py-2 text-sm font-semibold text-secondary"
                data-autorig-adjust-joints
                onClick={() => setStep('joints')}
              >
                Adjust joints
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-xl border border-subtle px-3 py-2 text-sm font-semibold text-secondary" onClick={handleClose}>
              Cancel
            </button>
            {step === 'joints' && (
              <button
                type="button"
                className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                data-autorig-continue-joints
                disabled={!canContinueJoints}
                onClick={() => {
                  // Marker edits invalidate suggested regions.
                  setSuggestedRegions(null);
                  setTopology(null);
                  setStep('regions');
                }}
              >
                Continue
              </button>
            )}
            {step === 'regions' && (
              <button
                type="button"
                className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                data-autorig-continue-regions
                disabled={!canContinueRegions}
                onClick={() => setStep('preview')}
              >
                Continue
              </button>
            )}
            {step === 'preview' && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                data-autorig-apply-skeleton
                disabled={!canContinueJoints || !previewBuffers}
                onClick={handleApply}
              >
                <CheckCircle2 className="h-4 w-4" />
                Looks good — Apply rig
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
