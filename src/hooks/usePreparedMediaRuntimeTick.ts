import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function startClock(): void {
  if (timer || typeof window === 'undefined') return;
  timer = window.setInterval(() => {
    version += 1;
    for (const listener of listeners) listener();
  }, 400);
}

function stopClock(): void {
  if (!timer || listeners.size > 0) return;
  clearInterval(timer);
  timer = undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startClock();
  return () => {
    listeners.delete(listener);
    stopClock();
  };
}

function getSnapshot(): number {
  return version;
}

function getServerSnapshot(): number {
  return 0;
}

/**
 * One shared lightweight clock for non-persisted prepared-media runtime maps.
 * Keeps shot cards responsive to queued/rendering/error transitions without
 * putting ephemeral job state into the project document.
 */
export function usePreparedMediaRuntimeTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
