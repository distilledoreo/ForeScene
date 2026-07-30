import { create } from 'zustand';
import { BRAND, readMigratedPreference, writePreference } from '../config/brand';

export type AppMode = 'studio' | 'panoViewer';

function readStoredMode(): AppMode | null {
  const value = readMigratedPreference(BRAND.prefs.appMode, BRAND.legacyPrefs.appMode);
  if (value === 'panoViewer') return 'panoViewer';
  // Pre-rebrand installs stored the studio mode as 'continuity'.
  if (value === 'continuity') {
    writePreference(BRAND.prefs.appMode, 'studio');
    return 'studio';
  }
  if (value === 'studio') return 'studio';
  return null;
}

function writeStoredMode(mode: AppMode) {
  writePreference(BRAND.prefs.appMode, mode);
}

interface AppModeState {
  /** null = user has not chosen a mode yet this install/session */
  appMode: AppMode | null;
  setAppMode: (mode: AppMode) => void;
}

const initialMode = readStoredMode();

export const useAppModeStore = create<AppModeState>((set) => ({
  appMode: initialMode,
  setAppMode: (mode) => {
    writeStoredMode(mode);
    set({ appMode: mode });
  },
}));
