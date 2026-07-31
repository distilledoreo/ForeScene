/**
 * Lightweight viewport readiness tracking for Agent waitForViewportReady.
 * SceneViewport reports render completions; the Agent API polls stable state.
 */

export interface ViewportReadinessSnapshot {
  workspace?: string;
  selectedShotId?: string | null;
  canvasWidth: number;
  canvasHeight: number;
  canvasInitialized: boolean;
  sceneRenderGeneration: number;
  lastRenderShotId?: string | null;
  lastRenderAt?: number;
  projectRevisionId?: string;
  loading: boolean;
}

let snapshot: ViewportReadinessSnapshot = {
  canvasWidth: 0,
  canvasHeight: 0,
  canvasInitialized: false,
  sceneRenderGeneration: 0,
  loading: false,
};

const listeners = new Set<() => void>();

export function getViewportReadinessSnapshot(): ViewportReadinessSnapshot {
  return { ...snapshot };
}

export function subscribeViewportReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors.
    }
  }
}

export function reportViewportMounted(params: {
  workspace?: string;
  canvasWidth: number;
  canvasHeight: number;
}): void {
  snapshot = {
    ...snapshot,
    workspace: params.workspace ?? snapshot.workspace,
    canvasWidth: params.canvasWidth,
    canvasHeight: params.canvasHeight,
    canvasInitialized: params.canvasWidth > 0 && params.canvasHeight > 0,
  };
  emit();
}

export function reportViewportUnmounted(): void {
  snapshot = {
    ...snapshot,
    canvasWidth: 0,
    canvasHeight: 0,
    canvasInitialized: false,
  };
  emit();
}

export function reportViewportSceneRender(params: {
  shotId?: string | null;
  canvasWidth: number;
  canvasHeight: number;
  workspace?: string;
  projectRevisionId?: string;
  loading?: boolean;
}): void {
  snapshot = {
    ...snapshot,
    workspace: params.workspace ?? snapshot.workspace,
    selectedShotId: params.shotId ?? snapshot.selectedShotId,
    canvasWidth: params.canvasWidth,
    canvasHeight: params.canvasHeight,
    canvasInitialized: params.canvasWidth > 0 && params.canvasHeight > 0,
    sceneRenderGeneration: snapshot.sceneRenderGeneration + 1,
    lastRenderShotId: params.shotId ?? snapshot.lastRenderShotId,
    lastRenderAt: Date.now(),
    projectRevisionId: params.projectRevisionId ?? snapshot.projectRevisionId,
    loading: params.loading ?? false,
  };
  emit();
}

export function reportViewportSelection(params: {
  workspace?: string;
  selectedShotId?: string | null;
  projectRevisionId?: string;
  loading?: boolean;
}): void {
  snapshot = {
    ...snapshot,
    workspace: params.workspace ?? snapshot.workspace,
    selectedShotId: params.selectedShotId ?? snapshot.selectedShotId,
    projectRevisionId: params.projectRevisionId ?? snapshot.projectRevisionId,
    loading: params.loading ?? snapshot.loading,
  };
  emit();
}

/** Test helper. */
export function resetViewportReadiness(): void {
  snapshot = {
    canvasWidth: 0,
    canvasHeight: 0,
    canvasInitialized: false,
    sceneRenderGeneration: 0,
    loading: false,
  };
}
