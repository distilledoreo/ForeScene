/**
 * Mounted workspace services for operations that need React/Three.js.
 * Core command engine must not import workspace components.
 */

import type { ForeSceneRuntimeServices } from './protocol';

let services: ForeSceneRuntimeServices = {};

export function registerForeSceneRuntimeServices(
  next: Partial<ForeSceneRuntimeServices>,
): void {
  services = { ...services, ...next };
}

export function unregisterForeSceneRuntimeServices(
  keys: Array<keyof ForeSceneRuntimeServices>,
): void {
  const next = { ...services };
  for (const key of keys) {
    delete next[key];
  }
  services = next;
}

export function getForeSceneRuntimeServices(): ForeSceneRuntimeServices {
  return services;
}

/** Test helper — clears all registered runtime services. */
export function resetForeSceneRuntimeServices(): void {
  services = {};
}
