import { useCallback, useState } from 'react';
import type { ShotObjectOverrides } from '../domain/types';
import type { GizmoMode } from '../engine/transformGizmo';

/**
 * Per-shot object staging / gizmo / transient viewport override state.
 */
export function useShotStagingController() {
  const [stagingMode, setStagingMode] = useState(false);
  const [stagingGizmoMode, setStagingGizmoMode] = useState<GizmoMode>('translate');
  const [stagedObjectId, setStagedObjectId] = useState<string>();
  const [showPeopleInViewport, setShowPeopleInViewport] = useState(true);
  const [viewportObjectOverrides, setViewportObjectOverrides] = useState<
    ShotObjectOverrides | undefined
  >(undefined);

  const clearViewportObjectInspection = useCallback(() => {
    setViewportObjectOverrides(undefined);
    setStagedObjectId(undefined);
  }, []);

  const enterStaging = useCallback(() => {
    setStagingMode(true);
  }, []);

  const exitStaging = useCallback(() => {
    setStagingMode(false);
    setStagedObjectId(undefined);
  }, []);

  return {
    stagingMode,
    setStagingMode,
    stagingGizmoMode,
    setStagingGizmoMode,
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
