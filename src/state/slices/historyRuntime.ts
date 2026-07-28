import type { LocationProject, SceneObject, Vec3 } from '../../domain/types';
import {
  BUILD_HISTORY_COALESCE_MS,
  type BuildHistoryMode,
  type BuildHistorySnapshot,
  buildSnapshotsEqual,
  captureBuildSnapshot,
  pushBuildHistoryPast,
} from '../../engine/buildHistory';
import { normalizeSelectedIds } from '../../engine/buildSelectionMath';

type ContinuitySet = (
  partial: Record<string, unknown> | ((state: any) => Record<string, unknown>),
) => void;
type ContinuityGet = () => any;

export type BuildHistoryStateSlice = {
  project: LocationProject;
  selectedObjectIds: string[];
  buildHistoryPast: BuildHistorySnapshot[];
  buildHistoryFuture: BuildHistorySnapshot[];
  buildHistoryBatchDepth: number;
  buildHistoryBatchCaptured: boolean;
  buildHistoryCoalesceActive: boolean;
};

export type BuildHistoryPatch = Partial<Pick<
  BuildHistoryStateSlice,
  | 'buildHistoryPast'
  | 'buildHistoryFuture'
  | 'buildHistoryBatchCaptured'
  | 'buildHistoryCoalesceActive'
>>;

export type HistoryRuntime = {
  /** True while applyBuildSnapshot is restoring scene state. */
  isBuildHistoryRestoring: () => boolean;
  /** True while shot-camera undo/redo applies silent updateShot. */
  isShotCameraHistoryRestoring: () => boolean;
  setShotCameraHistoryRestoring: (value: boolean) => void;
  clearBuildHistoryCoalesceTimer: () => void;
  captureCurrentBuildSnapshot: (state: {
    project: LocationProject;
    selectedObjectIds: string[];
  }) => BuildHistorySnapshot;
  historyPatchBeforeMutation: (
    state: BuildHistoryStateSlice,
    mode?: BuildHistoryMode,
  ) => BuildHistoryPatch;
  applyBuildSceneChange: (
    state: BuildHistoryStateSlice,
    change: {
      objects?: SceneObject[];
      assets?: LocationProject['assets'];
      panoOrigin?: Vec3;
      panoRotation?: [number, number, number];
      selectedObjectIds?: string[];
      history?: BuildHistoryMode;
      extra?: Record<string, unknown>;
    },
  ) => BuildHistoryStateSlice | Record<string, unknown>;
  applyBuildSnapshot: (
    snapshot: BuildHistorySnapshot,
    past: BuildHistorySnapshot[],
    future: BuildHistorySnapshot[],
  ) => void;
};

function touchProject(project: LocationProject): LocationProject {
  return { ...project, updatedAt: new Date().toISOString() };
}

/**
 * Per-store history runtime (timer + restore flags), keyed by Zustand set identity.
 * Independent store instances do not share coalesce timers or restoring flags.
 */
const runtimeBySet = new WeakMap<object, HistoryRuntime>();

export function getHistoryRuntime(set: ContinuitySet, get: ContinuityGet): HistoryRuntime {
  const key = set as object;
  const existing = runtimeBySet.get(key);
  if (existing) return existing;

  let buildHistoryCoalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let buildHistoryRestoring = false;
  let shotCameraHistoryRestoring = false;

  const clearBuildHistoryCoalesceTimer = () => {
    if (buildHistoryCoalesceTimer) {
      clearTimeout(buildHistoryCoalesceTimer);
      buildHistoryCoalesceTimer = undefined;
    }
  };

  const scheduleCoalesceRelease = () => {
    clearBuildHistoryCoalesceTimer();
    buildHistoryCoalesceTimer = setTimeout(() => {
      buildHistoryCoalesceTimer = undefined;
      set({ buildHistoryCoalesceActive: false });
    }, BUILD_HISTORY_COALESCE_MS);
  };

  const captureCurrentBuildSnapshot = (state: {
    project: LocationProject;
    selectedObjectIds: string[];
  }): BuildHistorySnapshot => captureBuildSnapshot({
    objects: state.project.scene.objects,
    panoOrigin: state.project.scene.panoOrigin,
    panoRotation: state.project.scene.panoRotation,
    selectedObjectIds: state.selectedObjectIds,
  });

  const historyPatchBeforeMutation = (
    state: BuildHistoryStateSlice,
    mode: BuildHistoryMode = 'step',
  ): BuildHistoryPatch => {
    if (buildHistoryRestoring || mode === 'silent') return {};

    // Open drag batch always wins over per-call mode.
    const effectiveMode: BuildHistoryMode = state.buildHistoryBatchDepth > 0 ? 'batch' : mode;

    if (effectiveMode === 'batch') {
      if (state.buildHistoryBatchCaptured) return {};
    } else if (effectiveMode === 'coalesce') {
      if (state.buildHistoryCoalesceActive) {
        scheduleCoalesceRelease();
        return {};
      }
    } else {
      // step: end any open coalesce window so the next field edit starts fresh
      clearBuildHistoryCoalesceTimer();
    }

    const stacks = pushBuildHistoryPast(
      { past: state.buildHistoryPast, future: state.buildHistoryFuture },
      captureCurrentBuildSnapshot(state),
    );

    if (effectiveMode === 'batch') {
      return {
        buildHistoryPast: stacks.past,
        buildHistoryFuture: stacks.future,
        buildHistoryBatchCaptured: true,
      };
    }

    if (effectiveMode === 'coalesce') {
      scheduleCoalesceRelease();
      return {
        buildHistoryPast: stacks.past,
        buildHistoryFuture: stacks.future,
        buildHistoryCoalesceActive: true,
      };
    }

    return {
      buildHistoryPast: stacks.past,
      buildHistoryFuture: stacks.future,
      buildHistoryCoalesceActive: false,
    };
  };

  const applyBuildSceneChange = (
    state: BuildHistoryStateSlice,
    change: {
      objects?: SceneObject[];
      assets?: LocationProject['assets'];
      panoOrigin?: Vec3;
      panoRotation?: [number, number, number];
      selectedObjectIds?: string[];
      history?: BuildHistoryMode;
      extra?: Record<string, unknown>;
    },
  ) => {
    const objects = change.objects ?? state.project.scene.objects;
    const assets = change.assets ?? state.project.assets;
    const panoOrigin = change.panoOrigin ?? state.project.scene.panoOrigin;
    const panoRotation = change.panoRotation ?? state.project.scene.panoRotation;
    const selectedObjectIds = Object.prototype.hasOwnProperty.call(change, 'selectedObjectIds')
      ? normalizeSelectedIds(change.selectedObjectIds ?? [], objects)
      : normalizeSelectedIds(state.selectedObjectIds, objects);

    const nextSnap = captureBuildSnapshot({
      objects,
      panoOrigin,
      panoRotation,
      selectedObjectIds,
    });
    const currentSnap = captureCurrentBuildSnapshot(state);
    if (buildSnapshotsEqual(currentSnap, nextSnap)) {
      return state;
    }

    const history = historyPatchBeforeMutation(state, change.history ?? 'step');
    return {
      ...history,
      ...change.extra,
      selectedObjectIds,
      project: touchProject({
        ...state.project,
        assets,
        scene: {
          ...state.project.scene,
          objects,
          panoOrigin,
          panoRotation,
        },
      }),
    };
  };

  const applyBuildSnapshot = (
    snapshot: BuildHistorySnapshot,
    past: BuildHistorySnapshot[],
    future: BuildHistorySnapshot[],
  ) => {
    buildHistoryRestoring = true;
    clearBuildHistoryCoalesceTimer();
    try {
      set((state) => ({
        buildHistoryPast: past,
        buildHistoryFuture: future,
        buildHistoryCoalesceActive: false,
        selectedObjectIds: normalizeSelectedIds(snapshot.selectedObjectIds, snapshot.objects),
        project: touchProject({
          ...state.project,
          scene: {
            ...state.project.scene,
            objects: snapshot.objects,
            panoOrigin: snapshot.panoOrigin,
            panoRotation: snapshot.panoRotation,
          },
        }),
      }));
    } finally {
      buildHistoryRestoring = false;
    }
  };

  const runtime: HistoryRuntime = {
    isBuildHistoryRestoring: () => buildHistoryRestoring,
    isShotCameraHistoryRestoring: () => shotCameraHistoryRestoring,
    setShotCameraHistoryRestoring: (value) => {
      shotCameraHistoryRestoring = value;
    },
    clearBuildHistoryCoalesceTimer,
    captureCurrentBuildSnapshot,
    historyPatchBeforeMutation,
    applyBuildSceneChange,
    applyBuildSnapshot,
  };

  runtimeBySet.set(key, runtime);
  // Touch get so callers that only pass set still type-check; get is used by slices.
  void get;
  return runtime;
}
