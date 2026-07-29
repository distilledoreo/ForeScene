import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
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
  resolveRegionLabels,
  type AutorigBodyRegionId,
  type RegionEditHistoryEntry,
} from '../../engine/autorig/regions';
import {
  applyBrushRegionCorrection,
  applyLassoRegionCorrection,
  type AutorigCorrectionResult,
  type BrushStrokePoint,
  type LassoPoint,
} from '../../engine/autorig/regionSelection';
import {
  createRegionSelectionPass,
  disposeRegionSelectionPass,
  invalidateRegionSelectionPick,
  pickVisibleTrianglesAlongBrushStroke,
  pickVisibleTrianglesInLasso,
  updateRegionSelectionPassFromSkinnedRoot,
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
  migrateAutorigWizardStep,
  saveAutorigWizardDraft,
  type AutorigPoseFixMode,
  type AutorigWizardStepId,
} from '../../engine/autorig/regionDraftStore';
import { autoLabelBodyRegions } from '../../engine/autorig/regions';
import { extractCanonicalTopology, extractCanonicalVertexPositions } from '../../engine/autorigCanonicalMesh';
import { buildSkinnedCharacterFromTemplate } from '../../engine/autorigSkinnedMesh';
import {
  generatePartialRegionConstrainedSkinWeights,
  generateRegionConstrainedSkinWeights,
} from '../../engine/autorig/regionConstrainedWeights';
import {
  applyPartialSkinUpdateToPreviewSession,
  createAutorigPreviewSession,
  extractCanonicalPosedPositions,
  type AutorigPreviewSession,
} from '../../engine/autorig/previewSession';
import {
  buildDirtyVertexSet,
  createRegionEditFromLabels,
} from '../../engine/autorig/dirtyRegionSet';
import {
  analyzeDiagnosticPose,
  validateNeutralDeformation,
  type AutorigDeformationIssue,
} from '../../engine/autorig/deformationValidation';
import {
  DEFORMATION_AUTO_REPAIR_POSE_IDS,
  formatDeformationAutoRepairMessage,
  overridesFromRepairedLabels,
  runHighConfidenceDeformationAutoRepair,
} from '../../engine/autorig/deformationAutoRepair';
import {
  createAutorigPreviewInstance,
  ensureAutorigSourceTemplate,
  isAutorigSourceTemplateReady,
  subscribeAutoriggedCharacterReady,
} from '../../engine/autoriggedPoseableCharacter';
import { applySemanticPoseToBones, captureBoneRests, updateSkinnedMeshes } from '../../engine/poseableCharacter';
import { getHumanPosePreset, HUMAN_POSE_PRESETS } from '../../engine/humanPosePresets';
import type { SkinWeightBuffers } from '../../engine/autorigSkinWeights';
import { Modal } from '../common/Modal';
import { AutorigWizardProgress } from './AutorigWizardProgress';
import { AutorigJointStep } from './AutorigJointStep';
import { AutorigPoseFixStep } from './AutorigPoseFixStep';
import { AutorigLassoOverlay } from './AutorigLassoOverlay';
import { AutorigBrushOverlay } from './AutorigBrushOverlay';
import { useAutorigPaintSession } from './hooks/useAutorigPaintSession';
import type { AutorigFixTool } from './AutorigFixToolbar';

interface MarkerHistoryEntry {
  markers: AutorigMarker[];
}

const CANVAS_W = 640;
const CANVAS_H = 480;
const REQUIRED_JOINTS = markerJointsForMode('full');
const DEFAULT_BRUSH_RADIUS = 36;

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

function poseFromId(poseId: string): HumanPose | undefined {
  if (poseId === 'neutral') return undefined;
  return HUMAN_POSE_PRESETS.find((preset) => preset.id === poseId)?.pose;
}

/**
 * Two-stage guided autorig wizard: Joints → Pose & Fix.
 * Region painting happens on the posed preview (Fix deformation).
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
  /** Open directly on a step (legacy `regions`/`preview` map to Pose & Fix). */
  initialStep?: AutorigWizardStepId | 'regions' | 'preview';
}) {
  const height = rig.generationSettings?.approximateHeightMeters ?? 1.75;
  const poseHint = rig.generationSettings?.poseHint;
  const sourceAssetId = sourceAssetIdProp
    ?? rig.originalSourceAssetId
    ?? rig.sourceMeshAssetId;

  const [step, setStep] = useState<AutorigWizardStepId>(() => migrateAutorigWizardStep(initialStep ?? 'joints'));
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
  const [preparing, setPreparing] = useState(false);
  const [updatingDeformation, setUpdatingDeformation] = useState(false);
  const [topology, setTopology] = useState<CanonicalAutorigTopology | null>(null);
  const [lassoPoints, setLassoPoints] = useState<LassoPoint[]>([]);
  const [lassoDrawing, setLassoDrawing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [poseIssues, setPoseIssues] = useState<AutorigDeformationIssue[]>([]);
  const [fixEnabled, setFixEnabled] = useState(false);
  const [fixTool, setFixTool] = useState<AutorigFixTool>('brush');
  const [restoreAutomatic, setRestoreAutomatic] = useState(false);
  const [showAssignments, setShowAssignments] = useState(false);
  const [correctionResult, setCorrectionResult] = useState<AutorigCorrectionResult | null>(null);
  const [prepareNotice, setPrepareNotice] = useState<string | null>(null);
  const [perspectiveYaw, setPerspectiveYaw] = useState(0);

  const paint = useAutorigPaintSession(DEFAULT_BRUSH_RADIUS);

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
  const orbitRef = useRef<{ pointerId: number; lastX: number } | null>(null);
  const activePoseRef = useRef<HumanPose | undefined>(undefined);
  const activePoseIdRef = useRef('neutral');
  const pendingPoseRestoreRef = useRef(false);
  const previewSessionRef = useRef<AutorigPreviewSession | null>(null);
  const previousResolvedRef = useRef<Uint8Array | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);

  const disposePreviewSession = useCallback(() => {
    const session = previewSessionRef.current;
    if (!session) return;
    session.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    previewSessionRef.current = null;
  }, []);

  suggestedRef.current = suggested;
  assetsRef.current = assets;
  activePoseIdRef.current = activeTestPose;

  const poseFixMode: AutorigPoseFixMode = !fixEnabled
    ? 'inspect'
    : fixTool === 'lasso'
      ? 'lasso'
      : 'paint';

  const orthoView: AutorigMarkerView = step === 'pose-fix'
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
    setStep(migrateAutorigWizardStep(initialStep ?? 'joints'));
    setActiveTestPose('neutral');
    activePoseRef.current = undefined;
    setDirty(false);
    setFixEnabled(false);
    setFixTool('brush');
    setRestoreAutomatic(false);
    setShowAssignments(false);
    setCorrectionResult(null);
    setPerspectiveYaw(0);
    setPreparing(false);
    setUpdatingDeformation(false);
    depthCenteredRef.current = false;
    previewSessionRef.current = null;
    previousResolvedRef.current = null;
    setSessionVersion(0);

    void loadAutorigWizardDraft(rig.id).then((draft) => {
      if (cancelled || !draft) return;
      try {
        const draftMarkers = sanitizeAutorigMarkers(JSON.parse(draft.markersJson) as AutorigMarker[]);
        if (draftMarkers.length > 0) setMarkers(draftMarkers);
        if (draft.step) setStep(migrateAutorigWizardStep(draft.step));
        const suggestedBytes = decodeRegionDraftBytes(draft.suggestedB64);
        const overrideBytes = decodeRegionDraftBytes(draft.overridesB64);
        if (suggestedBytes) setSuggestedRegions(suggestedBytes);
        if (overrideBytes) setRegionOverrides(overrideBytes);
        if (draft.previewPoseId) {
          setActiveTestPose(draft.previewPoseId);
          activePoseRef.current = poseFromId(draft.previewPoseId);
        }
        if (draft.mode === 'paint' || draft.mode === 'lasso') {
          setFixEnabled(true);
          setFixTool(draft.mode === 'lasso' ? 'lasso' : 'brush');
        }
        if (draft.selectedRegion) setSelectedRegion(draft.selectedRegion as AutorigBodyRegionId);
        if (typeof draft.brushRadius === 'number') paint.setBrushRadius(draft.brushRadius);
        setDirty(true);
      } catch {
        // Ignore corrupt drafts.
      }
    });

    return () => {
      cancelled = true;
    };
  // paint.setBrushRadius is stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const rebindAfterEditRef = useRef<(nextResolved: Uint8Array) => void>(() => {});

  const commitRegionOverrides = (next: Uint8Array, options?: { skipHistory?: boolean }) => {
    if (!regionOverrides || !suggestedRegions) {
      setRegionOverrides(next);
      setDirty(true);
      return;
    }
    const delta = createRegionEditDelta(regionOverrides, next);
    if (!delta) return;
    if (!options?.skipHistory) {
      setRegionPast((stack) => [...stack, delta]);
      setRegionFuture([]);
    }
    setRegionOverrides(next);
    setDirty(true);
    const nextResolved = resolveRegionLabels({ suggested: suggestedRegions, overrides: next });
    rebindAfterEditRef.current(nextResolved);
  };

  const undoRegions = () => {
    if (!regionOverrides || !suggestedRegions || regionPast.length === 0) return;
    const entry = regionPast[regionPast.length - 1]!;
    const next = new Uint8Array(regionOverrides);
    applyRegionEditDelta(next, entry, 'undo');
    setRegionPast((stack) => stack.slice(0, -1));
    setRegionFuture((ahead) => [entry, ...ahead]);
    setRegionOverrides(next);
    setDirty(true);
    setCorrectionResult(null);
    const nextResolved = resolveRegionLabels({ suggested: suggestedRegions, overrides: next });
    rebindAfterEditRef.current(nextResolved);
  };

  const redoRegions = () => {
    if (!regionOverrides || !suggestedRegions || regionFuture.length === 0) return;
    const entry = regionFuture[0]!;
    const next = new Uint8Array(regionOverrides);
    applyRegionEditDelta(next, entry, 'redo');
    setRegionFuture((stack) => stack.slice(1));
    setRegionPast((behind) => [...behind, entry]);
    setRegionOverrides(next);
    setDirty(true);
    setCorrectionResult(null);
    const nextResolved = resolveRegionLabels({ suggested: suggestedRegions, overrides: next });
    rebindAfterEditRef.current(nextResolved);
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
      disposePreviewSession();
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
  }, [open, sourceAssetId, disposePreviewSession]);

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
  }, [open, frame, meshReady, step, renderMeshLayer, resolvedRegions, showAssignments, perspectiveYaw]);

  /** Ensure topology + automatic regions exist before Pose & Fix. */
  const ensureRegionsReady = useCallback((options?: { forceRelabel?: boolean }): boolean => {
    if (!meshSource) return false;
    if (!options?.forceRelabel && suggestedRegions && topology) return true;
    try {
      const built = (!options?.forceRelabel && topology)
        ? topology
        : buildCanonicalAutorigTopology(meshSource);
      setTopology(built);
      const labeled = autoLabelBodyRegions({
        topology: built,
        jointPositions: applyFitted.jointPositions,
        poseHint,
      });
      if (options?.forceRelabel) {
        setSuggestedRegions(labeled.suggested);
        // Preserve existing hard overrides when topology length matches.
        setRegionOverrides((current) => (
          current && current.length === labeled.suggested.length
            ? current
            : new Uint8Array(labeled.suggested.length)
        ));
      } else {
        setSuggestedRegions((current) => current ?? labeled.suggested);
        setRegionOverrides((current) => current ?? new Uint8Array(labeled.suggested.length));
      }
      setRegionConfidence(labeled.confidence);
      return true;
    } catch {
      return false;
    }
  }, [meshSource, suggestedRegions, topology, applyFitted.jointPositions, poseHint]);

  // Auto-prepare when landing on Pose & Fix (draft restore / rerig handoff).
  useEffect(() => {
    if (!open || step !== 'pose-fix' || !meshSource) return;
    if (suggestedRegions && topology) return;
    setPreparing(true);
    const ok = ensureRegionsReady();
    setPreparing(false);
    if (!ok) setCorrectionResult({ status: 'failed', message: 'Could not prepare pose preview.' });
  }, [open, step, meshSource, suggestedRegions, topology, ensureRegionsReady]);

  // ---- Persistent deformation preview session ----
  const meshData = useMemo(() => {
    if (step !== 'pose-fix' || !meshSource) return null;
    return {
      positions: extractCanonicalVertexPositions(meshSource),
      topology: extractCanonicalTopology(meshSource),
    };
  }, [step, meshSource]);

  const previewRig = useMemo(() => applyFittedSkeletonToRig(rig, previewFitted), [rig, previewFitted]);

  // Build (or rebuild) the skinned preview only when joints / topology / mesh change —
  // not after every paint stroke. Runs silent diagnostic poses and high-confidence
  // spike auto-repair before the user reaches the brush.
  useEffect(() => {
    if (!open || step !== 'pose-fix' || !meshSource || !meshData || !meshBounds) return;
    if (!topology || !resolvedRegions) return;

    disposePreviewSession();
    setPrepareNotice(null);

    const meshSize: [number, number, number] = [
      meshBounds.max[0] - meshBounds.min[0],
      height,
      meshBounds.max[2] - meshBounds.min[2],
    ];

    let buffers = generateRegionConstrainedSkinWeights({
      positions: meshData.positions,
      regionLabels: resolvedRegions,
      jointPositions: previewFitted.jointPositions,
      topology,
      heightMeters: height,
      meshSize,
    });

    const root = buildSkinnedCharacterFromTemplate({
      template: meshSource,
      rig: previewRig,
      buffers,
    });
    const bones = new Map<HumanJointId, THREE.Bone>();
    root.traverse((node) => {
      const bone = node as THREE.Bone;
      const jointId = bone.userData.humanJointId as HumanJointId | undefined;
      if (bone.isBone && jointId) bones.set(jointId, bone);
    });
    const rests = captureBoneRests(bones);

    let finalLabels = new Uint8Array(resolvedRegions);

    const poseRoot = (
      pose: HumanPose | undefined,
      candidateBuffers?: SkinWeightBuffers,
    ) => {
      if (candidateBuffers) {
        // Push candidate weights onto the temporary root before posing.
        const ipv = candidateBuffers.influencesPerVertex;
        let vertexOffset = 0;
        root.traverse((node) => {
          const mesh = node as THREE.SkinnedMesh;
          if (!mesh.isSkinnedMesh || !mesh.geometry) return;
          const position = mesh.geometry.getAttribute('position');
          const vertexCount = position?.count ?? 0;
          const indexAttr = mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
          const weightAttr = mesh.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
          if (!indexAttr || !weightAttr) {
            vertexOffset += vertexCount;
            return;
          }
          const srcStart = vertexOffset * ipv;
          for (let i = 0; i < vertexCount * ipv; i += 1) {
            (indexAttr.array as Uint16Array)[i] = candidateBuffers.indices[srcStart + i]!;
            (weightAttr.array as Float32Array)[i] = candidateBuffers.weights[srcStart + i]!;
          }
          indexAttr.needsUpdate = true;
          weightAttr.needsUpdate = true;
          vertexOffset += vertexCount;
        });
      }
      applySemanticPoseToBones({
        bones,
        rests,
        pose,
        canonicalPoseBases: previewRig.canonicalPoseBases,
      });
      updateSkinnedMeshes(root);
      root.rotation.y = 0;
      root.updateMatrixWorld(true);
    };

    try {
      const frames = [];
      for (const poseId of DEFORMATION_AUTO_REPAIR_POSE_IDS) {
        const preset = getHumanPosePreset(poseId);
        if (!preset) continue;
        poseRoot(preset.pose, buffers);
        frames.push({
          poseId,
          positions: extractCanonicalPosedPositions(root),
        });
      }
      poseRoot(undefined, buffers);

      if (frames.length > 0) {
        const repair = runHighConfidenceDeformationAutoRepair({
          restPositions: meshData.positions,
          topology,
          regionLabels: finalLabels,
          buffers,
          frames,
          jointPositions: previewFitted.jointPositions,
          regenerateWeights: (labels) => generateRegionConstrainedSkinWeights({
            positions: meshData.positions,
            regionLabels: labels,
            jointPositions: previewFitted.jointPositions,
            topology,
            heightMeters: height,
            meshSize,
          }),
          evaluatePoseFrames: (candidateBuffers) => {
            const nextFrames = [];
            for (const poseId of DEFORMATION_AUTO_REPAIR_POSE_IDS) {
              const preset = getHumanPosePreset(poseId);
              if (!preset) continue;
              poseRoot(preset.pose, candidateBuffers);
              nextFrames.push({
                poseId,
                positions: extractCanonicalPosedPositions(root),
              });
            }
            poseRoot(undefined, candidateBuffers);
            const neutralPosed = extractCanonicalPosedPositions(root);
            let neutralMaxDrift = 0;
            const rest = meshData.positions;
            const n = Math.floor(Math.min(rest.length, neutralPosed.length) / 3);
            for (let v = 0; v < n; v += 1) {
              const i = v * 3;
              const dist = Math.hypot(
                neutralPosed[i]! - rest[i]!,
                neutralPosed[i + 1]! - rest[i + 1]!,
                neutralPosed[i + 2]! - rest[i + 2]!,
              );
              if (dist > neutralMaxDrift) neutralMaxDrift = dist;
            }
            return { frames: nextFrames, neutralMaxDrift };
          },
        });

        buffers = repair.buffers;
        finalLabels = repair.regionLabels;
        poseRoot(undefined, buffers);

        if (repair.repairedVertexCount > 0) {
          setPrepareNotice(formatDeformationAutoRepairMessage(repair));
          if (suggestedRegions) {
            let labelsChanged = false;
            for (let v = 0; v < finalLabels.length; v += 1) {
              if (finalLabels[v] !== resolvedRegions[v]) {
                labelsChanged = true;
                break;
              }
            }
            if (labelsChanged) {
              setRegionOverrides(overridesFromRepairedLabels({
                suggested: suggestedRegions,
                previousOverrides: regionOverrides,
                repairedLabels: repair.regionLabels,
              }));
            }
          }
        }
      }
    } catch {
      // Keep the initial Binder V2 result if silent diagnostics fail.
      poseRoot(undefined, buffers);
    }

    const session = createAutorigPreviewSession({
      root,
      bones,
      rests,
      topology,
      buffers,
      activePoseId: activePoseIdRef.current,
      activePose: activePoseRef.current,
    });
    previewSessionRef.current = session;
    previousResolvedRef.current = finalLabels;
    setSessionVersion((value) => value + 1);

    return () => {
      disposePreviewSession();
    };
  // Paint corrections update in place — only rebuild when structural inputs change.
  // `Boolean(resolvedRegions)` gates first readiness without tracking label edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    step,
    meshSource,
    meshData,
    meshBounds,
    topology?.topologyHash,
    Boolean(resolvedRegions),
    previewFitted,
    previewRig,
    height,
    disposePreviewSession,
  ]);

  const deformationPreview = previewSessionRef.current && sessionVersion > 0
    ? previewSessionRef.current
    : null;

  const previewBuffers = deformationPreview?.buffers;

  const rebindPreviewAfterRegionEdit = useCallback((nextResolved: Uint8Array) => {
    const session = previewSessionRef.current;
    if (!session || !meshData || !meshBounds) {
      setUpdatingDeformation(false);
      return;
    }
    const previous = previousResolvedRef.current ?? nextResolved;
    session.editRevision += 1;
    const revision = session.editRevision;
    setUpdatingDeformation(true);

    try {
      const edit = createRegionEditFromLabels({
        previousLabels: previous,
        nextLabels: nextResolved,
      });
      const dirtyVertices = edit
        ? buildDirtyVertexSet({ topology: session.topology, edit })
        : new Uint32Array(0);

      const partial = generatePartialRegionConstrainedSkinWeights({
        positions: meshData.positions,
        regionLabels: nextResolved,
        previousRegionLabels: previous,
        jointPositions: previewFitted.jointPositions,
        topology: session.topology,
        heightMeters: height,
        meshSize: [
          meshBounds.max[0] - meshBounds.min[0],
          height,
          meshBounds.max[2] - meshBounds.min[2],
        ],
        revision,
        dirtyVertices,
      });

      if (revision !== session.editRevision) {
        // A newer correction superseded this one.
        return;
      }

      if (partial.vertexIndices.length > 0) {
        const applied = applyPartialSkinUpdateToPreviewSession(session, partial);
        if (!applied.ok) {
          setCorrectionResult({
            status: 'failed',
            message: applied.message || 'The correction could not be applied. Your previous rig has been kept.',
          });
          setUpdatingDeformation(false);
          return;
        }
      }

      previousResolvedRef.current = new Uint8Array(nextResolved);
      applySemanticPoseToBones({
        bones: session.bones,
        rests: session.rests,
        pose: activePoseRef.current,
        canonicalPoseBases: previewRig.canonicalPoseBases,
      });
      updateSkinnedMeshes(session.root);
      if (previewView === 'perspective') {
        session.root.rotation.y = perspectiveYaw;
      } else {
        session.root.rotation.y = 0;
      }
      session.root.updateMatrixWorld(true);
      try {
        const pass = selectionPassRef.current;
        if (pass) {
          updateRegionSelectionPassFromSkinnedRoot(pass, session.root, session.meshBindings);
        }
      } catch {
        invalidateRegionSelectionPick(selectionPassRef.current);
      }
      renderMeshLayer();
      setUpdatingDeformation(false);
      pendingPoseRestoreRef.current = false;
    } catch (error) {
      setCorrectionResult({
        status: 'failed',
        message: error instanceof Error
          ? error.message
          : 'The correction could not be applied. Your previous rig has been kept.',
      });
      setUpdatingDeformation(false);
    }
  }, [
    meshData,
    meshBounds,
    previewFitted.jointPositions,
    height,
    previewRig.canonicalPoseBases,
    previewView,
    perspectiveYaw,
    renderMeshLayer,
  ]);
  rebindAfterEditRef.current = rebindPreviewAfterRegionEdit;

  const applyActivePoseToPreview = useCallback((preview = deformationPreview) => {
    if (!preview) return;
    applySemanticPoseToBones({
      bones: preview.bones,
      rests: preview.rests,
      pose: activePoseRef.current,
      canonicalPoseBases: previewRig.canonicalPoseBases,
    });
    updateSkinnedMeshes(preview.root);
    if (previewView === 'perspective') {
      preview.root.rotation.y = perspectiveYaw;
    } else {
      preview.root.rotation.y = 0;
    }
    preview.root.updateMatrixWorld(true);
  }, [deformationPreview, previewRig.canonicalPoseBases, previewView, perspectiveYaw]);

  const refreshSelectionPassFromPose = useCallback(() => {
    const pass = selectionPassRef.current;
    const preview = deformationPreview;
    if (!pass || !preview) return;
    try {
      updateRegionSelectionPassFromSkinnedRoot(pass, preview.root, preview.meshBindings);
    } catch {
      invalidateRegionSelectionPick(pass);
    }
  }, [deformationPreview]);

  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !open) return;
    if (step === 'pose-fix' && deformationPreview) {
      applyActivePoseToPreview(deformationPreview);
      setAutorigMarkerPreviewRoot(gl, deformationPreview.root);

      // Show assignments overlay on the skinned preview when requested.
      regionColorDisposerRef.current?.();
      regionColorDisposerRef.current = null;
      if (showAssignments && resolvedRegions) {
        regionColorDisposerRef.current = applyRegionColorsToPreviewRoot({
          root: deformationPreview.root,
          labels: resolvedRegions,
          confidence: regionConfidence,
        });
      }

      renderMeshLayer();
      refreshSelectionPassFromPose();
      if (pendingPoseRestoreRef.current) {
        pendingPoseRestoreRef.current = false;
        setUpdatingDeformation(false);
      }
    } else if (meshSource) {
      regionColorDisposerRef.current?.();
      regionColorDisposerRef.current = null;
      setAutorigMarkerPreviewRoot(gl, meshSource);
      renderMeshLayer();
    }
  }, [
    open,
    step,
    deformationPreview,
    meshSource,
    renderMeshLayer,
    applyActivePoseToPreview,
    showAssignments,
    resolvedRegions,
    regionConfidence,
    refreshSelectionPassFromPose,
    sessionVersion,
  ]);

  // Selection pass lifecycle for Pose & Fix (posed picking).
  useEffect(() => {
    if (!open || step !== 'pose-fix' || !topology) {
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

  const runPoseDiagnostics = useCallback((poseId: string, pose: HumanPose | undefined) => {
    if (!deformationPreview || !meshData) return;
    const posed: number[] = [];
    deformationPreview.root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const position = mesh.geometry.getAttribute('position');
      const point = new THREE.Vector3();
      for (let i = 0; i < position.count; i += 1) {
        mesh.getVertexPosition(i, point);
        point.applyMatrix4(mesh.matrixWorld);
        posed.push(point.x, point.y, point.z);
      }
    });
    const nextIssues = poseId === 'neutral' || !pose
      ? validateNeutralDeformation({
        restPositions: meshData.positions,
        posedPositions: posed,
      })
      : analyzeDiagnosticPose({
        restPositions: meshData.positions,
        posedPositions: posed,
        regionLabels: resolvedRegions,
        topology,
        jointPositions: previewFitted.jointPositions,
        heightMeters: height,
        buffers: previewBuffers,
      });
    setPoseIssues(nextIssues);
  }, [
    deformationPreview,
    meshData,
    resolvedRegions,
    topology,
    previewFitted.jointPositions,
    height,
    previewBuffers,
  ]);

  const previewTestPose = (poseId: string, pose: HumanPose | undefined) => {
    if (!deformationPreview || !meshData) return;
    activePoseRef.current = pose;
    applyActivePoseToPreview(deformationPreview);
    renderMeshLayer();
    refreshSelectionPassFromPose();
    setActiveTestPose(poseId);
    setDirty(true);
    runPoseDiagnostics(poseId, pose);
  };

  // Re-apply yaw / diagnostics when perspective yaw changes.
  useEffect(() => {
    if (step !== 'pose-fix' || !deformationPreview) return;
    applyActivePoseToPreview(deformationPreview);
    renderMeshLayer();
    refreshSelectionPassFromPose();
  }, [perspectiveYaw, step, deformationPreview, applyActivePoseToPreview, renderMeshLayer, refreshSelectionPassFromPose]);

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
        version: 2,
        step,
        mode: poseFixMode,
        markersJson: JSON.stringify(safeMarkers),
        topologyHash: topology?.topologyHash,
        suggestedB64: suggestedRegions ? encodeRegionDraftBytes(suggestedRegions) : undefined,
        overridesB64: regionOverrides ? encodeRegionDraftBytes(regionOverrides) : undefined,
        previewPoseId: activeTestPose,
        selectedRegion,
        brushRadius: paint.brushRadius,
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
    poseFixMode,
    safeMarkers,
    topology?.topologyHash,
    suggestedRegions,
    regionOverrides,
    activeTestPose,
    selectedRegion,
    paint.brushRadius,
  ]);

  // Brush size shortcuts while Fix mode is active.
  useEffect(() => {
    if (!open || step !== 'pose-fix' || !fixEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '[') {
        event.preventDefault();
        paint.nudgeBrushRadius(-4);
      } else if (event.key === ']') {
        event.preventDefault();
        paint.nudgeBrushRadius(4);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, step, fixEnabled, paint]);

  const hitTest = (x: number, y: number): HumanJointId | undefined => {
    for (const jointId of REQUIRED_JOINTS) {
      const marker = safeMarkers.find((item) => item.jointId === jointId);
      if (!marker) continue;
      const point = worldToCanvas(marker.position, frame);
      if (Math.hypot(point.x - x, point.y - y) <= 12) return jointId;
    }
    return undefined;
  };

  const projectCanonicalVertex = useCallback((vertexIndex: number) => {
    const pass = selectionPassRef.current;
    const positions = pass?.posedCanonicalPositions ?? topology?.positions;
    if (!positions) return null;
    const i = vertexIndex * 3;
    if (i + 2 >= positions.length) return null;
    const position: Vec3 = [positions[i]!, positions[i + 1]!, positions[i + 2]!];
    return worldToCanvas(position, frame);
  }, [topology, frame]);

  const flashSelectionTint = useCallback((vertexIndices: ArrayLike<number>, region: AutorigBodyRegionId | 'automatic') => {
    if (!deformationPreview || !resolvedRegions) return;
    const tinted = new Uint8Array(resolvedRegions);
    const code = region === 'automatic'
      ? 0
      : ({
        head: 1, torso: 2, leftArm: 3, rightArm: 4, leftLeg: 5, rightLeg: 6,
      } as const)[region];
    for (let i = 0; i < vertexIndices.length; i += 1) {
      const v = vertexIndices[i]! >>> 0;
      if (v < tinted.length && code > 0) tinted[v] = code;
    }
    if (!regionColorDisposerRef.current) {
      regionColorDisposerRef.current = applyRegionColorsToPreviewRoot({
        root: deformationPreview.root,
        labels: tinted,
        confidence: regionConfidence,
      });
    } else {
      updateRegionColorsOnPreviewRoot({
        root: deformationPreview.root,
        labels: tinted,
        confidence: regionConfidence,
      });
    }
    renderMeshLayer();
  }, [deformationPreview, resolvedRegions, regionConfidence, renderMeshLayer]);

  const finishBrushStroke = (points: BrushStrokePoint[]) => {
    if (!topology || !suggestedRegions || !regionOverrides || !resolvedRegions) {
      setCorrectionResult({ status: 'empty' });
      return;
    }
    if (points.length === 0) {
      setCorrectionResult({ status: 'empty' });
      return;
    }

    applyActivePoseToPreview();
    refreshSelectionPassFromPose();

    let visibleTriangleIds: Uint32Array | null = null;
    const pass = selectionPassRef.current;
    if (pass) {
      try {
        visibleTriangleIds = pickVisibleTrianglesAlongBrushStroke({
          pass,
          frame,
          stroke: points,
        });
      } catch {
        visibleTriangleIds = null;
      }
    }

    const correction = applyBrushRegionCorrection({
      topology,
      suggested: suggestedRegions,
      overrides: regionOverrides,
      resolved: resolvedRegions,
      region: selectedRegion,
      stroke: points,
      projectVertex: projectCanonicalVertex,
      visibleTriangleIds,
      restoreAutomatic,
      jointPositions: previewFitted.jointPositions,
      posedPositions: pass?.posedCanonicalPositions ?? null,
      reach: 'normal',
    });

    setCorrectionResult(correction.result);
    setPrepareNotice(null);
    if (correction.result.status === 'empty' || correction.result.status === 'unchanged') {
      return;
    }
    if (correction.result.status === 'changed') {
      flashSelectionTint(
        correction.affectedVertices,
        restoreAutomatic ? 'automatic' : selectedRegion,
      );
      commitRegionOverrides(correction.overrides);
    }
  };

  const finishLasso = () => {
    const points = lassoPointsRef.current;
    setLassoDrawing(false);
    setLassoPoints([]);
    lassoPointsRef.current = [];
    if (!topology || !suggestedRegions || !regionOverrides || !resolvedRegions) {
      setCorrectionResult({ status: 'empty' });
      return;
    }
    if (points.length < 3) {
      setCorrectionResult({ status: 'empty' });
      return;
    }

    applyActivePoseToPreview();
    refreshSelectionPassFromPose();

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

    if (restoreAutomatic) {
      const correction = applyBrushRegionCorrection({
        topology,
        suggested: suggestedRegions,
        overrides: regionOverrides,
        resolved: resolvedRegions,
        region: selectedRegion,
        stroke: points.map((p) => ({ x: p.x, y: p.y, radius: 2 })),
        projectVertex: projectCanonicalVertex,
        visibleTriangleIds,
        restoreAutomatic: true,
        jointPositions: previewFitted.jointPositions,
        posedPositions: pass?.posedCanonicalPositions ?? null,
        reach: 'normal',
      });
      setCorrectionResult(correction.result);
      setPrepareNotice(null);
      if (correction.result.status === 'changed') {
        flashSelectionTint(correction.affectedVertices, 'automatic');
        commitRegionOverrides(correction.overrides);
      }
      return;
    }

    const previousOverrides = regionOverrides;
    const result = applyLassoRegionCorrection({
      topology,
      suggested: suggestedRegions,
      overrides: regionOverrides,
      resolved: resolvedRegions,
      region: selectedRegion,
      polygon: points,
      projectVertex: projectCanonicalVertex,
      visibleTriangleIds,
    });

    if (result.affectedVertices.length === 0) {
      setCorrectionResult({ status: 'empty' });
      return;
    }

    const nextResolved = resolveRegionLabels({
      suggested: suggestedRegions,
      overrides: result.overrides,
    });
    let changed = 0;
    for (let v = 0; v < nextResolved.length; v += 1) {
      if (nextResolved[v] !== resolvedRegions[v] || result.overrides[v] !== previousOverrides[v]) {
        changed += 1;
      }
    }
    if (changed === 0) {
      setCorrectionResult({ status: 'unchanged', region: selectedRegion });
      return;
    }

    setCorrectionResult({
      status: 'changed',
      affectedVertexCount: changed,
      oldRegions: [],
      newRegion: selectedRegion,
    });
    setPrepareNotice(null);
    flashSelectionTint(result.affectedVertices, selectedRegion);
    commitRegionOverrides(result.overrides);
  };

  const canContinueJoints = !issues.some((issue) => issue.code === 'missing');
  const hasBlockingPoseIssues = poseIssues.some((issue) => issue.severity === 'blocking');
  const canApply = canContinueJoints && Boolean(previewBuffers) && !preparing && !hasBlockingPoseIssues;

  const handleContinueToPoseFix = () => {
    setPoseIssues([]);
    setCorrectionResult(null);
    setPrepareNotice(null);
    setPreparing(true);
    setActiveTestPose('neutral');
    activePoseRef.current = undefined;
    // Marker edits invalidate automatic regions — force a fresh label pass.
    const ok = ensureRegionsReady({ forceRelabel: true });
    setPreparing(false);
    setStep('pose-fix');
    if (!ok) {
      setCorrectionResult({
        status: 'failed',
        message: 'Could not prepare pose preview.',
      });
    }
  };

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

  const handleOrbitPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (previewView !== 'perspective') return false;
    if (event.button === 2 || event.button === 1) {
      orbitRef.current = { pointerId: event.pointerId, lastX: event.clientX };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return true;
    }
    return false;
  };

  const handleOrbitPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!orbitRef.current || orbitRef.current.pointerId !== event.pointerId) return false;
    const dx = event.clientX - orbitRef.current.lastX;
    orbitRef.current.lastX = event.clientX;
    setPerspectiveYaw((yaw) => yaw + dx * 0.01);
    return true;
  };

  const handleOrbitPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!orbitRef.current || orbitRef.current.pointerId !== event.pointerId) return;
    orbitRef.current = null;
  };

  const showFixOverlay = step === 'pose-fix' && fixEnabled && Boolean(deformationPreview);

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
            {showFixOverlay && fixTool === 'brush' && (
              <AutorigBrushOverlay
                width={CANVAS_W}
                height={CANVAS_H}
                stroke={paint.stroke}
                drawing={paint.drawing}
                cursor={paint.cursor}
                radius={paint.brushRadius}
                region={selectedRegion}
                restoreAutomatic={restoreAutomatic}
                className="relative h-full w-full rounded-xl bg-transparent"
                onPointerDown={(event) => {
                  if (handleOrbitPointerDown(event)) return;
                  if (event.button !== 0) return;
                  const point = eventToCanvasPoint(event);
                  paint.beginStroke(point.x, point.y);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (handleOrbitPointerMove(event)) return;
                  const point = eventToCanvasPoint(event);
                  paint.setCursor({ x: point.x, y: point.y });
                  if (!paint.drawing) return;
                  paint.extendStroke(point.x, point.y);
                }}
                onPointerUp={(event) => {
                  handleOrbitPointerUp(event);
                  if (!paint.drawing) return;
                  const points = paint.endStroke();
                  finishBrushStroke(points);
                }}
                onPointerCancel={() => {
                  orbitRef.current = null;
                  paint.cancelStroke();
                }}
                onWheel={(event) => {
                  event.preventDefault();
                  paint.nudgeBrushRadius(event.deltaY > 0 ? -3 : 3);
                }}
              />
            )}
            {showFixOverlay && fixTool === 'lasso' && (
              <AutorigLassoOverlay
                width={CANVAS_W}
                height={CANVAS_H}
                points={lassoPoints}
                drawing={lassoDrawing}
                className="relative h-full w-full cursor-crosshair rounded-xl bg-transparent"
                onPointerDown={(event) => {
                  if (handleOrbitPointerDown(event)) return;
                  if (event.button !== 0) return;
                  const point = eventToCanvasPoint(event);
                  lassoPointsRef.current = [point];
                  setLassoPoints([point]);
                  setLassoDrawing(true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (handleOrbitPointerMove(event)) return;
                  if (!lassoDrawing) return;
                  const point = eventToCanvasPoint(event);
                  lassoPointsRef.current = [...lassoPointsRef.current, point];
                  setLassoPoints(lassoPointsRef.current);
                }}
                onPointerUp={(event) => {
                  handleOrbitPointerUp(event);
                  if (!lassoDrawing) return;
                  finishLasso();
                }}
                onPointerCancel={() => {
                  orbitRef.current = null;
                  setLassoDrawing(false);
                  setLassoPoints([]);
                  lassoPointsRef.current = [];
                }}
              />
            )}
            {step === 'pose-fix' && !showFixOverlay && (
              <div
                className="relative h-full w-full rounded-xl"
                style={{ width: CANVAS_W, height: CANVAS_H }}
                data-autorig-pose-inspect-layer
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  if (previewView !== 'perspective') return;
                  if (event.button === 2 || event.button === 1) {
                    orbitRef.current = { pointerId: event.pointerId, lastX: event.clientX };
                    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
                    event.preventDefault();
                  }
                }}
                onPointerMove={(event) => {
                  if (!orbitRef.current || orbitRef.current.pointerId !== event.pointerId) return;
                  const dx = event.clientX - orbitRef.current.lastX;
                  orbitRef.current.lastX = event.clientX;
                  setPerspectiveYaw((yaw) => yaw + dx * 0.01);
                }}
                onPointerUp={() => {
                  orbitRef.current = null;
                }}
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
            {step === 'pose-fix' && (
              <AutorigPoseFixStep
                view={previewView}
                onViewChange={(view) => {
                  setPreviewView(view);
                  if (view !== 'perspective') setPerspectiveYaw(0);
                }}
                meshReady={meshReady}
                preparing={preparing || (!previewBuffers && meshReady)}
                updating={updatingDeformation}
                activeTestPose={activeTestPose}
                onSelectPose={previewTestPose}
                fixEnabled={fixEnabled}
                onFixEnabledChange={(value) => {
                  setFixEnabled(value);
                  setCorrectionResult(null);
                  if (!value) {
                    paint.cancelStroke();
                    setLassoDrawing(false);
                    setLassoPoints([]);
                  }
                }}
                tool={fixTool}
                onToolChange={setFixTool}
                selectedRegion={selectedRegion}
                onSelectRegion={setSelectedRegion}
                restoreAutomatic={restoreAutomatic}
                onRestoreAutomaticChange={setRestoreAutomatic}
                brushRadius={paint.brushRadius}
                onBrushRadiusChange={paint.setBrushRadius}
                showAssignments={showAssignments}
                onShowAssignmentsChange={setShowAssignments}
                canUndo={regionPast.length > 0}
                canRedo={regionFuture.length > 0}
                onUndo={undoRegions}
                onRedo={redoRegions}
                correctionResult={correctionResult}
                prepareNotice={prepareNotice}
                onAdjustJoint={() => {
                  setFixEnabled(false);
                  setStep('joints');
                }}
                warnings={previewBuffers?.warnings}
                fallbackCount={previewBuffers?.fallbackVertexCount}
                issues={poseIssues}
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap justify-between gap-2 border-t border-subtle pt-3">
          <div className="flex flex-wrap gap-2">
            {step === 'pose-fix' && (
              <button
                type="button"
                className="rounded-xl border border-subtle px-3 py-2 text-sm font-semibold text-secondary"
                data-autorig-adjust-joints
                onClick={() => {
                  setPoseIssues([]);
                  setFixEnabled(false);
                  setStep('joints');
                }}
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
                onClick={handleContinueToPoseFix}
              >
                Continue
              </button>
            )}
            {step === 'pose-fix' && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                data-autorig-apply-skeleton
                disabled={!canApply}
                onClick={handleApply}
              >
                <CheckCircle2 className="h-4 w-4" />
                Apply rig
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
