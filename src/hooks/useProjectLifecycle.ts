import { useEffect, useRef, useState } from 'react';

import type { LocationProject } from '../domain/types';
import { createDefaultProject } from '../domain/defaults';
import type { ProjectPersistenceController } from '../engine/projectPersistenceController';
import { useAppModeStore } from '../state/useAppModeStore';
import { useContinuityStore } from '../state/useContinuityStore';
import { useProjectSafetyStore } from '../state/useProjectSafetyStore';

let projectIoPromise: Promise<typeof import('../engine/projectIO')> | undefined;
let projectPersistencePromise: Promise<typeof import('../engine/projectPersistenceController')> | undefined;
let projectSafetyPromise: Promise<typeof import('../engine/projectSafety')> | undefined;

function loadProjectIo() {
  projectIoPromise ??= import('../engine/projectIO');
  return projectIoPromise;
}

function loadProjectPersistence() {
  projectPersistencePromise ??= import('../engine/projectPersistenceController');
  return projectPersistencePromise;
}

function loadProjectSafety() {
  projectSafetyPromise ??= import('../engine/projectSafety');
  return projectSafetyPromise;
}

const IMPORT_STATUS_DISMISS_MS = 4000;

export interface ProjectImportStatus {
  tone: 'success' | 'error';
  message: string;
}

export interface UseProjectLifecycleOptions {
  /** Close app-chrome overlays (help, project safety) after a project swap. */
  closeProjectOverlays: () => void;
}

/**
 * Owns project lifecycle orchestration: startup recovery + persistence wiring,
 * import/export/new-project flows, and local recovery revision actions.
 * Extracted from App.tsx unchanged in behavior.
 */
export function useProjectLifecycle({ closeProjectOverlays }: UseProjectLifecycleOptions) {
  const fileRef = useRef<HTMLInputElement>(null);
  const persistenceControllerRef = useRef<ProjectPersistenceController | undefined>(undefined);
  const [projectImportStatus, setProjectImportStatus] = useState<ProjectImportStatus>();
  const [newProjectConfirmOpen, setNewProjectConfirmOpen] = useState(false);
  const [isCreatingNewProject, setIsCreatingNewProject] = useState(false);

  const setAppMode = useAppModeStore((state) => state.setAppMode);
  const setProject = useContinuityStore((state) => state.setProject);
  const setWorkspace = useContinuityStore((state) => state.setWorkspace);
  const criticalProjectWrite = useProjectSafetyStore((state) => state.criticalWrite);
  const projectSaveStatus = useProjectSafetyStore((state) => state.status);
  const setPersistenceState = useProjectSafetyStore((state) => state.setPersistenceState);
  const setRecovered = useProjectSafetyStore((state) => state.setRecovered);
  const setFlushProject = useProjectSafetyStore((state) => state.setFlushProject);
  const setRunDestructiveProjectMutation = useProjectSafetyStore((state) => state.setRunDestructiveProjectMutation);

  const openProjectPicker = () => {
    if (criticalProjectWrite) {
      setProjectImportStatus({
        tone: 'error',
        message: 'Please wait for the current local save to finish before opening another project.',
      });
      return;
    }
    setProjectImportStatus(undefined);
    void loadProjectIo();
    fileRef.current?.click();
  };

  /**
   * Start a blank Continuity Stage project. Snapshots the current autosaved project
   * so Project Safety can restore it, then swaps in createDefaultProject().
   */
  const startNewProject = async () => {
    if (criticalProjectWrite || isCreatingNewProject) {
      setProjectImportStatus({
        tone: 'error',
        message: 'Please wait for the current local save to finish before starting a new project.',
      });
      return;
    }
    setIsCreatingNewProject(true);
    setProjectImportStatus(undefined);
    try {
      const controller = persistenceControllerRef.current;
      if (!controller) throw new Error('Project recovery is still starting. Please try again in a moment.');
      const current = useContinuityStore.getState().project;
      await controller.createSnapshot(current, `Before starting a new project (from “${current.name}”)`);
      const fresh = createDefaultProject();
      await controller.commitProject(fresh, {
        kind: 'import',
        reason: `Started new project: ${fresh.name}`,
      });
      controller.ignoreNextProjectChange(fresh);
      setProject(fresh);
      setWorkspace('build');
      setAppMode('continuity');
      closeProjectOverlays();
      setNewProjectConfirmOpen(false);
      setProjectImportStatus({
        tone: 'success',
        message: `Started a new project: ${fresh.name}. Your previous project was saved as a local recovery point.`,
      });
    } catch (error) {
      setProjectImportStatus({
        tone: 'error',
        message: error instanceof Error
          ? `Could not start a new project: ${error.message}`
          : 'Could not start a new project.',
      });
    } finally {
      setIsCreatingNewProject(false);
    }
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const { readProjectFile } = await loadProjectIo();
      const controller = persistenceControllerRef.current;
      if (!controller) throw new Error('Project recovery is still starting. Please try again in a moment.');
      await controller.createSnapshot(useContinuityStore.getState().project, 'Before opening another project');
      const importedProject = await readProjectFile(file);
      // The imported package has been validated before this point. Stage its
      // recovery revision before replacing the live Zustand project.
      await controller.commitProject(importedProject, {
        kind: 'import',
        reason: `Imported project: ${importedProject.name}`,
      });
      controller.ignoreNextProjectChange(importedProject);
      setProject(importedProject);
      setAppMode('continuity');
      setProjectImportStatus({
        tone: 'success',
        message: `Project opened: ${importedProject.name}. Verified locally for recovery.`,
      });
    } catch (error) {
      setProjectImportStatus({
        tone: 'error',
        message: error instanceof Error
          ? `Could not open project: ${error.message}`
          : 'Could not open project: invalid project file.',
      });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const saveProject = () => {
    void (async () => {
      try {
        const controller = persistenceControllerRef.current;
        if (!controller) throw new Error('Project recovery is still starting. Please try again in a moment.');
        const verified = await controller.flushAndLoadActiveRevision('Verified save before backup export');
        if (!verified) throw new Error('No verified project revision is available for backup export.');
        const { downloadProject } = await loadProjectIo();
        await downloadProject(verified.project);
        setProjectImportStatus({
          tone: 'success',
          message: 'Verified project backup downloaded.',
        });
      } catch (error) {
        setProjectImportStatus({
          tone: 'error',
          message: error instanceof Error ? `Could not save project: ${error.message}` : 'Could not save project.',
        });
      }
    })();
  };

  const createProjectSnapshot = async (reason: string) => {
    const controller = persistenceControllerRef.current;
    if (!controller) throw new Error('Project recovery is still starting. Please try again in a moment.');
    await controller.createSnapshot(useContinuityStore.getState().project, reason);
  };

  const restoreProjectSnapshot = async (revisionId: string) => {
    const controller = persistenceControllerRef.current;
    if (!controller) throw new Error('Project recovery is still starting. Please try again in a moment.');
    const { restoreProjectRevision } = await loadProjectSafety();
    const currentProject = useContinuityStore.getState().project;
    const restored = await restoreProjectRevision(currentProject.id, revisionId);
    controller.adoptVerifiedProject(restored.project, {
      revisionId: restored.revision.id,
      savedAt: restored.revision.createdAt,
      message: `Restored recovery point: ${restored.revision.reason}.`,
      recovered: true,
    });
    setProject(restored.project);
    setProjectImportStatus({
      tone: 'success',
      message: `Restored snapshot: ${restored.revision.reason}`,
    });
  };


  const openLocalProjectHistory = async (projectId: string, revisionId: string) => {
    if (projectId === useContinuityStore.getState().project.id) return;
    const controller = persistenceControllerRef.current;
    if (!controller) throw new Error('Project recovery is still starting. Please try again in a moment.');
    await controller.createSnapshot(useContinuityStore.getState().project, 'Before opening another local project');
    const { restoreProjectRevision } = await loadProjectSafety();
    const opened = await restoreProjectRevision(projectId, revisionId);
    controller.adoptVerifiedProject(opened.project, {
      revisionId: opened.revision.id,
      savedAt: opened.revision.createdAt,
      message: `Opened verified local project: ${opened.project.name}.`,
      recovered: true,
    });
    setProject(opened.project);
    setAppMode('continuity');
    setProjectImportStatus({ tone: 'success', message: `Opened local project: ${opened.project.name}.` });
  };

  const removeLocalProjectHistory = async (projectId: string) => {
    if (projectId === useContinuityStore.getState().project.id) {
      throw new Error('Open projects cannot be removed. Open another project first.');
    }
    const { removeLocalProjectHistory: removeHistory } = await loadProjectSafety();
    const result = await removeHistory(projectId, useContinuityStore.getState().project);
    setProjectImportStatus({
      tone: 'success',
      message: `Removed ${result.revisionsRemoved} local recovery revision${result.revisionsRemoved === 1 ? '' : 's'}.`,
    });
  };

  const applyProjectHealthRepair = async (repairedProject: LocationProject) => {
    const controller = persistenceControllerRef.current;
    if (!controller) throw new Error('Project recovery is still starting. Please try again in a moment.');
    await controller.createSnapshot(useContinuityStore.getState().project, 'Before repairing project health');
    await controller.commitProject(repairedProject, {
      kind: 'autosave',
      reason: 'Project health safe repair',
    });
    controller.ignoreNextProjectChange(repairedProject);
    setProject(repairedProject);
    setProjectImportStatus({ tone: 'success', message: 'Safe project health repairs were saved locally.' });
  };

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeAssetFailures: (() => void) | undefined;
    const projectAtStartup = useContinuityStore.getState().project;

    void (async () => {
      try {
        const [persistenceModule, safetyModule, assetStoreModule] = await Promise.all([
          loadProjectPersistence(),
          loadProjectSafety(),
          import('../engine/projectAssetStore'),
        ]);
        if (!active) return;

        const recovered = await safetyModule.recoverLatestProject();
        if (!active) return;
        const controller = new persistenceModule.ProjectPersistenceController({
          onStateChange: setPersistenceState,
        });
        persistenceControllerRef.current = controller;
        setFlushProject((reason) => controller.flushAndLoadActiveRevision(reason));
        setRunDestructiveProjectMutation((reason, mutation) => controller.runDestructiveMutation(
          useContinuityStore.getState().project,
          reason,
          mutation,
          () => useContinuityStore.getState().project,
        ));
        // IndexedDB is otherwise best-effort browser storage. The Health view
        // reports whether this request was granted; a denial never blocks use.
        void safetyModule.requestPersistentProjectStorage();

        const currentProject = useContinuityStore.getState().project;
        if (recovered && currentProject === projectAtStartup) {
          controller.start(recovered.project, {
            recovered: true,
            revisionId: recovered.revision.id,
            savedAt: recovered.revision.createdAt,
          });
          setProject(recovered.project);
          setAppMode('continuity');
          setRecovered({
            message: recovered.recoveredPreviousRevision
              ? 'Recovered the previous verified project revision after finding an incomplete save.'
              : 'Recovered the latest verified local project.',
            revisionId: recovered.revision.id,
            savedAt: recovered.revision.createdAt,
          });
        } else {
          controller.start(currentProject);
        }

        unsubscribe = useContinuityStore.subscribe((next, previous) => {
          if (next.project !== previous.project) controller.noteProjectChange(next.project, previous.project);
        });
        unsubscribeAssetFailures = assetStoreModule.subscribeProjectAssetPersistenceFailures((event) => {
          controller.reportAssetPersistenceFailure(event.error);
        });
      } catch (error) {
        setPersistenceState({
          status: 'failed',
          message: error instanceof Error
            ? `Local recovery could not start: ${error.message}`
            : 'Local recovery could not start.',
          criticalWrite: false,
        });
      }
    })();

    return () => {
      active = false;
      unsubscribe?.();
      unsubscribeAssetFailures?.();
      setFlushProject(undefined);
      setRunDestructiveProjectMutation(undefined);
      persistenceControllerRef.current?.dispose();
      persistenceControllerRef.current = undefined;
    };
  }, [setAppMode, setFlushProject, setPersistenceState, setProject, setRecovered, setRunDestructiveProjectMutation]);

  useEffect(() => {
    const preventUnsafeClose = (event: BeforeUnloadEvent) => {
      if (!criticalProjectWrite && projectSaveStatus !== 'unsaved' && projectSaveStatus !== 'saving' && projectSaveStatus !== 'failed') return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnsafeClose);
    return () => window.removeEventListener('beforeunload', preventUnsafeClose);
  }, [criticalProjectWrite, projectSaveStatus]);

  useEffect(() => {
    if (!projectImportStatus) return;
    const timer = window.setTimeout(() => setProjectImportStatus(undefined), IMPORT_STATUS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [projectImportStatus]);

  return {
    fileRef,
    projectImportStatus,
    setProjectImportStatus,
    newProjectConfirmOpen,
    setNewProjectConfirmOpen,
    isCreatingNewProject,
    openProjectPicker,
    importProject,
    saveProject,
    startNewProject,
    createProjectSnapshot,
    restoreProjectSnapshot,
    openLocalProjectHistory,
    removeLocalProjectHistory,
    applyProjectHealthRepair,
  };
}

