/**
 * One-call production orchestrator for rapid review and delivery modes.
 */

import path from 'node:path';
import {
  createProductionRunId,
  deriveProductionRunStatus,
  emptyProductionTiming,
  previsPhaseToProductionPhase,
  resolveProductionConfig,
  type ProductionRunOptions,
  type ProductionRunResult,
} from '../../src/engine/previs/productionRun';
import { runPrevisCli, type PrevisCliResult } from './previs';

function mapPrevisResultToProductionRun(
  result: PrevisCliResult,
  params: {
    runId: string;
    mode: ProductionRunOptions['mode'];
    renderProfileId: string;
    outputDir: string;
    startedAt: number;
    phaseTimings: Partial<ProductionRunResult['timing']>;
  },
): ProductionRunResult {
  const reviewRequiredShotIds: string[] = [];
  const timing = {
    ...emptyProductionTiming(),
    ...params.phaseTimings,
    totalMs: Date.now() - params.startedAt,
  };

  const status = deriveProductionRunStatus({
    ok: result.ok,
    failed: result.failed ?? 0,
    warnings: result.warnings ?? 0,
    reviewRequiredShotIds,
    error: result.error,
  });

  const artifactIds: string[] = [];
  if (result.contactSheet) artifactIds.push(result.contactSheet);
  if (result.package) artifactIds.push(result.package);

  return {
    runId: params.runId,
    status,
    mode: params.mode ?? 'rapid-review',
    renderProfileId: params.renderProfileId as ProductionRunResult['renderProfileId'],
    phase: result.ok ? 'complete' : previsPhaseToProductionPhase(result.phase as never),
    ok: result.ok,
    projectId: result.projectId,
    manifestHash: result.manifestHash,
    runStatePath: result.runStatePath,
    summaryPath: path.join(params.outputDir, 'summary.json'),
    compiledShotCount: result.shotsCreated ?? 0,
    approvedShotCount: result.passed ?? 0,
    reviewRequiredShotIds,
    shotsRequested: result.shotsRequested ?? 0,
    shotsCreated: result.shotsCreated ?? 0,
    framesRendered: result.framesRendered ?? 0,
    controlVideosRendered: result.controlVideosRendered ?? 0,
    controlVideosFailed: result.controlVideosFailed ?? 0,
    passed: result.passed ?? 0,
    warnings: result.warnings ?? 0,
    failed: result.failed ?? 0,
    diagnostics: result.diagnostics as ProductionRunResult['diagnostics'],
    artifactIds,
    artifacts: {
      contactSheet: result.contactSheet,
      package: result.package,
      validation: path.join(params.outputDir, 'validation.json'),
    },
    timing,
    error: result.error,
  };
}

/**
 * Run a complete production pass from manifest to reviewable artifacts.
 * This is the single entry point agents should use for first-pass review.
 */
export async function runProduction(options: ProductionRunOptions): Promise<ProductionRunResult> {
  const startedAt = Date.now();
  const runId = createProductionRunId();
  const outputDir = path.resolve(options.outputDir ?? 'artifacts/production');
  const config = resolveProductionConfig({ ...options, outputDir });

  const result = await runPrevisCli({
    manifestPath: options.manifestPath,
    url: options.url,
    headless: options.headless ?? (process.env.CI === 'true' || !process.stdout.isTTY),
    writeAccess: options.writeAccess ?? false,
    persistWrite: options.persistWrite ?? false,
    resetProject: options.resetProject ?? false,
    updateManifest: options.updateManifest,
    initializeOnly: options.initializeOnly,
    outputDir,
    skipPackage: config.skipPackage,
    profileDir: options.profileDir,
    allowHeavyCharacterImports: options.allowHeavyCharacterImports,
    mode: config.mode,
    renderProfile: config.renderProfile,
    renderProfileId: config.renderProfileId,
    renderProfileFingerprint: config.renderProfileFingerprint,
    runId,
    autoRepair: config.autoRepair,
    maxRepairPasses: config.maxRepairPasses,
    timeBudgetSeconds: config.timeBudgetSeconds,
    skipControlVideos: !config.renderProfile.renderVideo,
  });

  return mapPrevisResultToProductionRun(result, {
    runId,
    mode: config.mode,
    renderProfileId: config.renderProfileId,
    outputDir,
    startedAt,
    phaseTimings: {},
  });
}

export type { ProductionRunOptions, ProductionRunResult };
