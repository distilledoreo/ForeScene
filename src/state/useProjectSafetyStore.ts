import { create } from 'zustand';
import type { ProjectPersistenceState, VerifiedProjectRevision } from '../engine/projectPersistenceController';
import type { ProjectSaveStatus } from '../engine/projectSafety';

interface ProjectSafetyStore {
  status: ProjectSaveStatus;
  message?: string;
  lastSavedAt?: string;
  activeRevisionId?: string;
  criticalWrite: boolean;
  flushProject?: (reason?: string) => Promise<VerifiedProjectRevision | undefined>;
  runDestructiveProjectMutation?: (reason: string, mutation: () => void | Promise<void>) => Promise<VerifiedProjectRevision | undefined>;
  setPersistenceState: (state: ProjectPersistenceState) => void;
  setRecovered: (state: { message: string; revisionId?: string; savedAt?: string }) => void;
  setFlushProject: (flushProject?: (reason?: string) => Promise<VerifiedProjectRevision | undefined>) => void;
  setRunDestructiveProjectMutation: (
    runDestructiveProjectMutation?: (reason: string, mutation: () => void | Promise<void>) => Promise<VerifiedProjectRevision | undefined>,
  ) => void;
}

export const useProjectSafetyStore = create<ProjectSafetyStore>((set) => ({
  status: 'unsaved',
  criticalWrite: false,
  flushProject: undefined,
  runDestructiveProjectMutation: undefined,
  setPersistenceState: (state) => set((current) => ({
    status: state.status,
    message: state.message,
    lastSavedAt: state.lastSavedAt ?? current.lastSavedAt,
    activeRevisionId: state.activeRevisionId ?? current.activeRevisionId,
    criticalWrite: state.criticalWrite,
  })),
  setRecovered: (state) => set((current) => ({
    status: 'recovered',
    message: state.message,
    lastSavedAt: state.savedAt ?? current.lastSavedAt,
    activeRevisionId: state.revisionId ?? current.activeRevisionId,
    criticalWrite: false,
  })),
  setFlushProject: (flushProject) => set({ flushProject }),
  setRunDestructiveProjectMutation: (runDestructiveProjectMutation) => set({ runDestructiveProjectMutation }),
}));
