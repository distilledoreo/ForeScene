import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Box,
  Circle,
  ClipboardPaste,
  Columns3,
  Copy,
  DoorOpen,
  Eye,
  EyeOff,
  FileDown,
  Globe,
  Grid3X3,
  Layers,
  Navigation,
  Lock,
  Scissors,
  Mountain,
  Move3D,
  Redo2,
  RotateCcw,
  RotateCw,
  Ruler,
  Square,
  SquareStack,
  Sun,
  Trash2,
  TreeDeciduous,
  Undo2,
  Unlock,
  Upload,
  User,
  Wrench,
  ZoomIn,
  ZoomOut,
  Sparkles,
} from 'lucide-react';
import { Euler, ObjectSurfaceStyle, SceneObject, SceneObjectType, StagingRole, Vec3, type HumanJointId } from '../../domain/types';
import type { GizmoMode } from '../../engine/transformGizmo';
import { defaultShotDepthSettings } from '../../domain/defaults';
import { isPoseableSceneObject } from '../../engine/humanPose';
import { AppearanceModeToggle } from '../common/AppearanceModeToggle';
import { CharacterPosePanel } from '../common/CharacterPosePanel';
import { DepthSettingsPanel } from '../common/DepthSettingsPanel';
import { objectDisplayName } from '../../domain/defaults';
import { getLatestGrayboxPano, getPanoAsset, listGrayboxPanos } from '../../domain/selectors';
import {
  countStyledPanoramas,
  originMoveWarningMessage,
  resolveStyledImportMode,
  shouldWarnOnOriginMove,
} from '../../engine/panoProjectionCore';
import {
  CLICK_ONLY_BUILD_PRIMITIVES,
  HOTKEYED_BUILD_PRIMITIVES,
  getPrimitiveShortcutLabel,
  resolveBuildShortcut,
} from '../../engine/buildShortcuts';
import {
  createBuildClipboardPayload,
  parseBuildClipboard,
  serializeBuildClipboard,
} from '../../engine/buildClipboard';
import { BUILD_GRID_SIZE } from '../../engine/sandbox';
import {
  clampBuildRenderDistance,
  DEFAULT_BUILD_RENDER_DISTANCE,
  MAX_BUILD_RENDER_DISTANCE,
  MIN_BUILD_RENDER_DISTANCE,
} from '../../engine/viewport';
import { downloadPanoImage } from '../../engine/panoImage';
import { downloadDataUrl } from '../../engine/fileTransfers';
import { canUseProjectedAppearance } from '../../engine/projectedStyle';
import {
  CHECKERBOARD_TILE_METERS,
  defaultSecondaryColor,
  defaultSolidColorForObject,
  resolveSurfaceStyle,
} from '../../engine/sceneObjects';
import { getSceneObjectStagingRole } from '../../engine/shotSceneState';
import { resolveWorkspacePrimaryAction } from '../../engine/workflow';
import { BuildMode, useContinuityStore } from '../../state/useContinuityStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useThemeStore } from '../../state/useThemeStore';
import { ContextualPanel } from '../common/ContextualPanel';
import { Field, Select, TextInput } from '../common/Field';
import { ModelImportDialog } from '../common/ModelImportDialog';
import { PoseableCharacterImportDialog } from '../common/PoseableCharacterImportDialog';
import { AutorigMarkerWizardDialog } from '../common/AutorigMarkerWizardDialog';
import { SetGenerationDialog } from '../common/SetGenerationDialog';
import {
  generateSkinWeightsForRigAsset,
  hydrateAutoriggedCharactersFromAssets,
} from '../../engine/autoriggedPoseableCharacter';
import type { CompiledSetBlueprint } from '../../engine/setBlueprintCompiler';
import { PrecisionDrawer } from '../common/PrecisionDrawer';
import { PrimaryCTA } from '../common/PrimaryCTA';
import { Vec3Input } from '../common/Vec3Input';
import { SceneViewport } from '../viewers/SceneViewport';
import { FullBleedLayout } from './WorkspaceShell';

const primitiveTypes: SceneObjectType[] = [
  ...HOTKEYED_BUILD_PRIMITIVES,
  ...CLICK_ONLY_BUILD_PRIMITIVES,
];

const trayItems: Array<{ type: SceneObjectType; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { type: 'box', label: 'Box', icon: Box },
  { type: 'floor', label: 'Floor', icon: Square },
  { type: 'wall', label: 'Wall', icon: Layers },
  { type: 'doorway', label: 'Doorway', icon: DoorOpen },
  { type: 'tree_blob', label: 'Tree', icon: TreeDeciduous },
  { type: 'column', label: 'Column', icon: Circle },
  { type: 'stairs', label: 'Stairs', icon: SquareStack },
  { type: 'sun_marker', label: 'Sun', icon: Sun },
  { type: 'arch', label: 'Arch', icon: DoorOpen },
  { type: 'terrain_mass', label: 'Terrain', icon: Mountain },
  { type: 'background_card', label: 'Backdrop', icon: Columns3 },
  { type: 'human_dummy', label: 'Person', icon: User },
];
const primaryTrayItems = trayItems.slice(0, 8);
const overflowTrayItems = trayItems.slice(8);

export function BuildWorkspace({
  onCreateProjectFromBlueprint,
}: {
  onCreateProjectFromBlueprint?: (compiled: CompiledSetBlueprint) => Promise<void>;
} = {}) {
  const [precisionOpen, setPrecisionOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [showSceneGuides, setShowSceneGuides] = useState(false);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [characterEditMode, setCharacterEditMode] = useState<'move' | 'pose'>('move');
  const [selectedPoseJointId, setSelectedPoseJointId] = useState<HumanJointId | undefined>();
  const [grayboxRenderError, setGrayboxRenderError] = useState<string | undefined>();
  const [isRenderingProjected, setIsRenderingProjected] = useState(false);
  const [projectedRenderError, setProjectedRenderError] = useState<string | undefined>();
  const [clipboardStatus, setClipboardStatus] = useState<string | undefined>();
  const theme = useThemeStore((state) => state.theme);
  const runDestructiveProjectMutation = useProjectSafetyStore((state) => state.runDestructiveProjectMutation);
  const [systemClipboardSyncedAt, setSystemClipboardSyncedAt] = useState<string | undefined>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [modelImportOpen, setModelImportOpen] = useState(false);
  const [poseableImportOpen, setPoseableImportOpen] = useState(false);
  const [autorigMarkerOpen, setAutorigMarkerOpen] = useState(false);
  const [setGenerationOpen, setSetGenerationOpen] = useState(false);
  const [frameRequest, setFrameRequest] = useState(0);
  const [frameObjectIds, setFrameObjectIds] = useState<string[]>([]);
  const [freeCameraActive, setFreeCameraActive] = useState(false);
  const [appearance, setAppearance] = useState<'clay' | 'projected' | 'depth'>('clay');
  const [depthSettings, setDepthSettings] = useState(() => ({ ...defaultShotDepthSettings }));
  const [depthPreviewRange, setDepthPreviewRange] = useState<{ nearMeters: number; farMeters: number }>({
    nearMeters: 0.1,
    farMeters: 100,
  });
  const [renderDistanceOpen, setRenderDistanceOpen] = useState(false);
  const [renderDistance, setRenderDistance] = useState(DEFAULT_BUILD_RENDER_DISTANCE);
  const {
    project,
    selectedObjectIds,
    buildClipboard,
    buildMode,
    activePrimitive,
    gridSnap,
    setBuildMode,
    setActivePrimitive,
    setGridSnap,
    placeObject,
    selectObject,
    selectObjectRange,
    selectAllObjects,
    clearObjectSelection,
    setBuildClipboard,
    updateObject,
    updatePoseableRigAsset,
    moveObjectToGroundPoint,
    duplicateSelectedObjects,
    pasteBuildObjects,
    removeSelectedObjects,
    nudgeSelectedObjects,
    translateSelectedObjectsBy,
    rotateSelectedObjectsBy,
    scaleSelectedObjectsBy,
    toggleSelectedVisibility,
    toggleSelectedLocked,
    showAllObjects,
    setPanoOrigin,
    setPanoRotation,
    renderGrayboxPano,
    isRenderingGraybox,
    beginBuildHistoryBatch,
    endBuildHistoryBatch,
    undoBuild,
    redoBuild,
    buildHistoryPast,
    buildHistoryFuture,
    pendingSecondCapturePlan,
  } = useContinuityStore(useShallow((state) => ({
    project: state.project,
    selectedObjectIds: state.selectedObjectIds,
    buildClipboard: state.buildClipboard,
    buildMode: state.buildMode,
    activePrimitive: state.activePrimitive,
    gridSnap: state.gridSnap,
    setBuildMode: state.setBuildMode,
    setActivePrimitive: state.setActivePrimitive,
    setGridSnap: state.setGridSnap,
    placeObject: state.placeObject,
    selectObject: state.selectObject,
    selectObjectRange: state.selectObjectRange,
    selectAllObjects: state.selectAllObjects,
    clearObjectSelection: state.clearObjectSelection,
    setBuildClipboard: state.setBuildClipboard,
    updateObject: state.updateObject,
    updatePoseableRigAsset: state.updatePoseableRigAsset,
    moveObjectToGroundPoint: state.moveObjectToGroundPoint,
    duplicateSelectedObjects: state.duplicateSelectedObjects,
    pasteBuildObjects: state.pasteBuildObjects,
    removeSelectedObjects: state.removeSelectedObjects,
    nudgeSelectedObjects: state.nudgeSelectedObjects,
    translateSelectedObjectsBy: state.translateSelectedObjectsBy,
    rotateSelectedObjectsBy: state.rotateSelectedObjectsBy,
    scaleSelectedObjectsBy: state.scaleSelectedObjectsBy,
    toggleSelectedVisibility: state.toggleSelectedVisibility,
    toggleSelectedLocked: state.toggleSelectedLocked,
    showAllObjects: state.showAllObjects,
    setPanoOrigin: state.setPanoOrigin,
    setPanoRotation: state.setPanoRotation,
    renderGrayboxPano: state.renderGrayboxPano,
    isRenderingGraybox: state.isRenderingGraybox,
    beginBuildHistoryBatch: state.beginBuildHistoryBatch,
    endBuildHistoryBatch: state.endBuildHistoryBatch,
    undoBuild: state.undoBuild,
    redoBuild: state.redoBuild,
    buildHistoryPast: state.buildHistoryPast,
    buildHistoryFuture: state.buildHistoryFuture,
    pendingSecondCapturePlan: state.pendingSecondCapturePlan,
  })));
  const canUndo = buildHistoryPast.length > 0;
  const canRedo = buildHistoryFuture.length > 0;

  /**
   * Warning acknowledgment scoped to current project + styled pano IDs.
   * Resets when project changes or styled pano set changes.
   */
  const originWarningScopeKey = useMemo(() => {
    const styledPanoIds = project.panoRefs
      .filter((p) => p.type !== 'graybox_render')
      .map((p) => p.id)
      .sort();
    if (styledPanoIds.length === 0) return '';
    return `${project.id}:${styledPanoIds.join(',')}`;
  }, [project.id, project.panoRefs]);
  const [acknowledgedScopeKey, setAcknowledgedScopeKey] = useState<string>();

  const handleRenderGraybox = useCallback(() => {
    if (isRenderingGraybox || isRenderingProjected) return;
    setGrayboxRenderError(undefined);
    void renderGrayboxPano().catch((error: unknown) => {
      setGrayboxRenderError(
        error instanceof Error ? error.message : 'Could not render graybox 360.',
      );
    });
  }, [isRenderingGraybox, isRenderingProjected, renderGrayboxPano]);

  const handleDownloadProjected360 = useCallback(() => {
    if (isRenderingGraybox || isRenderingProjected) return;
    if (!canUseProjectedAppearance(project)) return;
    setProjectedRenderError(undefined);
    setIsRenderingProjected(true);
    void (async () => {
      try {
        // Yield so the CTA can paint "Rendering..." before WebGL work blocks the main thread.
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        const { renderProjectedEquirectangularPano } = await import('../../engine/renderers');
        const render = await renderProjectedEquirectangularPano(project, undefined, undefined, theme);
        await downloadPanoImage(
          render.dataUrl,
          render.width,
          render.height,
          'projected_360.png',
          {
            letterboxEnabled: false,
            targetWidth: project.settings.defaultShotWidth,
            targetHeight: project.settings.defaultShotHeight,
          },
          downloadDataUrl,
        );
      } catch (error: unknown) {
        setProjectedRenderError(
          error instanceof Error ? error.message : 'Could not render projected 360.',
        );
      } finally {
        setIsRenderingProjected(false);
      }
    })();
  }, [isRenderingGraybox, isRenderingProjected, project, theme]);

  /**
   * Ask for user consent before editing the capture origin when styled panoramas exist.
   * Called by the viewport on pointer-down (before drag/history begin).
   * Acknowledgment is scoped to the current project + styled pano set so switching
   * projects or adding/removing styled panos re-enables the warning.
   */
  const requestOriginEditConsent = useCallback(() => {
    if (!shouldWarnOnOriginMove(project)) return true;
    if (!originWarningScopeKey) return true;
    if (acknowledgedScopeKey === originWarningScopeKey) return true;
    const ok = window.confirm(originMoveWarningMessage(countStyledPanoramas(project)));
    if (ok) setAcknowledgedScopeKey(originWarningScopeKey);
    return ok;
  }, [project, originWarningScopeKey, acknowledgedScopeKey]);

  const handleMovePanoOrigin = useCallback((origin: Vec3) => {
    setPanoOrigin(origin);
  }, [setPanoOrigin]);

  const handleRotatePanoOrigin = useCallback((rotation: Euler) => {
    // Projection currently consumes only rotation[1] (yaw) — preserve X and Z.
    setPanoRotation(rotation);
  }, [setPanoRotation]);
  const selectedObjects = project.scene.objects.filter((object) => selectedObjectIds.includes(object.id));
  const selectedObject = project.scene.objects.find((object) => object.id === selectedObjectIds.at(-1));
  const selectedIsPoseable = Boolean(
    selectedObject
    && selectedObjects.length === 1
    && isPoseableSceneObject(selectedObject),
  );
  const posingCharacter = selectedIsPoseable && characterEditMode === 'pose';
  const selectionHasLocked = selectedObjects.some((object) => object.locked);
  const selectionAllLocked = selectedObjects.length > 0 && selectedObjects.every((object) => object.locked);
  const selectionAllHidden = selectedObjects.length > 0 && selectedObjects.every((object) => !object.visible);
  const editingChromeVisible = !freeCameraActive && !renderDistanceOpen;
  const grayboxPano = getLatestGrayboxPano(project);
  const grayboxAsset = getPanoAsset(project, grayboxPano);
  const grayboxCount = listGrayboxPanos(project).length;
  const primaryAction = useMemo(
    () => resolveWorkspacePrimaryAction({ project, workspace: 'build', shotCameraFlying: false }),
    [project],
  );

  const rotateSelected = useCallback((degrees: number) => {
    rotateSelectedObjectsBy('y', degrees);
  }, [rotateSelectedObjectsBy]);

  const scaleSelected = useCallback((factor: number) => {
    scaleSelectedObjectsBy([factor, factor, factor]);
  }, [scaleSelectedObjectsBy]);

  const copySelection = useCallback(async () => {
    if (selectedObjects.length === 0) return undefined;
    const payload = createBuildClipboardPayload(project.id, selectedObjects, project.assets);
    setBuildClipboard(payload);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(serializeBuildClipboard(payload));
      setSystemClipboardSyncedAt(payload.copiedAt);
      setClipboardStatus(`Copied ${selectedObjects.length} object${selectedObjects.length === 1 ? '' : 's'}.`);
    } catch {
      setSystemClipboardSyncedAt(undefined);
      setClipboardStatus(`Copied ${selectedObjects.length} object${selectedObjects.length === 1 ? '' : 's'} in this app.`);
    }
    return payload;
  }, [project.id, selectedObjects, setBuildClipboard]);

  const cutSelection = useCallback(async () => {
    if (selectedObjects.length === 0) return;
    if (selectionHasLocked) {
      setClipboardStatus('Unlock the selected objects before cutting them.');
      return;
    }
    await copySelection();
    if (!runDestructiveProjectMutation) {
      setClipboardStatus('Local recovery is still starting. Please wait before cutting objects.');
      return;
    }
    let removed = false;
    try {
      await runDestructiveProjectMutation('Before deleting scene objects', () => {
        removed = removeSelectedObjects();
      });
      if (removed) setClipboardStatus(`Cut ${selectedObjects.length} object${selectedObjects.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setClipboardStatus(error instanceof Error ? error.message : 'Could not create a recovery point before cutting objects.');
    }
  }, [copySelection, removeSelectedObjects, runDestructiveProjectMutation, selectedObjects.length, selectionHasLocked]);

  const requestDeleteSelection = useCallback(async () => {
    if (selectedObjects.length === 0) return false;
    if (selectionHasLocked) {
      setClipboardStatus('Unlock the selection before deleting it.');
      return false;
    }
    const count = selectedObjects.length;
    const label = `${count} selected object${count === 1 ? '' : 's'}`;
    if (!window.confirm(`Delete ${label}? A local recovery point will be kept so this can be restored later.`)) return false;
    if (!runDestructiveProjectMutation) {
      setClipboardStatus('Local recovery is still starting. Please wait before deleting objects.');
      return false;
    }
    let removed = false;
    try {
      await runDestructiveProjectMutation('Before deleting scene objects', () => {
        removed = removeSelectedObjects();
      });
      if (!removed) return false;
      setClipboardStatus(`Deleted ${label}.`);
      return true;
    } catch (error) {
      setClipboardStatus(error instanceof Error ? error.message : 'Could not create a recovery point before deleting objects.');
      return false;
    }
  }, [removeSelectedObjects, runDestructiveProjectMutation, selectedObjects.length, selectionHasLocked]);

  const pasteSelection = useCallback(async (inPlace = false) => {
    let payload = buildClipboard;
    try {
      const text = await navigator.clipboard?.readText?.();
      const externalPayload = text ? parseBuildClipboard(text) : undefined;
      if (externalPayload) {
        payload = externalPayload;
      } else if (systemClipboardSyncedAt && systemClipboardSyncedAt === buildClipboard?.copiedAt) {
        setClipboardStatus('The system clipboard does not contain Continuity Stage objects.');
        return;
      }
    } catch {
      // Permission denial is expected in non-secure or restricted contexts; use the app clipboard.
    }
    if (!payload) {
      setClipboardStatus('No Continuity Stage objects are available to paste.');
      return;
    }
    const pasted = pasteBuildObjects(payload, { inPlace });
    setClipboardStatus(`Pasted ${pasted.length} object${pasted.length === 1 ? '' : 's'}${inPlace ? ' in place' : ''}.`);
  }, [buildClipboard, pasteBuildObjects, systemClipboardSyncedAt]);

  const requestFrame = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setFrameObjectIds(ids);
    setFrameRequest((request) => request + 1);
  }, []);

// Framing is a one-shot camera command, not an ongoing attachment to the
// selected objects. Clear the request after the viewport has consumed the
// committed render so later object edits cannot recenter the orbit target.
useEffect(() => {
  if (!frameRequest) return;
  const animationFrame = window.requestAnimationFrame(() => {
    setFrameRequest((current) => (current === frameRequest ? 0 : current));
  });
  return () => window.cancelAnimationFrame(animationFrame);
}, [frameRequest]);

  useEffect(() => {
    if (!clipboardStatus) return;
    const timeout = window.setTimeout(() => setClipboardStatus(undefined), 2600);
    return () => window.clearTimeout(timeout);
  }, [clipboardStatus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (freeCameraActive) return;
      const command = resolveBuildShortcut(event);
      if (!command) return;
      event.preventDefault();

      if (command.kind === 'undo') {
        undoBuild();
        return;
      }
      if (command.kind === 'redo') {
        redoBuild();
        return;
      }
      if (command.kind === 'primitive') {
        blurActiveElement();
        setActivePrimitive(command.type);
        return;
      }
      if (command.kind === 'mode') {
        if (event.key === 'Escape' && buildMode === 'select') clearObjectSelection();
        else setBuildMode(command.mode === 'pano_origin' && buildMode !== 'pano_origin' ? 'pano_origin' : 'select');
        return;
      }
      if (command.kind === 'copy') {
        void copySelection();
        return;
      }
      if (command.kind === 'cut') {
        void cutSelection();
        return;
      }
      if (command.kind === 'paste') {
        void pasteSelection(command.inPlace);
        return;
      }
      if (command.kind === 'select-all') {
        selectAllObjects();
        setBuildMode('select');
        return;
      }
      if (command.kind === 'clear-selection') {
        clearObjectSelection();
        return;
      }
      if (command.kind === 'nudge') {
        const amount = (gridSnap ? BUILD_GRID_SIZE : 0.1) * command.direction * command.multiplier;
        const delta: Vec3 = command.axis === 'x' ? [amount, 0, 0]
          : command.axis === 'y' ? [0, amount, 0] : [0, 0, amount];
        if (!nudgeSelectedObjects(delta) && selectionHasLocked) {
          setClipboardStatus('Unlock the selection before moving it.');
        }
        return;
      }
      if (command.kind === 'frame-selection') {
        requestFrame(selectedObjectIds);
        return;
      }
      if (command.kind === 'frame-all') {
        requestFrame(project.scene.objects.filter((object) => object.visible).map((object) => object.id));
        return;
      }
      if (command.kind === 'show-all') {
        showAllObjects();
        return;
      }
      if (command.kind === 'rename') {
        if (selectedObjectIds.length === 1) {
          document.querySelector<HTMLInputElement>('[aria-label="Selected object name"]')?.focus();
        }
        return;
      }
      if (command.kind === 'toggle-help') {
        setShortcutsOpen((open) => !open);
        return;
      }
      if (command.kind === 'toggle-snap') {
        setGridSnap(!gridSnap);
        return;
      }
      if (command.kind === 'gizmo-translate') {
        setGizmoMode('translate');
        return;
      }
      if (command.kind === 'gizmo-rotate') {
        setGizmoMode('rotate');
        return;
      }
      if (command.kind === 'gizmo-scale') {
        setGizmoMode('scale');
        return;
      }

      if (!selectedObject) return;
      if (command.kind === 'duplicate') duplicateSelectedObjects();
      if (command.kind === 'rotate-left') rotateSelected(-15);
      if (command.kind === 'rotate-right') rotateSelected(15);
      if (command.kind === 'scale-down') scaleSelected(0.9);
      if (command.kind === 'scale-up') scaleSelected(1.1);
      if (command.kind === 'toggle-lock') toggleSelectedLocked();
      if (command.kind === 'toggle-visibility') toggleSelectedVisibility();
      if (command.kind === 'toggle-precision') setPrecisionOpen((open) => !open);
      if (command.kind === 'delete') requestDeleteSelection();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    buildMode,
    clearObjectSelection,
    copySelection,
    cutSelection,
    duplicateSelectedObjects,
    gridSnap,
    nudgeSelectedObjects,
    pasteSelection,
    project.scene.objects,
    redoBuild,
    requestDeleteSelection,
    requestFrame,
    rotateSelected,
    scaleSelected,
    selectAllObjects,
    selectedObject,
    selectedObjectIds,
    selectionHasLocked,
    setActivePrimitive,
    setBuildMode,
    setGridSnap,
    showAllObjects,
    toggleSelectedLocked,
    toggleSelectedVisibility,
    undoBuild,
    freeCameraActive,
  ]);

  useEffect(() => {
    if (selectedObjects.length !== 1) setPrecisionOpen(false);
    if (selectedObjects.length === 0) setLayersOpen(false);
  }, [selectedObjects.length]);

  return (
    <FullBleedLayout>
      <div className="relative h-full min-h-0">
        <SceneViewport
          project={project}
          selectedObjectIds={selectedObjectIds}
          placementType={buildMode === 'place' ? activePrimitive : undefined}
          placementLabel={primitiveLabel(activePrimitive)}
          originPlacementActive={buildMode === 'pano_origin'}
          freeCameraActive={freeCameraActive}
          appearance={appearance}
          depthSettings={depthSettings}
          onDepthRangeChange={setDepthPreviewRange}
          renderDistance={renderDistance}
          onFreeCameraActiveChange={setFreeCameraActive}
          showSceneGuides={showSceneGuides}
          showTransformGizmo={Boolean(
            editingChromeVisible && !posingCharacter && (
              (selectedObject && buildMode === 'select' && !selectionHasLocked)
              || buildMode === 'pano_origin'
            ),
          )}
          poseEditActive={Boolean(editingChromeVisible && posingCharacter)}
          selectedPoseJointId={selectedPoseJointId}
          onSelectPoseJoint={setSelectedPoseJointId}
          gizmoMode={buildMode === 'pano_origin' && gizmoMode === 'scale' ? 'translate' : gizmoMode}
          snapToGrid={gridSnap}
          onSelectObject={selectObject}
          onPlaceObject={placeObject}
          onMoveObject={moveObjectToGroundPoint}
          onMoveObjectInSpace={(_id, position) => {
            if (!selectedObject) return;
            translateSelectedObjectsBy([
              position[0] - selectedObject.transform.position[0],
              position[1] - selectedObject.transform.position[1],
              position[2] - selectedObject.transform.position[2],
            ], { history: 'batch' });
          }}
          onRotateObject={(id, rotation) => {
            const object = project.scene.objects.find((item) => item.id === id);
            if (!object) return;
            const deltas = rotation.map((value, index) => signedDegreeDelta(object.transform.rotation[index], value)) as Vec3;
            const axisIndex = deltas.reduce((best, value, index) => Math.abs(value) > Math.abs(deltas[best]) ? index : best, 0);
            const axis = axisIndex === 0 ? 'x' : axisIndex === 1 ? 'y' : 'z';
            rotateSelectedObjectsBy(axis, deltas[axisIndex], { history: 'batch' });
          }}
          onScaleObject={(id, dimensions) => {
            const object = project.scene.objects.find((item) => item.id === id);
            if (!object) return;
            scaleSelectedObjectsBy(dimensions.map((value, index) => (
              value / Math.max(object.dimensions[index], 0.0001)
            )) as Vec3, { history: 'batch' });
          }}
          onMovePanoOrigin={handleMovePanoOrigin}
          onRotatePanoOrigin={handleRotatePanoOrigin}
          onRequestPanoOriginEdit={requestOriginEditConsent}
          onEditBatchStart={beginBuildHistoryBatch}
          onEditBatchEnd={endBuildHistoryBatch}
          frameRequest={frameRequest}
          frameObjectIds={frameObjectIds}
        />

        <div
          className="pointer-events-none absolute left-5 z-20"
          style={{ top: 'calc(var(--stage-header-safe) + 0.35rem)' }}
          data-build-free-camera-control
        >
          <div className="relative">
            <div className="pointer-events-auto flex items-center overflow-hidden rounded-2xl border border-subtle/80 bg-surface-overlay/80 shadow-card backdrop-blur-sm">
              <button
                type="button"
                title={freeCameraActive ? 'Exit free camera (Esc)' : 'Free camera: drag to look, then use WASD to move'}
                aria-label={freeCameraActive ? 'Exit free camera' : 'Enable free camera'}
                aria-pressed={freeCameraActive}
                data-build-free-camera-toggle
                onClick={() => setFreeCameraActive((active) => !active)}
                className={`inline-flex h-11 items-center gap-2 border-0 px-3 text-xs font-medium transition ${
                  freeCameraActive
                    ? 'bg-accent-soft text-accent'
                    : 'bg-transparent text-secondary hover:bg-surface-muted/80 hover:text-primary'
                }`}
                >
                  <Navigation className="h-4 w-4" />
                  <span className="hidden sm:inline">Free camera</span>
                </button>
              <span className="h-4 w-px shrink-0 self-center bg-border-subtle/70" aria-hidden />
              <button
                type="button"
                title="Adjust Build visibility distance"
                aria-label="Adjust visibility distance"
                aria-expanded={renderDistanceOpen}
                data-build-render-distance-toggle
                onClick={() => setRenderDistanceOpen((open) => !open)}
                className={`inline-flex h-11 w-11 items-center justify-center border-0 transition ${
                  renderDistanceOpen
                    ? 'bg-accent-soft text-accent'
                    : 'bg-transparent text-secondary hover:bg-surface-muted/80 hover:text-primary'
                }`}
              >
                <Ruler className="h-4 w-4" />
              </button>
            </div>
            {renderDistanceOpen && (
              <ContextualPanel className="pointer-events-auto absolute left-0 top-full mt-2 w-64 space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <label htmlFor="build-render-distance" className="font-semibold text-primary">Visibility distance</label>
                  <output data-build-render-distance-value className="font-semibold tabular-nums text-accent">
                    {Math.round(renderDistance)}m
                  </output>
                </div>
                <input
                  id="build-render-distance"
                  type="range"
                  min={MIN_BUILD_RENDER_DISTANCE}
                  max={MAX_BUILD_RENDER_DISTANCE}
                  step="10"
                  value={renderDistance}
                  onChange={(event) => setRenderDistance(clampBuildRenderDistance(Number(event.target.value)))}
                  className="w-full accent-[var(--accent)]"
                  aria-label="Visibility distance"
                  data-build-render-distance-slider
                />
                <p className="text-[11px] leading-relaxed text-secondary">
                  Controls how far the Build viewport draws before the fog/shroud obscures it. This does not change shot or export cameras.
                </p>
              </ContextualPanel>
            )}
          </div>
        </div>

        {/* Sit below the global header action cluster so undo/redo isn't stacked under theme. */}
        <div
          className="pointer-events-none absolute right-5 z-10 flex flex-col items-end gap-2"
          style={{ top: 'calc(var(--stage-header-safe) + 0.35rem)' }}
          data-build-top-tools
        >
          <div className="pointer-events-auto flex items-center gap-0.5 overflow-hidden rounded-2xl border border-subtle/80 bg-surface-overlay/80 shadow-card backdrop-blur-sm">
            <button
              type="button"
              title="Undo Build edit (Ctrl+Z)"
              aria-label="Undo last Build change"
              data-build-undo
              disabled={!canUndo}
              onClick={() => undoBuild()}
              className="inline-flex h-11 w-11 items-center justify-center border-0 bg-transparent text-secondary transition hover:bg-surface-muted/80 hover:text-primary disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <span className="h-4 w-px shrink-0 self-center bg-border-subtle/70" aria-hidden />
            <button
              type="button"
              title="Redo Build edit (Ctrl+Shift+Z)"
              aria-label="Redo last Build change"
              data-build-redo
              disabled={!canRedo}
              onClick={() => redoBuild()}
              className="inline-flex h-11 w-11 items-center justify-center border-0 bg-transparent text-secondary transition hover:bg-surface-muted/80 hover:text-primary disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <span className="h-4 w-px shrink-0 self-center bg-border-subtle/70" aria-hidden />
            <button
              type="button"
              title="Paste Build objects (Ctrl/Cmd+V)"
              aria-label="Paste Build objects"
              data-build-paste
              onClick={() => void pasteSelection()}
              className="inline-flex h-11 w-11 items-center justify-center border-0 bg-transparent text-secondary transition hover:bg-surface-muted/80 hover:text-primary"
            >
              <ClipboardPaste className="h-4 w-4" />
            </button>
            <span className="h-4 w-px shrink-0 self-center bg-border-subtle/70" aria-hidden />
            <button
              type="button"
              title={showSceneGuides ? 'Hide scene guides' : 'Show camera guides'}
              onClick={() => setShowSceneGuides((visible) => !visible)}
              className={`inline-flex h-11 w-11 items-center justify-center border-0 transition ${
                showSceneGuides
                  ? 'bg-accent-soft text-accent'
                  : 'bg-transparent text-secondary hover:bg-surface-muted/80 hover:text-primary'
              }`}
            >
              {showSceneGuides ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {((selectedObject && buildMode === 'select') || buildMode === 'pano_origin') && editingChromeVisible && (
          <div
            data-build-drag-guidance
            className="pointer-events-none absolute left-[58%] top-[54%] z-10 -translate-x-1/2"
          >
            <div className="rounded-full border border-subtle/70 bg-surface-overlay/80 px-3 py-1.5 text-center text-xs font-medium text-secondary shadow-soft backdrop-blur-sm">
              {(gizmoMode === 'translate' || (buildMode === 'pano_origin' && gizmoMode === 'scale')) && (
                <>
                  <Move3D className="mr-1 inline h-3.5 w-3.5 text-accent" />
                  {buildMode === 'pano_origin' ? 'Drag arrows to move origin' : 'Drag arrows to move'}
                </>
              )}
              {gizmoMode === 'rotate' && (
                <>
                  <RotateCw className="mr-1 inline h-3.5 w-3.5 text-accent" />
                  {buildMode === 'pano_origin' ? 'Drag rings to rotate origin' : 'Drag rings to rotate'}
                </>
              )}
              {gizmoMode === 'scale' && buildMode === 'select' && (
                <>
                  <ZoomIn className="mr-1 inline h-3.5 w-3.5 text-accent" />
                  Drag handles to scale
                </>
              )}
            </div>
          </div>
        )}

        <div
          className="pointer-events-auto absolute left-5 z-10"
          style={{ top: renderDistanceOpen
            ? 'calc(var(--stage-header-safe) + 11rem)'
            : 'calc(var(--stage-header-safe) + 4rem)' }}
        >
          <AppearanceModeToggle
            value={appearance}
            projectedAvailable={canUseProjectedAppearance(project)}
            onChange={setAppearance}
          />
          {appearance === 'depth' && (
            <div
              className="mt-2 max-w-sm rounded-2xl border border-subtle bg-surface-overlay/95 p-3 shadow-soft backdrop-blur-sm"
              data-build-depth-settings
            >
              <DepthSettingsPanel
                depth={depthSettings}
                resolvedRange={depthPreviewRange}
                onChange={setDepthSettings}
                compact
              />
            </div>
          )}
        </div>

        {freeCameraActive && (
          <div
            data-build-free-camera-guidance
            className="pointer-events-none absolute left-5 z-10"
            style={{ top: renderDistanceOpen ? 'calc(var(--stage-header-safe) + 14.5rem)' : 'calc(var(--stage-header-safe) + 7.5rem)' }}
            role="status"
          >
            <ContextualPanel className="max-w-[calc(100vw-2.5rem)] text-sm text-secondary">
              <Navigation className="mr-1.5 inline h-4 w-4 text-accent" />
              <span className="hidden md:inline">Free camera: drag to look · WASD move · Space/Shift up/down · double-tap W to sprint · Esc exits</span>
              <span className="md:hidden">Free camera: drag to look · use the pad to move · tap Free camera to edit</span>
            </ContextualPanel>
          </div>
        )}

        {selectedObjects.length > 0 && editingChromeVisible && buildMode !== 'pano_origin' && (
          <div
            className="pointer-events-none absolute right-5 top-[calc(var(--stage-header-safe)+7.5rem)] z-10 sm:top-[calc(var(--stage-header-safe)+4rem)]"
            data-build-selection-tools
          >
            <ContextualPanel>
              <div className="flex items-center gap-2">
                {selectedObjects.length === 1 && selectedObject ? (
                  <TextInput
                    value={selectedObject.name}
                    onChange={(event) => updateObject(selectedObject.id, { name: event.target.value }, { history: 'coalesce' })}
                    aria-label="Selected object name"
                    className="h-8 min-w-36 border-subtle bg-surface-muted"
                  />
                ) : (
                  <div className="min-w-36 text-sm font-semibold text-primary" data-build-selection-count>
                    {selectedObjects.length} objects selected
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setPrecisionOpen(true)}
                  disabled={selectedObjects.length !== 1}
                  title="Precision drawer (I)"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-subtle text-secondary transition hover:border-accent hover:text-accent disabled:opacity-35"
                >
                  <Ruler className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setLayersOpen((open) => !open)}
                  title="Scene layers"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-subtle text-secondary transition hover:border-accent hover:text-accent"
                >
                  <Layers className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 flex items-center gap-1">
                <GizmoModeButton active={gizmoMode === 'translate'} label="Move (T)" onClick={() => setGizmoMode('translate')}>
                  <Move3D className="h-3.5 w-3.5" />
                </GizmoModeButton>
                <GizmoModeButton active={gizmoMode === 'rotate'} label="Rotate (E)" onClick={() => setGizmoMode('rotate')}>
                  <RotateCw className="h-3.5 w-3.5" />
                </GizmoModeButton>
                <GizmoModeButton active={gizmoMode === 'scale'} label="Scale (S)" onClick={() => setGizmoMode('scale')}>
                  <ZoomIn className="h-3.5 w-3.5" />
                </GizmoModeButton>
              </div>
              {selectedIsPoseable && selectedObject && (
                <div className="mt-2 space-y-2 border-t border-subtle pt-2" data-build-character-pose>
                  <div className="flex items-center gap-1" data-character-mode-toggle>
                    <button
                      type="button"
                      data-character-mode-move
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
                        characterEditMode === 'move' ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'
                      }`}
                      onClick={() => {
                        setCharacterEditMode('move');
                        setSelectedPoseJointId(undefined);
                      }}
                    >
                      Move Character
                    </button>
                    <button
                      type="button"
                      data-character-mode-pose
                      aria-pressed={characterEditMode === 'pose'}
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
                        characterEditMode === 'pose' ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'
                      }`}
                      onClick={() => setCharacterEditMode('pose')}
                    >
                      Pose Character
                    </button>
                  </div>
                  {selectedObject.poseableCharacter?.kind === 'autorigged' && (
                    <button
                      type="button"
                      className="w-full rounded-lg border border-subtle px-2 py-1.5 text-[11px] font-semibold text-secondary hover:border-accent hover:text-accent"
                      data-build-autorig-markers
                      onClick={() => setAutorigMarkerOpen(true)}
                    >
                      Place autorig markers
                    </button>
                  )}
                  {characterEditMode === 'pose' && (
                    <CharacterPosePanel
                      pose={selectedObject.humanPose}
                      selectedJointId={selectedPoseJointId}
                      onSelectJoint={setSelectedPoseJointId}
                      onChangePose={(next, options) => updateObject(
                        selectedObject.id,
                        { humanPose: next },
                        { history: options?.history ?? 'step' },
                      )}
                      onPoseEditBatchStart={beginBuildHistoryBatch}
                      onPoseEditBatchEnd={endBuildHistoryBatch}
                    />
                  )}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                <QuickAction title="Rotate left (Shift+R)" onClick={() => rotateSelected(-15)}><RotateCcw className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title="Rotate right (R)" onClick={() => rotateSelected(15)}><RotateCw className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title="Scale down ([)" onClick={() => scaleSelected(0.9)}><ZoomOut className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title="Scale up (])" onClick={() => scaleSelected(1.1)}><ZoomIn className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title="Cut (Ctrl/Cmd+X)" onClick={() => void cutSelection()}><Scissors className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title="Copy (Ctrl/Cmd+C)" onClick={() => void copySelection()}><Copy className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title="Paste (Ctrl/Cmd+V)" onClick={() => void pasteSelection()}><ClipboardPaste className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title="Duplicate (D or Ctrl/Cmd+D)" onClick={() => duplicateSelectedObjects()}><SquareStack className="h-3.5 w-3.5" /></QuickAction>
                <QuickAction title={selectionAllLocked ? 'Unlock (L)' : 'Lock (L)'} onClick={() => toggleSelectedLocked()}>
                  {selectionAllLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                </QuickAction>
                <QuickAction title={selectionAllHidden ? 'Show (H)' : 'Hide (H)'} onClick={() => toggleSelectedVisibility()}>
                  {selectionAllHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </QuickAction>
                <QuickAction title="Delete" danger onClick={requestDeleteSelection}><Trash2 className="h-3.5 w-3.5" /></QuickAction>
              </div>
              {layersOpen && (
                <div className="mt-3 max-h-40 space-y-1 overflow-y-auto border-t border-subtle pt-3">
                  {project.scene.objects.map((object) => (
                    <button
                      key={object.id}
                      type="button"
                      onClick={(event) => {
                        if (event.shiftKey) selectObjectRange(object.id);
                        else selectObject(object.id, event.ctrlKey || event.metaKey ? 'toggle' : 'replace');
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                        selectedObjectIds.includes(object.id) ? 'bg-accent-soft text-accent' : 'text-secondary hover:bg-surface-muted'
                      }`}
                    >
                      <Box className="h-3 w-3 shrink-0" />
                      <span className="truncate">{object.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </ContextualPanel>
          </div>
        )}

        {clipboardStatus && (
          <div
            role="status"
            data-build-command-status
            className="pointer-events-none absolute left-1/2 top-[calc(var(--stage-header-safe)+0.5rem)] z-30 -translate-x-1/2 rounded-full border border-subtle bg-surface-overlay px-4 py-2 text-xs font-medium text-primary shadow-card backdrop-blur"
          >
            {clipboardStatus}
          </div>
        )}

        {shortcutsOpen && (
          <div className="pointer-events-auto absolute left-5 top-[calc(var(--stage-header-safe)+0.5rem)] z-30 w-[min(24rem,calc(100%-2.5rem))]">
            <ContextualPanel>
              <div className="mb-2 flex items-center justify-between gap-3">
                <strong className="text-sm text-primary">Build shortcuts</strong>
                <button type="button" className="text-xs text-muted hover:text-primary" onClick={() => setShortcutsOpen(false)}>Close</button>
              </div>
              <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-secondary" data-build-shortcut-reference>
                <kbd>Ctrl/Cmd+C · X · V</kbd><span>Copy · cut · paste</span>
                <kbd>Ctrl/Cmd+Shift+V</kbd><span>Paste in place</span>
                <kbd>Ctrl/Cmd+A · Shift+A</kbd><span>Select all · deselect</span>
                <kbd>D · Ctrl/Cmd+D</kbd><span>Duplicate selection</span>
                <kbd>Arrows · PgUp/PgDn</kbd><span>Nudge on world axes</span>
                <kbd>F · Home</kbd><span>Frame selection · frame all</span>
                <kbd>T · E · S</kbd><span>Move · rotate · scale gizmo</span>
                <kbd>H · Alt+H · L</kbd><span>Hide · show all · lock</span>
                <kbd>F2 · I · ?</kbd><span>Rename · precision · help</span>
                <kbd>Ctrl/Cmd+Z · Shift+Z</kbd><span>Undo · redo</span>
              </div>
            </ContextualPanel>
          </div>
        )}

        <BuildObjectTray
          activePrimitive={activePrimitive}
          buildMode={buildMode}
          gridSnap={gridSnap}
          onModeChange={setBuildMode}
          onPrimitiveChange={setActivePrimitive}
          onGridSnapChange={setGridSnap}
          onImport={() => setModelImportOpen(true)}
          onImportPoseable={() => setPoseableImportOpen(true)}
          onGenerateSet={() => setSetGenerationOpen(true)}
        />

        {/* Isolated stacking context so the viewport canvas cannot swallow CTA clicks. */}
        <div
          data-build-graybox-cta
          className="pointer-events-auto absolute bottom-[5.5rem] right-3 z-30 flex max-w-[min(100%-1.5rem,20rem)] flex-col items-end gap-2 sm:bottom-6 sm:right-6 sm:max-w-none"
        >
          {grayboxAsset && grayboxPano ? (
            <>
              <PrimaryCTA
                icon={<FileDown className="h-5 w-5" />}
                label={`Download Graybox 360 (${grayboxPano.width}×${grayboxPano.height})`}
                hint="Downloads the latest rendered equirectangular PNG."
                onClick={() => void downloadPanoImage(
                  grayboxAsset.uri,
                  grayboxPano.width,
                  grayboxPano.height,
                  grayboxAsset.name || 'global_graybox.png',
                  {
                    letterboxEnabled: false,
                    targetWidth: project.settings.defaultShotWidth,
                    targetHeight: project.settings.defaultShotHeight,
                  },
                  downloadDataUrl,
                )}
                disabled={isRenderingGraybox || isRenderingProjected}
              />
              <button
                type="button"
                data-build-rerender-graybox
                onClick={handleRenderGraybox}
                disabled={isRenderingGraybox || isRenderingProjected}
                className="inline-flex items-center gap-2 rounded-[18px] border border-subtle bg-surface-overlay px-4 py-2 text-xs font-medium text-secondary shadow-card backdrop-blur-sm transition hover:border-[var(--accent)] hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Globe className="h-3.5 w-3.5" />
                {isRenderingGraybox ? 'Rendering...' : 'Re-render after scene changes'}
              </button>
            </>
          ) : (
            <PrimaryCTA
              icon={<Globe className="h-5 w-5" />}
              label={isRenderingGraybox ? 'Rendering...' : 'Render 360 Reference'}
              hint="Creates the latest graybox 360 for the Reference step."
              onClick={handleRenderGraybox}
              disabled={isRenderingGraybox || isRenderingProjected}
              highlighted={primaryAction?.id === 'render-graybox'}
            />
          )}
          {canUseProjectedAppearance(project) && (
            <div data-build-download-projected-360>
              <PrimaryCTA
                icon={<FileDown className="h-5 w-5" />}
                label={isRenderingProjected ? 'Rendering projected 360…' : 'Download Projected 360'}
                hint="Equirect from the current capture origin with projected textures — seed for second-pano inpainting."
                onClick={handleDownloadProjected360}
                disabled={isRenderingGraybox || isRenderingProjected}
                appearance="glow-outline"
              />
            </div>
          )}
          {canUseProjectedAppearance(project)
            && resolveStyledImportMode(project, { pendingSecondCapturePlan }) === 'add_secondary'
            && (
              <div
                data-build-second-capture-coach
                className="max-w-xs rounded-xl border border-[var(--accent)]/35 bg-surface-overlay px-3 py-2 text-xs leading-snug text-primary shadow-card backdrop-blur"
              >
                Capture moved. Download Projected 360, then open Reference and choose{' '}
                <span className="font-semibold">Add second capture</span> to blend.
              </div>
            )}
          <div className="sr-only" data-graybox-count={grayboxCount} aria-hidden />
          {grayboxRenderError && (
            <p
              role="alert"
              className="max-w-xs rounded-xl border border-red-400/60 bg-surface-overlay px-3 py-2 text-xs text-primary shadow-card backdrop-blur"
            >
              {grayboxRenderError}
            </p>
          )}
          {projectedRenderError && (
            <p
              role="alert"
              data-build-projected-360-error
              className="max-w-xs rounded-xl border border-red-400/60 bg-surface-overlay px-3 py-2 text-xs text-primary shadow-card backdrop-blur"
            >
              {projectedRenderError}
            </p>
          )}
        </div>

        {buildMode === 'pano_origin' && (
          <div
            className="pointer-events-none absolute right-5 z-10"
            style={{
              top: editingChromeVisible
                ? 'calc(var(--stage-header-safe) + 4rem)'
                : 'calc(var(--stage-header-safe) + 0.35rem)',
            }}
            data-build-origin-coaching
          >
            <ContextualPanel className="max-w-sm space-y-1 text-sm text-secondary">
              <div>
                <Move3D className="mr-1.5 inline h-4 w-4 text-amber-500" />
                Origin gizmos: <span className="font-medium text-primary">T</span> move ·{' '}
                <span className="font-medium text-primary">E</span> rotate ·{' '}
                <span className="font-medium text-primary">O</span> exit
              </div>
              {shouldWarnOnOriginMove(project) && (
                <p className="text-xs text-amber-800 dark:text-amber-200">
                  Reference panoramas stay locked to their own origins. Moving this capture origin
                  starts a new capture point and can make projection look off until you blend
                  multiple panos in Reference.
                </p>
              )}
            </ContextualPanel>
          </div>
        )}

        {buildMode === 'pano_origin' && editingChromeVisible && (
          <div
            className="pointer-events-none absolute right-5 z-10"
            style={{ top: 'calc(var(--stage-header-safe) + 0.35rem)' }}
            data-build-origin-controls
          >
            <ContextualPanel>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-primary">Capture origin</div>
                <GizmoModeButton
                  active={gizmoMode === 'translate' || gizmoMode === 'scale'}
                  label="Move origin (T)"
                  onClick={() => setGizmoMode('translate')}
                >
                  <Move3D className="h-3.5 w-3.5" />
                </GizmoModeButton>
                <GizmoModeButton
                  active={gizmoMode === 'rotate'}
                  label="Rotate origin (E)"
                  onClick={() => setGizmoMode('rotate')}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </GizmoModeButton>
              </div>
            </ContextualPanel>
          </div>
        )}

        {buildMode === 'place' && (
          <div
            className="pointer-events-none absolute left-5 z-10"
            style={{ top: 'calc(var(--stage-header-safe) + 0.35rem)' }}
          >
            <ContextualPanel className="text-sm text-secondary">
              Click the floor to place {primitiveLabel(activePrimitive)}
            </ContextualPanel>
          </div>
        )}
      </div>

      <PrecisionDrawer
        open={precisionOpen && selectedObjects.length === 1 && Boolean(selectedObject)}
        title="Precision"
        onClose={() => setPrecisionOpen(false)}
      >
        {selectedObject && (
          <div className="space-y-4">
            <PrecisionControls
              object={selectedObject}
              onChange={(updates, history = 'coalesce') => (
                updateObject(selectedObject.id, updates, { history })
              )}
            />
            {grayboxAsset && grayboxPano && (
              <button
                type="button"
                onClick={() => void downloadPanoImage(
                  grayboxAsset.uri,
                  grayboxPano.width,
                  grayboxPano.height,
                  grayboxAsset.name || 'global_graybox.png',
                  {
                    letterboxEnabled: project.settings.panoLetterboxExports169,
                    targetWidth: project.settings.defaultShotWidth,
                    targetHeight: project.settings.defaultShotHeight,
                  },
                  downloadDataUrl,
                )}
                disabled={isRenderingGraybox}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm text-secondary transition hover:border-accent hover:text-accent"
              >
                <FileDown className="h-4 w-4" />
                Download Graybox PNG
              </button>
            )}
          </div>
        )}
      </PrecisionDrawer>
      <ModelImportDialog
        open={modelImportOpen}
        onClose={() => setModelImportOpen(false)}
        onImported={(objects) => {
          setBuildMode('select');
          requestFrame(objects.map((object) => object.id));
        }}
      />
      <PoseableCharacterImportDialog
        open={poseableImportOpen}
        onClose={() => setPoseableImportOpen(false)}
        onImported={(object) => {
          setBuildMode('select');
          requestFrame([object.id]);
          if (object.poseableCharacter?.kind === 'autorigged') {
            setAutorigMarkerOpen(true);
          }
        }}
      />
      {(() => {
        const selected = project.scene.objects.find((object) => object.id === selectedObjectIds[0]);
        const source = selected?.poseableCharacter;
        const rigAsset = source?.kind === 'autorigged'
          ? project.assets.assets[source.assetId]
          : undefined;
        const rig = rigAsset?.metadata?.poseableRig;
        if (!rig || !rigAsset) return null;
        return (
          <AutorigMarkerWizardDialog
            open={autorigMarkerOpen}
            onClose={() => setAutorigMarkerOpen(false)}
            rig={rig}
            onSave={(next) => {
              updatePoseableRigAsset(rigAsset.id, next);
              const sourceId = next.originalSourceAssetId ?? next.sourceMeshAssetId;
              if (!sourceId) return;
              void generateSkinWeightsForRigAsset({
                rig: next,
                sourceAssetId: sourceId,
                assets: useContinuityStore.getState().project.assets,
              }).then(({ rig: skinnedRig, skinAsset }) => {
                const state = useContinuityStore.getState();
                state.updatePoseableRigAsset(rigAsset.id, skinnedRig);
                // Register skin binary asset without a separate history step API.
                useContinuityStore.setState((current) => ({
                  project: {
                    ...current.project,
                    assets: {
                      assets: {
                        ...current.project.assets.assets,
                        [skinAsset.id]: skinAsset,
                      },
                    },
                  },
                }));
                // Re-hydrate adapter so the next viewport rebuild uses skinned mesh.
                hydrateAutoriggedCharactersFromAssets(useContinuityStore.getState().project.assets);
              }).catch(() => undefined);
            }}
          />
        );
      })()}
      <SetGenerationDialog
        open={setGenerationOpen}
        onClose={() => setSetGenerationOpen(false)}
        onApply={async (compiled) => {
          if (!onCreateProjectFromBlueprint) {
            throw new Error('Project recovery is still starting. Please try again in a moment.');
          }
          await onCreateProjectFromBlueprint(compiled);
          setBuildMode('select');
          clearObjectSelection();
          requestFrame(compiled.project.scene.objects.map((object) => object.id));
        }}
      />
    </FullBleedLayout>
  );
}

function BuildObjectTray({
  activePrimitive,
  buildMode,
  gridSnap,
  onModeChange,
  onPrimitiveChange,
  onGridSnapChange,
  onImport,
  onImportPoseable,
  onGenerateSet,
}: {
  activePrimitive: SceneObjectType;
  buildMode: BuildMode;
  gridSnap: boolean;
  onModeChange: (mode: BuildMode) => void;
  onPrimitiveChange: (type: SceneObjectType) => void;
  onGridSnapChange: (value: boolean) => void;
  onImport: () => void;
  onImportPoseable: () => void;
  onGenerateSet: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-fit max-w-[calc(100vw-1.5rem)] sm:bottom-6 sm:left-6 sm:max-w-[calc(100%-2rem)]">
      {toolsOpen && (
        <div className="pointer-events-auto mb-2 max-h-[40vh] w-full max-w-72 overflow-y-auto rounded-[var(--radius-card)] border border-subtle bg-surface-overlay p-3 shadow-soft backdrop-blur">
          <div className="mb-2 grid grid-cols-3 gap-2">
            <TrayButton active={buildMode === 'select'} label="Select" compact onClick={() => onModeChange('select')}>
              <Move3D className="h-4 w-4" />
            </TrayButton>
            <TrayButton active={buildMode === 'pano_origin'} label="Origin" compact onClick={() => onModeChange('pano_origin')}>
              <Grid3X3 className="h-4 w-4" />
            </TrayButton>
            <TrayButton active={gridSnap} label="Snap" compact onClick={() => onGridSnapChange(!gridSnap)}>
              <Grid3X3 className="h-4 w-4" />
            </TrayButton>
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-subtle pt-2">
            <button
              type="button"
              onClick={() => {
                setToolsOpen(false);
                onGenerateSet();
              }}
              className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-accent/50 bg-accent-soft px-3 py-2 text-xs font-semibold text-accent transition hover:border-accent"
              data-build-generate-set
            >
              <Sparkles className="h-4 w-4" />
              Generate set from description
            </button>
            <button
              type="button"
              onClick={() => {
                setToolsOpen(false);
                onImport();
              }}
              className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-subtle px-3 py-2 text-xs font-semibold text-secondary transition hover:border-accent hover:text-accent"
              data-build-import-model
            >
              <Upload className="h-4 w-4" />
              Import 3D model or scene
            </button>
            <button
              type="button"
              onClick={() => {
                setToolsOpen(false);
                onImportPoseable();
              }}
              className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-subtle px-3 py-2 text-xs font-semibold text-secondary transition hover:border-accent hover:text-accent"
              data-build-import-poseable-character
            >
              <User className="h-4 w-4" />
              Import poseable character
            </button>
            {overflowTrayItems.map(({ type, label, icon: Icon }) => (
              <div key={type}>
                <TrayButton
                  active={buildMode === 'place' && activePrimitive === type}
                  label={label}
                  compact
                  onClick={() => onPrimitiveChange(type)}
                >
                  <Icon className="h-4 w-4" />
                </TrayButton>
              </div>
            ))}
          </div>
        </div>
      )}
      <div
        data-build-object-tray
        className="pointer-events-auto max-w-full rounded-[22px] border border-subtle bg-surface-overlay px-2 py-2 shadow-[var(--tray-glow)] backdrop-blur dark:border-[var(--accent)]/25 sm:px-3 sm:py-2.5"
      >
        <div className="flex max-w-full items-stretch gap-1 overflow-x-auto overscroll-x-contain pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {primaryTrayItems.map(({ type, label, icon: Icon }) => {
            const shortcut = getPrimitiveShortcutLabel(type);
            return (
              <div key={type} className="shrink-0">
                <TrayButton
                  active={buildMode === 'place' && activePrimitive === type}
                  label={label}
                  shortcut={shortcut}
                  onClick={() => onPrimitiveChange(type)}
                >
                  <Icon className="h-5 w-5" />
                </TrayButton>
              </div>
            );
          })}
          <div className="shrink-0">
            <TrayButton active={toolsOpen} label="More" onClick={() => setToolsOpen((open) => !open)}>
              <Wrench className="h-5 w-5" />
            </TrayButton>
          </div>
        </div>
        {toolsOpen && (
          <p className="mt-2 hidden border-t border-subtle pt-2 text-[10px] leading-relaxed text-muted sm:block" data-build-shortcuts-hint>
            Keys: 1–9/0 stamp · V/Esc select · Ctrl/Cmd+C/X/V clipboard · Ctrl/Cmd+A select all · D duplicate · Arrows nudge · F/Home frame · T/E/S gizmo · H/Alt+H visibility · L lock · ? help
          </p>
        )}
      </div>
    </div>
  );
}

function TrayButton({
  active,
  label,
  compact,
  shortcut,
  children,
  onClick,
}: {
  active?: boolean;
  label: string;
  compact?: boolean;
  shortcut?: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`relative flex min-h-11 shrink-0 flex-col items-center justify-center gap-1 rounded-xl px-2 py-1.5 transition ${
        compact ? 'w-full' : 'w-16'
      } ${
        active ? 'bg-accent-soft text-accent' : 'text-secondary hover:bg-surface-muted hover:text-primary'
      }`}
    >
      {shortcut && (
        <span className="absolute right-1 top-0.5 rounded bg-surface-muted px-1 text-[9px] font-semibold tabular-nums text-muted">
          {shortcut}
        </span>
      )}
      {children}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

function GizmoModeButton({
  active,
  label,
  children,
  onClick,
}: {
  active?: boolean;
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={`inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition ${
        active
          ? 'border-[var(--accent)] bg-accent-soft text-accent'
          : 'border-subtle text-secondary hover:border-accent hover:text-accent'
      }`}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function QuickAction({
  children,
  title,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border transition ${
        danger
          ? 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400'
          : 'border-subtle text-secondary hover:border-accent hover:text-accent'
      }`}
    >
      {children}
    </button>
  );
}

function PrecisionControls({
  object,
  onChange,
}: {
  object: SceneObject;
  onChange: (updates: Partial<SceneObject>, history?: 'step' | 'coalesce') => void;
}) {
  const surfaceStyle = resolveSurfaceStyle(object);
  const primaryColor = object.color ?? defaultSolidColorForObject(object);
  const secondaryColor = object.secondaryColor ?? defaultSecondaryColor(primaryColor);

  const setSurfaceStyle = (next: ObjectSurfaceStyle) => {
    if (next === 'default') {
      onChange({
        surfaceStyle: 'default',
        color: undefined,
        secondaryColor: undefined,
      }, 'step');
      return;
    }
    onChange({
      surfaceStyle: next,
      color: object.color ?? defaultSolidColorForObject(object),
      secondaryColor: next === 'checkerboard'
        ? (object.secondaryColor ?? defaultSecondaryColor(object.color ?? defaultSolidColorForObject(object)))
        : object.secondaryColor,
    }, 'step');
  };

  return (
    <div className="space-y-3">
      <Field label="Name">
        <TextInput value={object.name} onChange={(event) => onChange({ name: event.target.value }, 'coalesce')} />
      </Field>
      <Field label="Type">
        {object.type === 'imported_model' ? (
          <div className="rounded-lg border border-subtle bg-surface-muted px-3 py-2 text-sm text-secondary">
            Imported graybox mesh
          </div>
        ) : (
          <Select value={object.type} onChange={(event) => onChange({ type: event.target.value as SceneObjectType }, 'step')}>
            {primitiveTypes.map((type) => <option key={type} value={type}>{objectDisplayName(type)}</option>)}
          </Select>
        )}
      </Field>
      {object.importedModel && (
        <div className="rounded-lg border border-subtle bg-surface-muted px-3 py-2 text-xs leading-relaxed text-secondary">
          <div className="font-medium text-primary">{object.importedModel.sourceName}</div>
          <div className="mt-1">
            {object.importedModel.triangleCount.toLocaleString()} tri · {object.importedModel.vertexCount.toLocaleString()} verts · {object.importedModel.meshCount} mesh{object.importedModel.meshCount === 1 ? '' : 'es'}
            {object.importedModel.instanceCount ? ` · ${object.importedModel.instanceCount} instances` : ''}
          </div>
          {object.importedModel.sourceNodeName && (
            <div>Node: {object.importedModel.sourceNodeName}</div>
          )}
          {object.importedModel.sourceNodePath && (
            <div className="truncate">Path: {object.importedModel.sourceNodePath}</div>
          )}
          <div>Mode: {object.importedModel.importMode} · world-transform baked · hierarchy flattened · texture-free</div>
          {object.importedModel.warnings && object.importedModel.warnings.length > 0 && (
            <div className="mt-1 text-amber-600">{object.importedModel.warnings[0]}</div>
          )}
        </div>
      )}
      <Field label="Staging role" hint="People are hidden on clean-plate exports. Any unlocked object can still be staged per shot.">
        <Select
          value={getSceneObjectStagingRole(object)}
          onChange={(event) => onChange({ stagingRole: event.target.value as StagingRole }, 'step')}
          data-object-staging-role
        >
          <option value="set">Set geometry</option>
          <option value="prop">Movable prop</option>
          <option value="person">Person / character</option>
        </Select>
      </Field>
      <Field label="Surface">
        <Select
          value={surfaceStyle}
          onChange={(event) => setSurfaceStyle(event.target.value as ObjectSurfaceStyle)}
          data-object-surface-style
        >
          <option value="default">Default clay</option>
          <option value="solid">Solid color</option>
          <option value="checkerboard">1m × 1m checkerboard</option>
        </Select>
      </Field>
      {surfaceStyle !== 'default' && (
        <Field label={surfaceStyle === 'checkerboard' ? 'Light tile' : 'Color'}>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={primaryColor}
              onChange={(event) => onChange({ color: event.target.value }, 'coalesce')}
              className="h-9 w-12 cursor-pointer rounded-lg border border-subtle bg-surface-raised p-1"
              aria-label="Object color"
              data-object-color
            />
            <TextInput
              value={primaryColor}
              onChange={(event) => onChange({ color: event.target.value }, 'coalesce')}
              className="font-mono text-xs"
            />
          </div>
        </Field>
      )}
      {surfaceStyle === 'checkerboard' && (
        <Field label={`Dark tile (${CHECKERBOARD_TILE_METERS}m grid)`}>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={secondaryColor}
              onChange={(event) => onChange({ secondaryColor: event.target.value }, 'coalesce')}
              className="h-9 w-12 cursor-pointer rounded-lg border border-subtle bg-surface-raised p-1"
              aria-label="Checkerboard secondary color"
              data-object-secondary-color
            />
            <TextInput
              value={secondaryColor}
              onChange={(event) => onChange({ secondaryColor: event.target.value }, 'coalesce')}
              className="font-mono text-xs"
            />
          </div>
        </Field>
      )}
      <Field label="Position">
        <Vec3Input
          value={object.transform.position}
          onChange={(position) => onChange({ transform: { ...object.transform, position } }, 'coalesce')}
        />
      </Field>
      <Field label="Rotation">
        <Vec3Input
          value={object.transform.rotation}
          step={1}
          onChange={(rotation) => onChange({ transform: { ...object.transform, rotation } }, 'coalesce')}
        />
      </Field>
      <Field label="Dimensions">
        <Vec3Input value={object.dimensions} onChange={(dimensions) => onChange({ dimensions }, 'coalesce')} />
      </Field>
    </div>
  );
}

function signedDegreeDelta(from: number, to: number) {
  return ((to - from + 540) % 360) - 180;
}

function blurActiveElement() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

function primitiveLabel(type: SceneObjectType) {
  const tray = trayItems.find((item) => item.type === type);
  return tray?.label ?? objectDisplayName(type);
}
