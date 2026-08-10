import { useSyncExternalStore } from 'react';
import { subscribeBackgroundVideoRuntime } from '../engine/backgroundVideoService';
import { subscribeStillArtifactRuntime } from '../engine/stillArtifactRuntime';

const listeners = new Set<() => void>();
let version = 0;
let unsubscribeStill: (() => void) | undefined;
let unsubscribeVideo: (() => void) | undefined;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function startRuntimeSubscriptions(): void {
  if (unsubscribeStill || unsubscribeVideo) return;
  unsubscribeStill = subscribeStillArtifactRuntime(publish);
  unsubscribeVideo = subscribeBackgroundVideoRuntime(publish);
}

function stopRuntimeSubscriptions(): void {
  if (listeners.size > 0) return;
  unsubscribeStill?.();
  unsubscribeVideo?.();
  unsubscribeStill = undefined;
  unsubscribeVideo = undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startRuntimeSubscriptions();
  return () => {
    listeners.delete(listener);
    stopRuntimeSubscriptions();
  };
}

function getSnapshot(): number {
  return version;
}

function getServerSnapshot(): number {
  return 0;
}

/**
 * Event-driven bridge for non-persisted prepared-media runtime maps.
 * Project mutations already rerender cards through Zustand/props; this only wakes
 * the UI for queued/rendering/error/video-status transitions outside project JSON.
 */
export function usePreparedMediaRuntimeTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
