/**
 * ForeScene brand contract — user-visible names, package identity, and
 * interchange formats. Legacy PanoRef / Continuity Stage identifiers remain
 * as explicit compatibility aliases (see LEGACY_*).
 */

export const BRAND = {
  name: 'ForeScene',
  packageName: 'forescene',
  browserTitle: 'ForeScene',
  /** One-line product positioning for onboarding and Help. */
  tagline:
    'ForeScene is a local-first previsualization and continuity workspace for AI-assisted video production. Build sets, stage characters, design shots, and export production-ready handoffs.',
  /** Shorter mode-chooser intro; card copy covers the rest. */
  modeChooserIntro:
    'Build sets, stage characters, design shots, and prepare production handoffs—or open the standalone 360 viewer.',
  shortDescription: 'local-first previsualization, continuity, and AI-video handoff',
  /** Canonical portable project backup extension (always a ZIP package). */
  projectExtension: '.fsp',
  /** Pre-rebrand and transitional backup extensions still accepted on import. */
  legacyProjectExtensions: ['.panoref-project', '.forescene-project'] as const,
  /** Filename stem inserted before the extension on new project downloads. */
  projectDownloadSuffix: 'forescene',
  legacyProjectDownloadSuffix: 'continuity_stage',
  rigExtension: '.fsrig',
  legacyRigExtension: '.panorig',
  rigFormat: 'forescene-poseable-rig',
  legacyRigFormat: 'panoref-poseable-rig',
  rigFormatVersion: 2,
  legacyRigFormatVersion: 1,
  splashVideo: '/forescene.mp4',
  sceneBundleExtension: '.panoscene',
  sceneManifest: 'forescene-scene.json',
  legacySceneManifest: 'panoref-scene.json',
  prefs: {
    appMode: 'forescene-app-mode',
    splashSeen: 'forescene-splash-seen',
    theme: 'forescene-theme',
  },
  legacyPrefs: {
    appMode: 'panoref-app-mode',
    splashSeen: 'panoref-splash-seen',
    theme: 'panoref-theme',
  },
} as const;

export type Brand = typeof BRAND;

/** Read a preference, migrating from a legacy key when present. */
export function readMigratedPreference(newKey: string, legacyKey: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const next = window.localStorage.getItem(newKey);
    if (next !== null) return next;
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy !== null) {
      window.localStorage.setItem(newKey, legacy);
      return legacy;
    }
  } catch {
    // ignore storage failures (private mode, etc.)
  }
  return null;
}

export function writePreference(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

/** True when the filename is a ZIP-style portable backup (not plain .json). */
export function isProjectBackupFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(BRAND.projectExtension) || lower.endsWith('.zip')) return true;
  return BRAND.legacyProjectExtensions.some((ext) => lower.endsWith(ext));
}

export function projectBackupAcceptAttribute(): string {
  return [
    '.json',
    '.zip',
    BRAND.projectExtension,
    ...BRAND.legacyProjectExtensions,
    'application/json',
    'application/zip',
  ].join(',');
}

/** Download basename for a new ForeScene project backup (always `.fsp`). */
export function projectDownloadFileName(projectName: string): string {
  const stem = projectName.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  return `${stem}_${BRAND.projectDownloadSuffix}${BRAND.projectExtension}`;
}
