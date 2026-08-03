/**
 * Production-run types and state machine for one-call rapid review.
 * Pure helpers — browser I/O lives in scripts/agent/production.ts.
 */

import type { PrevisDiagnostic } from './manifestDiagnostics';
import type { PrevisRunState } from './runState';
import {
  type ProductionMode,
  type RenderProfile,
  type RenderProfileId,
  getRenderProfile,
  resolveRenderProfileForMode,
  renderProfileFingerprint,
} from './renderProfiles';

export type ProductionRunStatus =
  | 'completed'
  | 'completed_with_warnings'
  | 'needs_review'
  | 'failed'
  | 'cancelled'
  | 'in_progress';

export type ProductionRunPhase =
  | 'validate'
  | 'open_package'
  | 'resolve_bindings'
  | 'compile'
  | 'structural_diagnostics'
  | 'render_review_frames'
  | 'create_review_sheets'
  | 'visual_review'
  | 'group_defects'
  | 'apply_safe_repairs'
  | 'rerender_invalidated'
  | 'finalize'
  | 'complete';

export const PRODUCTION_RUN_PHASE_ORDER: ProductionRunPhase[] = [
  'validate',
  'open_package',
  'resolve_bindings',
  'compile',
  'structural_diagnostics',
  'render_review_frames',
  'create_review_sheets',
  'visual_review',
  'group_defects',
  'apply_safe_repairs',
  'rerender_invalidated',
  'finalize',
  'complete',
];

/** Maps legacy previs phases onto the production-run state machine. */
export function previsPhaseToProductionPhase(
  phase: keyof PrevisRunState['phases'] | 'complete' | undefined,
): ProductionRunPhase {
  switch (phase) {
    case 'initialized':
      return 'open_package';
    case 'locations':
    case 'cast':
    case 'props':
    case 'shots':
      return 'compile';
    case 'render':
      return 'render_review_frames';
    case 'validation':
      return 'structural_diagnostics';
    case 'contactSheet':
      return 'create_review_sheets';
    case 'package':
      return 'finalize';
    case 'complete':
      return 'complete';
    default:
      return 'validate';
  }
}

export interface ProductionRunTiming {
  validationMs: number;
  compilationMs: number;
  renderingMs: number;
  reviewMs: number;
  repairMs: number;
  totalMs: number;
}

export interface ProductionRunOptions {
  manifestPath: string;
  mode?: ProductionMode;
  renderProfileId?: RenderProfileId;
  autoRepair?: boolean;
  maxRepairPasses?: number;
  timeBudgetSeconds?: number;
  url?: string;
  headless?: boolean;
  writeAccess?: boolean;
  persistWrite?: boolean;
  resetProject?: boolean;
  updateManifest?: boolean;
  initializeOnly?: boolean;
  outputDir?: string;
  skipPackage?: boolean;
  profileDir?: string;
  allowHeavyCharacterImports?: boolean;
}

export interface ProductionRunResult {
  runId: string;
  status: ProductionRunStatus;
  mode: ProductionMode;
  renderProfileId: RenderProfileId;

  phase: ProductionRunPhase;
  ok: boolean;

  sourceRevisionId?: string;
  resultRevisionId?: string;
  projectId?: string;
  manifestHash?: string;
  runStatePath?: string;
  summaryPath?: string;

  compiledShotCount: number;
  approvedShotCount: number;
  reviewRequiredShotIds: string[];

  shotsRequested: number;
  shotsCreated: number;
  framesRendered: number;
  controlVideosRendered: number;
  controlVideosFailed: number;
  passed: number;
  warnings: number;
  failed: number;

  diagnostics?: PrevisDiagnostic[];
  /** Filesystem paths to run artifacts (contact sheet, package, etc.). */
  artifactPaths: string[];

  artifacts: {
    contactSheet?: string;
    contactSheetHtml?: string;
    package?: string;
    validation?: string;
  };

  timing: ProductionRunTiming;

  error?: string;
}

export interface ProductionSessionState {
  runId: string;
  mode: ProductionMode;
  renderProfileId: RenderProfileId;
  renderProfileFingerprint: string;
  outputDir: string;
  browserProfileDir?: string;
  startedAt: string;
}

export function createProductionRunId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `prod_${stamp}_${rand}`;
}

export function resolveProductionConfig(options: ProductionRunOptions): {
  mode: ProductionMode;
  renderProfile: RenderProfile;
  renderProfileId: RenderProfileId;
  autoRepair: boolean;
  maxRepairPasses: number;
  timeBudgetSeconds: number;
  skipPackage: boolean;
  renderProfileFingerprint: string;
} {
  const mode = options.mode ?? 'rapid-review';
  const renderProfileId = options.renderProfileId ?? resolveRenderProfileForMode(mode).id;
  const renderProfile = getRenderProfile(renderProfileId);

  return {
    mode,
    renderProfile,
    renderProfileId,
    autoRepair: options.autoRepair ?? mode === 'rapid-review',
    maxRepairPasses: options.maxRepairPasses ?? (mode === 'rapid-review' ? 2 : 3),
    timeBudgetSeconds: options.timeBudgetSeconds ?? (mode === 'rapid-review' ? 480 : 3600),
    skipPackage: options.skipPackage ?? renderProfile.skipPackage,
    renderProfileFingerprint: renderProfileFingerprint(renderProfile),
  };
}

export function deriveProductionRunStatus(params: {
  ok: boolean;
  failed: number;
  warnings: number;
  reviewRequiredShotIds: string[];
  error?: string;
}): ProductionRunStatus {
  if (params.error && params.failed > 0) return 'failed';
  if (!params.ok && params.failed > 0) return 'failed';
  if (params.reviewRequiredShotIds.length > 0) return 'needs_review';
  if (params.warnings > 0) return 'completed_with_warnings';
  if (!params.ok) return 'failed';
  return 'completed';
}

export function emptyProductionTiming(): ProductionRunTiming {
  return {
    validationMs: 0,
    compilationMs: 0,
    renderingMs: 0,
    reviewMs: 0,
    repairMs: 0,
    totalMs: 0,
  };
}

export class ProductionTimeBudgetExceededError extends Error {
  readonly phase: string;

  constructor(phase: string) {
    super(`Production time budget exceeded during ${phase}.`);
    this.name = 'ProductionTimeBudgetExceededError';
    this.phase = phase;
  }
}

/** Enforces an optional wall-clock budget across production phases. */
export class ProductionTimeBudget {
  private readonly deadlineMs: number;

  constructor(seconds: number, startedAt = Date.now()) {
    this.deadlineMs = startedAt + seconds * 1000;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMs - Date.now());
  }

  isExpired(): boolean {
    return this.remainingMs() <= 0;
  }

  assertWithinBudget(phase: string): void {
    if (this.isExpired()) {
      throw new ProductionTimeBudgetExceededError(phase);
    }
  }
}

export function hasMissingControlVideos(params: {
  shots: Array<{ shotNumber: string; motion?: { renderControlVideo?: boolean } }>;
  shotStates: Record<string, { compile?: string; video?: string } | undefined>;
  skipControlVideos: boolean;
}): boolean {
  if (params.skipControlVideos) return false;
  return params.shots.some((shot) => {
    if (!shot.motion?.renderControlVideo) return false;
    const shotState = params.shotStates[shot.shotNumber];
    return shotState?.compile === 'complete' && shotState.video !== 'complete';
  });
}
