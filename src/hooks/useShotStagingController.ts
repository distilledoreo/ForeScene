import { useCallback, useState } from 'react';
import type { HumanJointId, ShotObjectOverrides } from '../domain/types';
import type { GizmoMode } from '../engine/transformGizmo';

export type StagingEditMode = 'translate' | 'rotate' | 'pose';

/**
 * Per-shot object staging / gizmo / pose / transient viewport override state.
 */
export function useShotStagingController() {
  const [stagingMode, setStagingMode] = useState(false);
  const [stagingGizmoMode, setStagingGizmoMode] = useState<GizmoMode>('translate');
  const [stagingPoseEdit, setStagingPoseEdit] = useState(false);
  const [selectedPoseJointId, setSelectedPoseJointId] = useState<HumanJointId | undefined>();
  const [stagedObjectId, setStagedObjectId] = useState<string>();
  const [showPeopleInViewport, setShowPeopleInViewport] = useState(true);
  const [viewportObjectOverrides, setViewportObjectOverrides] = useState<
    ShotObjectOverrides | undefined
  >(undefined);

  const clearViewportObjectInspection = useCallback(() => {
    setViewportObjectOverrides(undefined);
    setStagedObjectId(undefined);
    setStagingPoseEdit(false);
    setSelectedPoseJointId(undefined);
  }, []);

  const enterStaging = useCallback(() => {
    setStagingMode(true);
  }, []);

  const exitStaging = useCallback(() => {
    setStagingMode(false);
    setStagedObjectId(undefined);
    setStagingPoseEdit(false);
    setSelectedPoseJointId(undefined);
  }, []);

  const setStagingEditMode = useCallback((mode: StagingEditMode) => {
    if (mode === 'pose') {
      setStagingPoseEdit(true);
      return;
    }
    setStagingPoseEdit(false);
    setSelectedPoseJointId(undefined);
    setStagingGizmoMode(mode);
  }, []);

  return {
    stagingMode,
    setStagingMode,
    stagingGizmoMode,
    setStagingGizmoMode,
    stagingPoseEdit,
    setStagingPoseEdit,
    selectedPoseJointId,
    setSelectedPoseJointId,
    stagingEditMode: (stagingPoseEdit ? 'pose' : stagingGizmoMode === 'rotate' ? 'rotate' : 'translate') as StagingEditMode,
    setStagingEditMode,
    stagedObjectId,
    setStagedObjectId,
    showPeopleInViewport,
    setShowPeopleInViewport,
    viewportObjectOverrides,
    setViewportObjectOverrides,
    clearViewportObjectInspection,
    enterStaging,
    exitStaging,
  };
}
