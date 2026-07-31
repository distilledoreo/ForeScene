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

export interface PrevisEntityMapping {
  objectIds?: string[];
  objectId?: string;
  shotId?: string;
  anchors?: Record<string, string>;
  zoneOrigin?: [number, number, number];
  refs?: Record<string, string>;
}

export interface PrevisShotRunState {
  compile: PrevisShotCompileStatus;
  render: PrevisShotRenderStatus;
  validation: PrevisShotValidationStatus;
  attempts?: number;
  shotId?: string;
  framePath?: string;
  issues?: Array<{ code: string; message?: string; subject?: string }>;
  lastError?: string;
}

export interface PrevisRunState {
  version: 1;
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
    };
  }
  return {
    version: 1,
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
 * Resume guard: existing run-state may only continue when the manifest hash matches.
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
        + 'Refuse to resume with a silently changed input. Use --reset-project with a fresh output dir.',
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
