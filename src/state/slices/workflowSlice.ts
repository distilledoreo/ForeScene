import type { StateCreator } from 'zustand';
import type { LocationProject } from '../../domain/types';
import { createOriginShot } from '../../domain/defaults';
import { getCanonicalPano, linkAllShotsToCanonicalPano, panoViewFromCamera } from '../../engine/sync';
import { normalizeWorkspace } from '../../engine/workflow';
import type { ContinuityStoreSlices, WorkflowSliceState } from './types';

function touchProjectUpdatedAt<T extends { updatedAt: string }>(project: T): T {
  return { ...project, updatedAt: new Date().toISOString() };
}

function ensureProjectHasCamera(project: LocationProject): LocationProject {
  const withShots = project.shots.length > 0
    ? project
    : touchProjectUpdatedAt({ ...project, shots: [createOriginShot(project)] });
  return linkAllShotsToCanonicalPano(withShots);
}

/**
 * Workflow domain slice: workspace rail, coaching / objective modals, progression stamps.
 * Owns its initial state and actions via the Zustand creator closure — not key-picked from the monolith.
 */
export const createWorkflowSlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  WorkflowSliceState
> = (set, get) => ({
  workspace: 'build',
  dismissedWorkflowAdvanceKeys: [],
  seenObjectiveWorkspaces: [],
  objectiveModalRequest: 0,
  alignmentIntroRequest: 0,
  alignmentRetryModalRequest: 0,
  seenAlignmentIntroForPanoId: undefined,

  setWorkspace: (workspace) => {
    workspace = normalizeWorkspace(workspace);
    const state = get();
    let clearExportingPackage = false;
    if (
      state.isExportingPackage
      && state.workspace === 'export'
      && workspace !== 'export'
    ) {
      // Catch nav chrome, workflow guidance, and any other setWorkspace callers.
      const confirmed = typeof globalThis.confirm === 'function'
        && globalThis.confirm('An export is currently running. Cancel it and leave?');
      if (!confirmed) return;
      clearExportingPackage = true;
    }

    set((current) => {
      if (workspace !== 'shots') {
        return {
          workspace,
          ...(clearExportingPackage ? { isExportingPackage: false } : {}),
        };
      }
      const project = ensureProjectHasCamera(current.project);
      const shot = project.shots.find((item) => item.id === current.selectedShotId)
        ?? project.shots[0];
      return {
        workspace,
        project,
        selectedShotId: shot.id,
        activePanoId: shot.linkedPanoId ?? current.activePanoId,
        panoView: panoViewFromCamera(shot.camera),
        // Still camera is always live (phone-camera style); capture does not freeze.
        shotCameraFlying: true,
        ...(clearExportingPackage ? { isExportingPackage: false } : {}),
      };
    });
  },

  approveGrayboxForReference: () => set((state) => ({
    project: touchProjectUpdatedAt({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        grayboxApprovedForReferenceAt: new Date().toISOString(),
      },
    }),
  })),

  acceptReferenceAlignment: () => set((state) => {
    const canonical = getCanonicalPano(state.project);
    if (!canonical) return state;
    return {
      project: touchProjectUpdatedAt({
        ...state.project,
        workflow: {
          ...state.project.workflow,
          referenceAlignmentAcceptedForPanoId: canonical.id,
        },
      }),
    };
  }),

  acceptShotFraming: (shotId) => set((state) => ({
    project: touchProjectUpdatedAt({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        shotFramingAcceptedAtByShotId: {
          ...state.project.workflow.shotFramingAcceptedAtByShotId,
          [shotId]: new Date().toISOString(),
        },
      },
    }),
  })),

  markAiBriefSent: (shotId) => set((state) => ({
    project: touchProjectUpdatedAt({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        aiBriefSentAtByShotId: {
          ...state.project.workflow.aiBriefSentAtByShotId,
          [shotId]: new Date().toISOString(),
        },
      },
    }),
  })),

  markFinalPackageExported: (shotId) => set((state) => ({
    project: touchProjectUpdatedAt({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        finalPackageExportedAtByShotId: {
          ...state.project.workflow.finalPackageExportedAtByShotId,
          [shotId]: new Date().toISOString(),
        },
      },
    }),
  })),

  dismissWorkflowAdvance: (promptKey) => set((state) => ({
    dismissedWorkflowAdvanceKeys: state.dismissedWorkflowAdvanceKeys.includes(promptKey)
      ? state.dismissedWorkflowAdvanceKeys
      : [...state.dismissedWorkflowAdvanceKeys, promptKey],
  })),

  markObjectiveSeen: (workspace) => set((state) => ({
    seenObjectiveWorkspaces: state.seenObjectiveWorkspaces.includes(workspace)
      ? state.seenObjectiveWorkspaces
      : [...state.seenObjectiveWorkspaces, workspace],
  })),

  requestObjectiveModal: () => set((state) => ({
    objectiveModalRequest: state.objectiveModalRequest + 1,
  })),

  requestAlignmentIntro: () => set((state) => ({
    alignmentIntroRequest: state.alignmentIntroRequest + 1,
  })),

  requestAlignmentRetryModal: () => set((state) => ({
    alignmentRetryModalRequest: state.alignmentRetryModalRequest + 1,
  })),

  markAlignmentIntroSeen: (panoId) => set({ seenAlignmentIntroForPanoId: panoId }),

  resetWorkflowSession: () => set({
    dismissedWorkflowAdvanceKeys: [],
    seenObjectiveWorkspaces: [],
    objectiveModalRequest: 0,
    alignmentIntroRequest: 0,
    alignmentRetryModalRequest: 0,
    seenAlignmentIntroForPanoId: undefined,
    pendingSecondCapturePlan: undefined,
  }),
});
