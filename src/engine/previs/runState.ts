/**
 * Resumable previs run-state — persisted under artifacts/ as JSON.
 * Pure helpers; filesystem I/O lives in the CLI.
 */

import { createHash } from 'node:crypto';
import type { PrevisProductionManifestV1 } from './manifest';

export type PrevisPhaseStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped';

export type PrevisShotCompileStatus = 'pending' | 'complete' | 'failed' | 'skipped';
export type PrevisShotRenderStatus = 'pending' | 'complete' | 'failed' | 'skipped';
export type PrevisShotValidationStatus =
  | 'pending'
  | 'passed'
  | 'warning'
  | 'failed'
  | 'needs_review'
  | 'skipped';

/** Bump when the render artifact contract changes (UI screenshots → clean clay, etc.). */
export const PREVIS_RENDER_PIPELINE_VERSION = 2;

export type PrevisRenderSource = 'canonical_clay_renderer' | 'ui_screenshot' | 'unknown';

export interface PrevisEntityMapping {
  objectIds?: string[];
  objectId?: string;
  shotId?: string;
  anchors?: Record<string, string>;
  zoneOrigin?: [number, number, number];
  refs?: Record<string, string>;
}

export interface PrevisShotPixelStats {
  width: number;
  height: number;
  opaquePixelRatio: number;
  luminanceMean: number;
  luminanceVariance: number;
  sampledUniqueColorCount: number;
}

export interface PrevisShotRunState {
  compile: PrevisShotCompileStatus;
  render: PrevisShotRenderStatus;
  validation: PrevisShotValidationStatus;
  /** @deprecated Prefer renderAttempts + repairAttempts. */
  attempts?: number;
  renderAttempts?: number;
  repairAttempts?: number;
  shotId?: string;
  framePath?: string;
  /** Provenance of the frame at framePath — never infer from path alone. */
  renderSource?: PrevisRenderSource;
  pixelStats?: PrevisShotPixelStats;
  issues?: Array<{ code: string; message?: string; subject?: string }>;
  lastError?: string;
}

export interface PrevisRunState {
  version: 1;
  /**
   * Render artifact pipeline version. Older runs must re-render even if
   * compile is complete (prevents UI screenshots masquerading as clay frames).
   */
  renderPipelineVersion?: number;
  manifestHash: string;
  projectId?: string;
  revisionId?: string;
  createdAt: string;
  updatedAt: string;
  phases: {
    initialized: PrevisPhaseStatus;
    locations: PrevisPhaseStatus;
    cast: PrevisPhaseStatus;
    props: PrevisPhaseStatus;
    shots: PrevisPhaseStatus;
    render: PrevisPhaseStatus;
    validation: PrevisPhaseStatus;
    contactSheet: PrevisPhaseStatus;
    package: PrevisPhaseStatus;
  };
  entities: Record<string, PrevisEntityMapping>;
  shots: Record<string, PrevisShotRunState>;
  outputDir?: string;
}

export function hashPrevisManifest(manifest: PrevisProductionManifestV1 | unknown): string {
  const canonical = typeof manifest === 'string'
    ? manifest
    : JSON.stringify(manifest);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

export function createInitialRunState(params: {
  manifestHash: string;
  outputDir?: string;
  projectId?: string;
  shotNumbers?: string[];
}): PrevisRunState {
  const now = new Date().toISOString();
  const shots: Record<string, PrevisShotRunState> = {};
  for (const shotNumber of params.shotNumbers ?? []) {
    shots[shotNumber] = {
      compile: 'pending',
      render: 'pending',
      validation: 'pending',
      attempts: 0,
      renderAttempts: 0,
      repairAttempts: 0,
    };
  }
  return {
    version: 1,
    renderPipelineVersion: PREVIS_RENDER_PIPELINE_VERSION,
    manifestHash: params.manifestHash,
    projectId: params.projectId,
    createdAt: now,
    updatedAt: now,
    phases: {
      initialized: 'pending',
      locations: 'pending',
      cast: 'pending',
      props: 'pending',
      shots: 'pending',
      render: 'pending',
      validation: 'pending',
      contactSheet: 'pending',
      package: 'pending',
    },
    entities: {},
    shots,
    outputDir: params.outputDir,
  };
}

/**
 * When an older run-state is loaded, invalidate rendered frames while preserving
 * compiled shots and entity mappings. Forces canonical clay re-render.
 */
export function migrateRenderPipelineVersion(state: PrevisRunState): {
  state: PrevisRunState;
  invalidated: boolean;
  previousVersion: number;
} {
  const previousVersion = state.renderPipelineVersion ?? 1;
  if (previousVersion >= PREVIS_RENDER_PIPELINE_VERSION) {
    return { state, invalidated: false, previousVersion };
  }

  let next: PrevisRunState = {
    ...state,
    renderPipelineVersion: PREVIS_RENDER_PIPELINE_VERSION,
  };

  for (const shotNumber of Object.keys(next.shots)) {
    const shot = next.shots[shotNumber]!;
    if (shot.render === 'complete' || shot.framePath || shot.renderSource) {
      next = upsertShotState(next, shotNumber, {
        render: 'pending',
        validation: 'pending',
        framePath: undefined,
        renderSource: undefined,
        pixelStats: undefined,
        renderAttempts: 0,
        attempts: 0,
        issues: undefined,
        lastError: undefined,
      });
    }
  }

  // Downstream phases must rerun; compile stays complete when already done.
  next = setPhase(next, 'render', 'pending');
  next = setPhase(next, 'validation', 'pending');
  next = setPhase(next, 'contactSheet', 'pending');
  next = setPhase(next, 'package', 'pending');
  next = touchRunState(next);

  return { state: next, invalidated: true, previousVersion };
}

/** True only when provenance is explicitly the canonical clay renderer. */
export function isCanonicalFrame(shot: PrevisShotRunState | undefined): boolean {
  return shot?.renderSource === 'canonical_clay_renderer'
    && shot.render === 'complete'
    && Boolean(shot.framePath);
}

export function touchRunState(state: PrevisRunState): PrevisRunState {
  return { ...state, updatedAt: new Date().toISOString() };
}

export function setPhase(
  state: PrevisRunState,
  phase: keyof PrevisRunState['phases'],
  status: PrevisPhaseStatus,
): PrevisRunState {
  return touchRunState({
    ...state,
    phases: { ...state.phases, [phase]: status },
  });
}

export function upsertEntity(
  state: PrevisRunState,
  key: string,
  mapping: PrevisEntityMapping,
): PrevisRunState {
  return touchRunState({
    ...state,
    entities: {
      ...state.entities,
      [key]: { ...state.entities[key], ...mapping },
    },
  });
}

export function upsertShotState(
  state: PrevisRunState,
  shotNumber: string,
  patch: Partial<PrevisShotRunState>,
): PrevisRunState {
  const previous = state.shots[shotNumber] ?? {
    compile: 'pending' as const,
    render: 'pending' as const,
    validation: 'pending' as const,
    attempts: 0,
  };
  return touchRunState({
    ...state,
    shots: {
      ...state.shots,
      [shotNumber]: { ...previous, ...patch },
    },
  });
}

/**
 * Resume guard: existing run-state may only continue when the manifest hash matches
 * unless the caller opts into a controlled `--update-manifest` path.
 */
export function assertManifestHashCompatible(
  state: PrevisRunState,
  manifestHash: string,
): { ok: true } | { ok: false; message: string } {
  if (state.manifestHash !== manifestHash) {
    return {
      ok: false,
      message:
        `Manifest hash mismatch: run-state has ${state.manifestHash}, `
        + `current manifest is ${manifestHash}. `
        + 'Refuse to resume with a silently changed input. '
        + 'Pass --update-manifest to invalidate only changed shots, '
        + 'or use --reset-project with a fresh output dir.',
    };
  }
  return { ok: true };
}

export function firstIncompletePhase(
  state: PrevisRunState,
): keyof PrevisRunState['phases'] | null {
  const order: Array<keyof PrevisRunState['phases']> = [
    'initialized',
    'locations',
    'cast',
    'props',
    'shots',
    'render',
    'validation',
    'contactSheet',
    'package',
  ];
  for (const phase of order) {
    const status = state.phases[phase];
    if (status !== 'complete' && status !== 'skipped') return phase;
  }
  return null;
}

export function incompleteShotNumbers(state: PrevisRunState): string[] {
  return Object.entries(state.shots)
    .filter(([, shot]) => shot.compile !== 'complete' || shot.render !== 'complete')
    .map(([shotNumber]) => shotNumber);
}

export function parseRunState(input: unknown): PrevisRunState | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (typeof record.manifestHash !== 'string') return undefined;
  if (!record.phases || typeof record.phases !== 'object') return undefined;
  if (!record.entities || typeof record.entities !== 'object') return undefined;
  if (!record.shots || typeof record.shots !== 'object') return undefined;
  return input as PrevisRunState;
}
