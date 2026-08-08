import type { LocationProject } from '../domain/types';

export interface LiveProjectAccess {
  getProject: () => LocationProject;
  commitProject: (updater: (live: LocationProject) => LocationProject) => LocationProject;
}

let activeAccess: LiveProjectAccess | undefined;

/**
 * Bind the single active-project store at the application boundary. Engine code
 * can use this only as an optional fallback when an explicit live accessor was
 * not threaded through a call (notably the legacy V2 package writer).
 */
export function bindLiveProjectAccess(access: LiveProjectAccess): () => void {
  activeAccess = access;
  return () => {
    if (activeAccess === access) activeAccess = undefined;
  };
}

export function getLiveProjectAccess(): LiveProjectAccess | undefined {
  return activeAccess;
}

export function resetLiveProjectAccessForTests(): void {
  activeAccess = undefined;
}
