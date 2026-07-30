import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRAND,
  isProjectBackupFileName,
  projectBackupAcceptAttribute,
  projectDownloadFileName,
  readMigratedPreference,
} from '../src/config/brand';

/** Minimal localStorage so preference migration can be exercised outside a browser. */
function installFakeStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  vi.stubGlobal('window', { localStorage });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ForeScene preference migration', () => {
  it('prefers the ForeScene key when both keys are present', () => {
    installFakeStorage({
      [BRAND.prefs.theme]: 'dark',
      [BRAND.legacyPrefs.theme]: 'light',
    });
    expect(readMigratedPreference(BRAND.prefs.theme, BRAND.legacyPrefs.theme)).toBe('dark');
  });

  it('carries a legacy PanoRef value forward onto the ForeScene key', () => {
    const store = installFakeStorage({ [BRAND.legacyPrefs.theme]: 'dark' });
    expect(readMigratedPreference(BRAND.prefs.theme, BRAND.legacyPrefs.theme)).toBe('dark');
    expect(store.get(BRAND.prefs.theme)).toBe('dark');
  });

  it('reports no stored preference when neither key exists', () => {
    installFakeStorage();
    expect(readMigratedPreference(BRAND.prefs.theme, BRAND.legacyPrefs.theme)).toBeNull();
  });

  it('opens installs that stored the studio mode as "continuity" in studio mode', async () => {
    const store = installFakeStorage({ [BRAND.legacyPrefs.appMode]: 'continuity' });
    vi.resetModules();
    const { useAppModeStore } = await import('../src/state/useAppModeStore');
    expect(useAppModeStore.getState().appMode).toBe('studio');
    expect(store.get(BRAND.prefs.appMode)).toBe('studio');
  });

  it('keeps the 360 viewer preference across the rebrand', async () => {
    installFakeStorage({ [BRAND.legacyPrefs.appMode]: 'panoViewer' });
    vi.resetModules();
    const { useAppModeStore } = await import('../src/state/useAppModeStore');
    expect(useAppModeStore.getState().appMode).toBe('panoViewer');
  });

  it('shows the mode chooser when no mode has ever been stored', async () => {
    installFakeStorage();
    vi.resetModules();
    const { useAppModeStore } = await import('../src/state/useAppModeStore');
    expect(useAppModeStore.getState().appMode).toBeNull();
  });
});

describe('ForeScene project backup file naming', () => {
  it('accepts ForeScene, legacy PanoRef, and zip backups regardless of case', () => {
    expect(isProjectBackupFileName('set.forescene-project')).toBe(true);
    expect(isProjectBackupFileName('SET.ForeScene-Project')).toBe(true);
    expect(isProjectBackupFileName('set.panoref-project')).toBe(true);
    expect(isProjectBackupFileName('set.zip')).toBe(true);
  });

  it('treats plain JSON as a manifest rather than a package', () => {
    expect(isProjectBackupFileName('set.json')).toBe(false);
  });

  it('offers both project extensions in the import picker', () => {
    const accept = projectBackupAcceptAttribute();
    expect(accept).toContain('.forescene-project');
    expect(accept).toContain('.panoref-project');
    expect(accept).toContain('.json');
    expect(accept).toContain('.zip');
  });

  it('names downloads after ForeScene', () => {
    expect(projectDownloadFileName('Courtyard Set', 'forescene-project'))
      .toBe('courtyard_set_forescene.forescene-project');
    expect(projectDownloadFileName('Courtyard Set', 'json'))
      .toBe('courtyard_set_forescene.json');
  });
});
