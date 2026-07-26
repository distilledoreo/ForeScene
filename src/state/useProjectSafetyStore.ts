import { create } from 'zustand';
import type { ProjectPersistenceState } from '../engine/projectPersistenceController';
import type { ProjectSaveStatus } from '../engine/projectSafety';

interface ProjectSafetyStore {
  status: ProjectSaveStatus;
  message?: string;
  lastSavedAt?: string;
  activeRevisionId?: string;
  criticalWrite: boolean;
  flushProject?: (reason?: string) => Promise<void>;
  setPersistenceState: (state: ProjectPersistenceState) => void;
  setRecovered: (state: { message: string; revisionId?: string; savedAt?: string }) => void;
  setFlushProject: (flushProject?: (reason?: string) => Promise<void>) => void;
}

export const useProjectSafetyStore = create<ProjectSafetyStore>((set) => ({
  status: 'unsaved',
  criticalWrite: false,
  flushProject: undefined,
  setPersistenceState: (state) => set({
    status: state.status,
    message: state.message,
    lastSavedAt: state.lastSavedAt,
    activeRevisionId: state.activeRevisionId,
    criticalWrite: state.criticalWrite,
  }),
  setRecovered: (state) => set({
    status: 'recovered',
    message: state.message,
    lastSavedAt: state.savedAt,
    activeRevisionId: state.revisionId,
    criticalWrite: false,
  }),
  setFlushProject: (flushProject) => set({ flushProject }),
}));
