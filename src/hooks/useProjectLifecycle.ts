import { useEffect, useRef, useState } from 'react';

import type { LocationProject } from '../domain/types';
import { createDefaultProject } from '../domain/defaults';
import { createBlankGrayboxProject } from '../engine/previs/blankProject';
import { loadSampleProject as loadBundledSample } from '../engine/sampleProjects';
import type { CompiledSetBlueprint } from '../engine/setBlueprintCompiler';
import type { ProjectPersistenceController } from '../engine/projectPersistenceController';
import { useAppModeStore } from '../state/useAppModeStore';
import { useProjectStore } from '../state/useProjectStore';
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
  tone: 'success' | 'warning' | 'error';
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
  /** Resolves once the persistence controller has a verified startup baseline. */
  const controllerReadyPromiseRef = useRef<Promise<ProjectPersistenceController> | undefined>(undefined);
  const resolveControllerReadyRef = useRef<((controller: ProjectPersistenceController) => void) | undefined>(undefined);
  const [projectLifecycleReady, setProjectLifecycleReady] = useState(false);
  const [projectImportStatus, setProjectImportStatus] = useState<ProjectImportStatus>();
  const [newProjectConfirmOpen, setNewProjectConfirmOpen] = useState(false);
  const [isCreatingNewProject, setIsCreatingNewProject] = useState(false);

  const setAppMode = useAppModeStore((state) => state.setAppMode);
  const setProject = useProjectStore((state) => state.setProject);
  const setWorkspace = useProjectStore((state) => state.setWorkspace);
  const criticalProjectWrite = useProjectSafetyStore((state) => state.criticalWrite);
  const projectSaveStatus = useProjectSafetyStore((state) => state.status);
  const setPersistenceState = useProjectSafetyStore((state) => state.setPersistenceState);
  const setRecovered = useProjectSafetyStore((state) => state.setRecovered);
  const setFlushProject = useProjectSafetyStore((state) => state.setFlushProject);
  const setRunDestructiveProjectMutation = useProjectSafetyStore((state) => state.setRunDestructiveProjectMutation);

  /** Await the live persistence controller — never throw “still starting” to fast clickers. */
  const awaitPersistenceController = async (): Promise<ProjectPersistenceController> => {
    const live = persistenceControllerRef.current;
    if (live) return live;
    if (!controllerReadyPromiseRef.current) {
      controllerReadyPromiseRef.current = new Promise<ProjectPersistenceController>((resolve) => {
        resolveControllerReadyRef.current = resolve;
      });
    }
    return controllerReadyPromiseRef.current;
  };

  /** Wait for the live controller and any critical local write to become idle. */
  const awaitProjectWriteIdle = async (): Promise<void> => {
    await awaitPersistenceController();

    if (!useProjectSafetyStore.getState().criticalWrite) return;

    await new Promise<void>((resolve) => {
      const unsubscribe = useProjectSafetyStore.subscribe((state) => {
        if (!state.criticalWrite) {
          unsubscribe();
          resolve();
        }
      });
    });
  };

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
   * Replace the live project with a committed document (snapshot → commit → set).
   * Shared by new project, sample load, and launcher manual starts.
   * Waits for persistence readiness so a fast launcher click never races startup.
   */
  const commitAndActivateProject = async (
    next: LocationProject,
    reason: string,
    successMessage: string,
  ) => {
    await awaitProjectWriteIdle();
    const controller = await awaitPersistenceController();
    const current = useProjectStore.getState().project;
    await controller.createSnapshot(current, `Before: ${reason}`);
    await controller.commitProject(next, {
      kind: 'import',
      reason,
    });
    controller.ignoreNextProjectChange(next);
    setProject(next);
    useProjectStore.getState().clearObjectSelection();
    setWorkspace('build');
    setAppMode('studio');
    closeProjectOverlays();
    setNewProjectConfirmOpen(false);
    setProjectImportStatus({
      tone: 'success',
      message: successMessage,
    });
  };

  /**
   * Start a blank ForeScene project. Snapshots the current autosaved project
   * so Project Safety can restore it, then swaps in a blank graybox shell
   * (launcher can reappear for first-project guidance).
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
      const fresh = createBlankGrayboxProject({
        name: 'Untitled Production',
        description: '',
        aspectRatio: '16:9',
      });
      await commitAndActivateProject(
        fresh,
        `Started new project: ${fresh.name}`,
        `Started a new project: ${fresh.name}. Your previous project was saved as a local recovery point.`,
      );
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

  /**
   * Load a bundled sample production (fresh factory copy every time).
   * @returns true when the sample was activated successfully.
   */
  const loadSampleProject = async (sampleId: string): Promise<boolean> => {
    setProjectImportStatus(undefined);
    try {
      const sample = loadBundledSample(sampleId);
      await commitAndActivateProject(
        sample,
        `Loaded sample: ${sample.name}`,
        `Opened sample “${sample.name}”. Explore Build → Reference → Shots → Export. Use Reset sample anytime to restore the baseline.`,
      );
      return true;
    } catch (error) {
      setProjectImportStatus({
        tone: 'error',
        message: error instanceof Error
          ? `Could not load sample: ${error.message}`
          : 'Could not load sample.',
      });
      return false;
    }
  };

  /** Reset the active sample from the canonical factory. */
  const resetSampleProject = async (sampleId: string): Promise<boolean> => {
    return loadSampleProject(sampleId);
  };

  /**
   * Start the temple starter set (legacy default project content).
   * @returns true when activated successfully.
   */
  const startStarterProject = async (): Promise<boolean> => {
    if (criticalProjectWrite) {
      setProjectImportStatus({
        tone: 'error',
        message: 'Please wait for the current local save to finish before starting a project.',
      });
      return false;
    }
    setProjectImportStatus(undefined);
    try {
      const fresh = createDefaultProject();
      fresh.name = 'Temple Starter';
      fresh.description = 'Courtyard starter set with scale figure — ready to frame shots.';
      await commitAndActivateProject(
        fresh,
        `Started temple starter: ${fresh.name}`,
        `Started “${fresh.name}”. Build on the courtyard set or replace geometry as needed.`,
      );
      return true;
    } catch (error) {
      setProjectImportStatus({
        tone: 'error',
        message: error instanceof Error
          ? `Could not start starter project: ${error.message}`
          : 'Could not start starter project.',
      });
      return false;
    }
  };

  /**
   * Start a blank graybox without the new-project confirm flow (launcher path).
   * Stays effectively blank — callers that need Build without the launcher should
   * dismiss only after this returns true.
   * @returns true when activated successfully.
   */
  const startBlankProject = async (): Promise<boolean> => {
    if (criticalProjectWrite) {
      setProjectImportStatus({
        tone: 'error',
        message: 'Please wait for the current local save to finish before starting a project.',
      });
      return false;
    }
    setProjectImportStatus(undefined);
    try {
      const fresh = createBlankGrayboxProject({
        name: 'Untitled Production',
        description: '',
        aspectRatio: '16:9',
      });
      await commitAndActivateProject(
        fresh,
        `Started blank project: ${fresh.name}`,
        `Started a blank graybox set. Add architecture, characters, and shots from Build.`,
      );
      return true;
    } catch (error) {
      setProjectImportStatus({
        tone: 'error',
        message: error instanceof Error
          ? `Could not start blank project: ${error.message}`
          : 'Could not start blank project.',
      });
      return false;
    }
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const { readProjectFileWithWarnings } = await loadProjectIo();
      const controller = await awaitPersistenceController();
      await controller.createSnapshot(useProjectStore.getState().project, 'Before opening another project');
      const opened = await readProjectFileWithWarnings(file);
      const importedProject = opened.project;
      // Stage the parsed project and any recoverable asset warnings before
      // replacing the live Zustand project.
      await controller.commitProject(importedProject, {
        kind: 'import',
        reason: `Imported project: ${importedProject.name}`,
      });
      controller.ignoreNextProjectChange(importedProject);
      setProject(importedProject);
      setAppMode('studio');
      setProjectImportStatus({
        tone: opened.warnings.length > 0 ? 'warning' : 'success',
        message: opened.warnings.length > 0
          ? `Project opened with ${opened.warnings.length} missing or unavailable asset${opened.warnings.length === 1 ? '' : 's'}. References were preserved; review Missing Assets.`
          : `Project opened: ${importedProject.name}. Verified locally for recovery.`,
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
        const controller = await awaitPersistenceController();
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
    const controller = await awaitPersistenceController();
    await controller.createSnapshot(useProjectStore.getState().project, reason);
  };

  const restoreProjectSnapshot = async (revisionId: string) => {
    const controller = await awaitPersistenceController();
    const { restoreProjectRevision } = await loadProjectSafety();
    const currentProject = useProjectStore.getState().project;
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
    if (projectId === useProjectStore.getState().project.id) return;
    const controller = await awaitPersistenceController();
    await controller.createSnapshot(useProjectStore.getState().project, 'Before opening another local project');
    const { restoreProjectRevision } = await loadProjectSafety();
    const opened = await restoreProjectRevision(projectId, revisionId);
    controller.adoptVerifiedProject(opened.project, {
      revisionId: opened.revision.id,
      savedAt: opened.revision.createdAt,
      message: `Opened verified local project: ${opened.project.name}.`,
      recovered: true,
    });
    setProject(opened.project);
    setAppMode('studio');
    setProjectImportStatus({ tone: 'success', message: `Opened local project: ${opened.project.name}.` });
  };

  const removeLocalProjectHistory = async (projectId: string) => {
    if (projectId === useProjectStore.getState().project.id) {
      throw new Error('Open projects cannot be removed. Open another project first.');
    }
    const { removeLocalProjectHistory: removeHistory } = await loadProjectSafety();
    const result = await removeHistory(projectId, useProjectStore.getState().project);
    setProjectImportStatus({
      tone: 'success',
      message: `Removed ${result.revisionsRemoved} local recovery revision${result.revisionsRemoved === 1 ? '' : 's'}.`,
    });
  };

  const applyProjectHealthRepair = async (repairedProject: LocationProject) => {
    const controller = await awaitPersistenceController();
    await controller.createSnapshot(useProjectStore.getState().project, 'Before repairing project health');
    await controller.commitProject(repairedProject, {
      kind: 'autosave',
      reason: 'Project health safe repair',
    });
    controller.ignoreNextProjectChange(repairedProject);
    setProject(repairedProject);
    setProjectImportStatus({ tone: 'success', message: 'Safe project health repairs were saved locally.' });
  };

  /**
   * Replace the live project with a compiled SetBlueprint result.
   * Mirrors new-project / import-project: snapshot → commit → ignore subscription → setProject.
   */
  const createProjectFromBlueprint = async (compiled: CompiledSetBlueprint) => {
    if (criticalProjectWrite) {
      throw new Error('Please wait for the current local save to finish before creating a generated set.');
    }
    const controller = await awaitPersistenceController();

    const current = useProjectStore.getState().project;
    const next = compiled.project;
    await controller.createSnapshot(
      current,
      `Before creating AI-generated set “${next.name}”`,
    );
    await controller.commitProject(next, {
      kind: 'import',
      reason: `Created AI-generated set: ${next.name}`,
    });
    controller.ignoreNextProjectChange(next);
    setProject(next);
    useProjectStore.getState().clearObjectSelection();
    setWorkspace('build');
    setAppMode('studio');
    closeProjectOverlays();

    const objectCount = next.scene.objects.length;
    const landmarkCount = next.landmarks.length;
    setProjectImportStatus({
      tone: 'success',
      message: `Created “${next.name}” with ${objectCount} object${objectCount === 1 ? '' : 's'} and ${landmarkCount} landmark${landmarkCount === 1 ? '' : 's'}.`,
    });
  };

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeAssetFailures: (() => void) | undefined;
    const projectAtStartup = useProjectStore.getState().project;

    // Fresh readiness gate for this mount (callers can await immediately).
    setProjectLifecycleReady(false);
    controllerReadyPromiseRef.current = new Promise<ProjectPersistenceController>((resolve) => {
      resolveControllerReadyRef.current = resolve;
    });

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
        setFlushProject((reason) => controller.flushCurrentProject(
          useProjectStore.getState().project,
          reason,
        ));
        setRunDestructiveProjectMutation((reason, mutation) => controller.runDestructiveMutation(
          useProjectStore.getState().project,
          reason,
          mutation,
          () => useProjectStore.getState().project,
        ));
        // IndexedDB is otherwise best-effort browser storage. The Health view
        // reports whether this request was granted; a denial never blocks use.
        void safetyModule.requestPersistentProjectStorage();

        const currentProject = useProjectStore.getState().project;
        if (recovered && currentProject === projectAtStartup) {
          controller.start(recovered.project, {
            recovered: true,
            revisionId: recovered.revision.id,
            savedAt: recovered.revision.createdAt,
          });
          setProject(recovered.project);
          setAppMode('studio');
          setRecovered({
            message: recovered.recoveredPreviousRevision
              ? 'Recovered the previous verified project revision after finding an incomplete save.'
              : 'Recovered the latest verified local project.',
            revisionId: recovered.revision.id,
            savedAt: recovered.revision.createdAt,
          });
        } else {
          controller.start(currentProject);
          // Do not expose project-replacement actions during the scheduled
          // initial-save window. Establish a verified recovery baseline first.
          const verified = await controller.flushAndLoadActiveRevision(
            'Initial local recovery save',
          );
          if (!active || !verified) return;
        }

        // Unblock sample load / import / new-project callers only after the
        // controller is started and the initial project revision is verified.
        resolveControllerReadyRef.current?.(controller);
        setProjectLifecycleReady(true);

        unsubscribe = useProjectStore.subscribe((next, previous) => {
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
        setProjectLifecycleReady(false);
      }
    })();

    return () => {
      active = false;
      unsubscribe?.();
      unsubscribeAssetFailures?.();
      setFlushProject(undefined);
      setRunDestructiveProjectMutation(undefined);
      setProjectLifecycleReady(false);
      persistenceControllerRef.current?.dispose();
      persistenceControllerRef.current = undefined;
      resolveControllerReadyRef.current = undefined;
      controllerReadyPromiseRef.current = undefined;
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
    /** True once local persistence has started and project swaps are safe. */
    projectLifecycleReady,
    openProjectPicker,
    importProject,
    saveProject,
    startNewProject,
    startBlankProject,
    startStarterProject,
    loadSampleProject,
    resetSampleProject,
    createProjectSnapshot,
    restoreProjectSnapshot,
    openLocalProjectHistory,
    removeLocalProjectHistory,
    applyProjectHealthRepair,
    createProjectFromBlueprint,
  };
}

