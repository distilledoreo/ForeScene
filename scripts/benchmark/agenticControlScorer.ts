import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitIdentityRecord } from './git';
import { unauthorizedRepoModifications } from './git';
import {
  isFreshProfileRecoveryContract,
  isImportIdempotencyContract,
  loadAgenticControlContract,
  resolveAgenticControlRunPath,
  type AgenticControlContract,
} from './agenticControlContract';
import { shotIdSetEqual } from './agenticControlInspect';
import {
  deriveAgenticControlReportFromEvidence,
  tryLoadAgenticControlEvidence,
} from './agenticControlEvidence';
import {
  inspectBenchmarkArtifact,
  type BenchmarkArtifactEvidence,
} from './artifactEvidence';

export interface AgenticControlInvocationRecord {
  step: string;
  npmScript: string;
  exitCode: number;
  envelopeOk?: boolean;
  profile?: string;
}

export interface AgenticControlInspectRecord {
  projectId: string;
  shotIds: string[];
  castCount: number;
  assetCount: number;
  importedModelCount?: number;
}

export interface AgenticControlLifecycleCandidateReport {
  runner: 'cheap-agent' | 'oracle';
  invocations: AgenticControlInvocationRecord[];
  capabilities: {
    exportPackage: boolean;
  };
  inspectBefore: AgenticControlInspectRecord;
  inspectAfter: AgenticControlInspectRecord;
  package?: {
    status: 'completed' | 'skipped';
    reason?: string;
  };
}

export interface AgenticControlImportCandidateReport {
  runner: 'cheap-agent' | 'oracle';
  invocations: AgenticControlInvocationRecord[];
  inspectSeed: AgenticControlInspectRecord;
  inspectAfterFirst: AgenticControlInspectRecord;
  inspectAfterSecond: AgenticControlInspectRecord;
}

export interface AgenticControlFreshProfileCandidateReport {
  runner: 'cheap-agent' | 'oracle';
  profiles: {
    primary: string;
    fresh: string;
  };
  invocations: AgenticControlInvocationRecord[];
  inspectBefore: AgenticControlInspectRecord;
  inspectAfter: AgenticControlInspectRecord;
  clayFrame?: {
    status: 'completed' | 'skipped';
    reason?: string;
  };
}

export type AgenticControlCandidateReport =
  | AgenticControlLifecycleCandidateReport
  | AgenticControlImportCandidateReport
  | AgenticControlFreshProfileCandidateReport;

export interface AgenticControlScoreCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface AgenticControlScoreReport {
  ok: boolean;
  technicalPass: boolean;
  contractId: string;
  family: string;
  runner?: string;
  scoredAt: string;
  checks: AgenticControlScoreCheck[];
}

function check(id: string, ok: boolean, message: string): AgenticControlScoreCheck {
  return { id, ok, message };
}

export function requireCleanRepositoryForScoring(): boolean {
  return process.env.FORESCENE_BENCHMARK_REQUIRE_CLEAN === '1';
}

function checksAffectTechnicalPass(checks: AgenticControlScoreCheck[]): AgenticControlScoreCheck[] {
  if (requireCleanRepositoryForScoring()) return checks;
  return checks.filter((entry) => entry.id !== 'repository.clean');
}

function computeTechnicalPass(checks: AgenticControlScoreCheck[]): boolean {
  return checksAffectTechnicalPass(checks).every((entry) => entry.ok);
}

const LIFECYCLE_STEP_ALIASES: Record<string, readonly string[]> = {
  capabilities: ['capabilities'],
  'open-seed': ['open-seed'],
  'inspect-before': ['inspect-before'],
  'render-clay': ['render-clay', 'frame'],
  save: ['save'],
  reopen: ['reopen', 'open-saved'],
  'inspect-after': ['inspect-after'],
};

const IMPORT_STEP_ALIASES: Record<string, readonly string[]> = {
  'open-seed': ['open-seed'],
  'inspect-seed': ['inspect-seed'],
  'import-first': ['import-first', 'import-model-first'],
  'inspect-after-first': ['inspect-after-first'],
  'import-second': ['import-second', 'import-model-second'],
  'inspect-after-second': ['inspect-after-second'],
  save: ['save'],
};

const FRESH_PROFILE_STEP_ALIASES: Record<string, readonly string[]> = {
  'open-seed': ['open-seed'],
  'inspect-before': ['inspect-before'],
  save: ['save'],
  'reopen-fresh': ['reopen-fresh', 'open-fresh', 'reopen'],
  'inspect-after': ['inspect-after'],
};

function requiredSteps(contract: AgenticControlContract): string[] {
  if (isImportIdempotencyContract(contract)) return Object.keys(IMPORT_STEP_ALIASES);
  if (isFreshProfileRecoveryContract(contract)) return Object.keys(FRESH_PROFILE_STEP_ALIASES);
  return Object.keys(LIFECYCLE_STEP_ALIASES);
}

function stepAliases(contract: AgenticControlContract): Record<string, readonly string[]> {
  if (isImportIdempotencyContract(contract)) return IMPORT_STEP_ALIASES;
  if (isFreshProfileRecoveryContract(contract)) return FRESH_PROFILE_STEP_ALIASES;
  return LIFECYCLE_STEP_ALIASES;
}

function findInvocation(
  report: AgenticControlCandidateReport,
  canonicalStep: string,
  contract: AgenticControlContract,
): AgenticControlInvocationRecord | undefined {
  const aliases = stepAliases(contract)[canonicalStep] ?? [canonicalStep];
  return report.invocations.find((entry) => aliases.includes(entry.step));
}

function importedModelCount(snapshot: AgenticControlInspectRecord): number {
  return snapshot.importedModelCount ?? 0;
}

function appendRepositoryDriftCheck(
  checks: AgenticControlScoreCheck[],
  contract: AgenticControlContract,
  gitBefore?: GitIdentityRecord,
  gitAfter?: GitIdentityRecord,
): void {
  if (contract.scoring.checkRepositoryDrift && gitBefore && gitAfter) {
    const drift = unauthorizedRepoModifications(gitBefore, gitAfter);
    const clean = !drift;
    checks.push(check(
      'repository.clean',
      clean,
      clean
        ? 'No unauthorized ForeScene source modifications detected.'
        : `${drift!.message}${requireCleanRepositoryForScoring() ? '' : ' (warning only — set FORESCENE_BENCHMARK_REQUIRE_CLEAN=1 to fail on dirty tree).'}`,
    ));
  }
}

function scoreInvocationSteps(
  contract: AgenticControlContract,
  report: AgenticControlCandidateReport,
): AgenticControlScoreCheck[] {
  const checks: AgenticControlScoreCheck[] = [];
  for (const step of requiredSteps(contract)) {
    const invocation = findInvocation(report, step, contract);
    if (!invocation) {
      checks.push(check(`invocation.${step}`, false, `Missing invocation record for step ${step}.`));
      continue;
    }
    const ok = invocation.exitCode === 0 && invocation.envelopeOk === true;
    checks.push(check(
      `invocation.${step}`,
      ok,
      ok
        ? `${step}: exit 0, envelope ok.`
        : `${step}: exit ${invocation.exitCode}, envelopeOk=${String(invocation.envelopeOk)}.`,
    ));
  }
  return checks;
}

function scoreFreshProfileCandidateReport(input: {
  contract: AgenticControlContract;
  report: AgenticControlFreshProfileCandidateReport;
  gitBefore?: GitIdentityRecord;
  gitAfter?: GitIdentityRecord;
}): AgenticControlScoreReport {
  const checks = scoreInvocationSteps(input.contract, input.report);
  const { report } = input;

  const profilesDiffer = path.resolve(report.profiles.primary) !== path.resolve(report.profiles.fresh);
  checks.push(check(
    'continuity.profilePaths',
    profilesDiffer,
    profilesDiffer
      ? `Primary and fresh profile paths differ (${report.profiles.primary} vs ${report.profiles.fresh}).`
      : 'Primary and fresh profile paths must differ for fresh-profile recovery.',
  ));

  const reopenStep = findInvocation(report, 'reopen-fresh', input.contract);
  const reopenProfile = reopenStep?.profile;
  const reopenOnFresh = typeof reopenProfile === 'string'
    && path.resolve(reopenProfile) === path.resolve(report.profiles.fresh);
  checks.push(check(
    'continuity.reopenProfile',
    reopenOnFresh,
    reopenOnFresh
      ? `Reopen used fresh profile (${reopenProfile}).`
      : reopenProfile
        ? `Reopen profile (${reopenProfile}) does not match declared fresh profile (${report.profiles.fresh}).`
        : 'Reopen step did not record which profile was used.',
  ));

  const sameProject = report.inspectBefore.projectId === report.inspectAfter.projectId;
  checks.push(check(
    'continuity.projectId',
    sameProject,
    sameProject
      ? `projectId preserved (${report.inspectBefore.projectId}).`
      : `projectId changed (${report.inspectBefore.projectId} → ${report.inspectAfter.projectId}).`,
  ));

  const sameShots = shotIdSetEqual(report.inspectBefore.shotIds, report.inspectAfter.shotIds);
  checks.push(check(
    'continuity.shotIds',
    sameShots,
    sameShots
      ? `Shot id set unchanged (${report.inspectBefore.shotIds.join(', ')}).`
      : `Shot id set changed (${report.inspectBefore.shotIds.join(', ')} → ${report.inspectAfter.shotIds.join(', ')}).`,
  ));

  const castStable = report.inspectAfter.castCount <= report.inspectBefore.castCount;
  checks.push(check(
    'continuity.castCount',
    castStable,
    castStable
      ? `Cast count did not increase (${report.inspectBefore.castCount} → ${report.inspectAfter.castCount}).`
      : `Cast count increased (${report.inspectBefore.castCount} → ${report.inspectAfter.castCount}).`,
  ));

  appendRepositoryDriftCheck(checks, input.contract, input.gitBefore, input.gitAfter);

  const technicalPass = computeTechnicalPass(checks);
  return {
    ok: technicalPass,
    technicalPass,
    contractId: input.contract.id,
    family: input.contract.family,
    runner: report.runner,
    scoredAt: new Date().toISOString(),
    checks,
  };
}

function scoreLifecycleCandidateReport(input: {
  contract: AgenticControlContract;
  report: AgenticControlLifecycleCandidateReport;
  gitBefore?: GitIdentityRecord;
  gitAfter?: GitIdentityRecord;
}): AgenticControlScoreReport {
  const checks = scoreInvocationSteps(input.contract, input.report);
  const { contract, report } = input;

  if ('requirePackageWhenCapable' in contract.scoring && contract.scoring.requirePackageWhenCapable) {
    if (report.capabilities.exportPackage) {
      const packageStep = findInvocation(report, 'package', contract)
        ?? report.invocations.find((entry) => entry.step === 'package');
      const packageRecord = report.package;
      const ok = packageStep?.exitCode === 0
        && packageStep.envelopeOk === true
        && packageRecord?.status === 'completed';
      checks.push(check(
        'invocation.package',
        Boolean(ok),
        ok
          ? 'export.package capability true — package step completed.'
          : 'export.package capability true but package step missing or not completed.',
      ));
    } else {
      const ok = report.package?.status === 'skipped'
        && typeof report.package.reason === 'string'
        && report.package.reason.length > 0;
      checks.push(check(
        'invocation.package',
        ok,
        ok
          ? `export.package unavailable — explicit skip: ${report.package?.reason}`
          : 'export.package unavailable but candidate did not record an explicit skip reason.',
      ));
    }
  }

  const sameProject = report.inspectBefore.projectId === report.inspectAfter.projectId;
  checks.push(check(
    'continuity.projectId',
    sameProject,
    sameProject
      ? `projectId preserved (${report.inspectBefore.projectId}).`
      : `projectId changed (${report.inspectBefore.projectId} → ${report.inspectAfter.projectId}).`,
  ));

  const sameShots = shotIdSetEqual(report.inspectBefore.shotIds, report.inspectAfter.shotIds);
  checks.push(check(
    'continuity.shotIds',
    sameShots,
    sameShots
      ? `Shot id set unchanged (${report.inspectBefore.shotIds.join(', ')}).`
      : `Shot id set changed (${report.inspectBefore.shotIds.join(', ')} → ${report.inspectAfter.shotIds.join(', ')}).`,
  ));

  const castStable = report.inspectAfter.castCount <= report.inspectBefore.castCount;
  checks.push(check(
    'continuity.castCount',
    castStable,
    castStable
      ? `Cast count did not increase (${report.inspectBefore.castCount} → ${report.inspectAfter.castCount}).`
      : `Cast count increased (${report.inspectBefore.castCount} → ${report.inspectAfter.castCount}).`,
  ));

  appendRepositoryDriftCheck(checks, contract, input.gitBefore, input.gitAfter);

  const technicalPass = computeTechnicalPass(checks);
  return {
    ok: technicalPass,
    technicalPass,
    contractId: contract.id,
    family: contract.family,
    runner: report.runner,
    scoredAt: new Date().toISOString(),
    checks,
  };
}

function scoreImportCandidateReport(input: {
  contract: AgenticControlContract;
  report: AgenticControlImportCandidateReport;
  gitBefore?: GitIdentityRecord;
  gitAfter?: GitIdentityRecord;
}): AgenticControlScoreReport {
  const checks = scoreInvocationSteps(input.contract, input.report);
  const { report } = input;
  const { inspectSeed, inspectAfterFirst, inspectAfterSecond } = report;

  const sameProject = inspectSeed.projectId === inspectAfterFirst.projectId
    && inspectAfterFirst.projectId === inspectAfterSecond.projectId;
  checks.push(check(
    'continuity.projectId',
    sameProject,
    sameProject
      ? `projectId preserved (${inspectSeed.projectId}).`
      : 'projectId changed across inspects.',
  ));

  const firstImportEffect = inspectAfterFirst.assetCount > inspectSeed.assetCount
    || importedModelCount(inspectAfterFirst) > importedModelCount(inspectSeed);
  checks.push(check(
    'continuity.firstImportEffect',
    firstImportEffect,
    firstImportEffect
      ? `First import changed counts (assets ${inspectSeed.assetCount}→${inspectAfterFirst.assetCount}, imported models ${importedModelCount(inspectSeed)}→${importedModelCount(inspectAfterFirst)}).`
      : 'First import did not increase asset or imported-model counts versus seed.',
  ));

  const assetStable = inspectAfterSecond.assetCount <= inspectAfterFirst.assetCount;
  checks.push(check(
    'continuity.assetCount',
    assetStable,
    assetStable
      ? `Asset count did not increase after second import (${inspectAfterFirst.assetCount} → ${inspectAfterSecond.assetCount}).`
      : `Asset count increased after second import (${inspectAfterFirst.assetCount} → ${inspectAfterSecond.assetCount}).`,
  ));

  const importedStable = importedModelCount(inspectAfterSecond) <= importedModelCount(inspectAfterFirst);
  checks.push(check(
    'continuity.importedModelCount',
    importedStable,
    importedStable
      ? `Imported-model count did not increase after second import (${importedModelCount(inspectAfterFirst)} → ${importedModelCount(inspectAfterSecond)}).`
      : `Imported-model count increased after second import (${importedModelCount(inspectAfterFirst)} → ${importedModelCount(inspectAfterSecond)}).`,
  ));

  appendRepositoryDriftCheck(checks, input.contract, input.gitBefore, input.gitAfter);

  const technicalPass = computeTechnicalPass(checks);
  return {
    ok: technicalPass,
    technicalPass,
    contractId: input.contract.id,
    family: input.contract.family,
    runner: report.runner,
    scoredAt: new Date().toISOString(),
    checks,
  };
}

export function scoreAgenticControlCandidateReport(input: {
  contract: AgenticControlContract;
  runRoot: string;
  report: AgenticControlCandidateReport;
  gitBefore?: GitIdentityRecord;
  gitAfter?: GitIdentityRecord;
}): AgenticControlScoreReport {
  if (isImportIdempotencyContract(input.contract)) {
    return scoreImportCandidateReport({
      contract: input.contract,
      report: input.report as AgenticControlImportCandidateReport,
      gitBefore: input.gitBefore,
      gitAfter: input.gitAfter,
    });
  }
  if (isFreshProfileRecoveryContract(input.contract)) {
    return scoreFreshProfileCandidateReport({
      contract: input.contract,
      report: input.report as AgenticControlFreshProfileCandidateReport,
      gitBefore: input.gitBefore,
      gitAfter: input.gitAfter,
    });
  }
  return scoreLifecycleCandidateReport({
    contract: input.contract,
    report: input.report as AgenticControlLifecycleCandidateReport,
    gitBefore: input.gitBefore,
    gitAfter: input.gitAfter,
  });
}

export function isFreshProfileCandidateReport(
  report: AgenticControlCandidateReport,
): report is AgenticControlFreshProfileCandidateReport {
  return 'profiles' in report && 'inspectBefore' in report && 'inspectAfter' in report
    && !('capabilities' in report);
}

export function isImportCandidateReport(
  report: AgenticControlCandidateReport,
): report is AgenticControlImportCandidateReport {
  return 'inspectSeed' in report && 'inspectAfterFirst' in report && 'inspectAfterSecond' in report;
}

export async function scoreAgenticControlRun(input: {
  contractPath: string;
  runRoot: string;
  gitBefore?: GitIdentityRecord;
  gitAfter?: GitIdentityRecord;
}): Promise<AgenticControlScoreReport> {
  const loaded = await loadAgenticControlContract(input.contractPath);
  const runRoot = path.resolve(input.runRoot);
  const reportPath = resolveAgenticControlRunPath(runRoot, loaded.contract.artifacts.candidateReport);
  const candidateReport = parseAgenticControlCandidateReport(JSON.parse(await readFile(reportPath, 'utf8')));

  const checks: AgenticControlScoreCheck[] = [];
  const artifactEvidence: BenchmarkArtifactEvidence[] = [];
  const inspectArtifact = async (
    relativePath: string,
    kind: 'png' | 'fsp' | 'package-zip',
    id: string,
  ): Promise<BenchmarkArtifactEvidence | undefined> => {
    try {
      const inspected = await inspectBenchmarkArtifact({
        runRoot,
        filePath: resolveAgenticControlRunPath(runRoot, relativePath),
        kind,
        minBytes: loaded.contract.thresholds.minBytes,
      });
      artifactEvidence.push(inspected);
      checks.push(check(id, inspected.valid, `${inspected.message} (${inspected.bytes} bytes, sha256 ${inspected.sha256}).`));
      return inspected;
    } catch (error) {
      checks.push(check(id, false, error instanceof Error ? error.message : String(error)));
      return undefined;
    }
  };

  let savedEvidence: BenchmarkArtifactEvidence | undefined;
  if (isImportIdempotencyContract(loaded.contract)) {
    savedEvidence = await inspectArtifact(
      loaded.contract.artifacts.savedProject,
      'fsp',
      'artifact.savedProject',
    );
    const importReport = candidateReport as AgenticControlImportCandidateReport;
    const savedSnapshot = savedEvidence?.projectSnapshot;
    const savedMatchesInspect = Boolean(
      savedSnapshot
      && savedSnapshot.projectId === importReport.inspectAfterSecond.projectId
      && savedSnapshot.assetCount === importReport.inspectAfterSecond.assetCount
      && (savedSnapshot.importedModelCount ?? 0) === importedModelCount(importReport.inspectAfterSecond),
    );
    checks.push(check(
      'artifact.savedProjectContinuity',
      savedMatchesInspect,
      savedMatchesInspect
        ? 'Saved FSP semantic identity agrees with inspect-after-second.'
        : 'Saved FSP semantic identity does not agree with inspect-after-second.',
    ));
  } else if (isFreshProfileRecoveryContract(loaded.contract)) {
    savedEvidence = await inspectArtifact(
      loaded.contract.artifacts.savedProject,
      'fsp',
      'artifact.savedProject',
    );
    const freshReport = candidateReport as AgenticControlFreshProfileCandidateReport;
    const savedSnapshot = savedEvidence?.projectSnapshot;
    const savedMatchesInspect = Boolean(
      savedSnapshot
      && savedSnapshot.projectId === freshReport.inspectBefore.projectId
      && shotIdSetEqual(savedSnapshot.shotIds, freshReport.inspectBefore.shotIds)
      && savedSnapshot.castCount === freshReport.inspectBefore.castCount
      && savedSnapshot.assetCount === freshReport.inspectBefore.assetCount,
    );
    checks.push(check(
      'artifact.savedProjectContinuity',
      savedMatchesInspect,
      savedMatchesInspect
        ? 'Saved FSP semantic identity agrees with inspect-before.'
        : 'Saved FSP semantic identity does not agree with inspect-before.',
    ));
  } else {
    await inspectArtifact(loaded.contract.render.artifact, 'png', 'artifact.clayFrame');
    savedEvidence = await inspectArtifact(
      loaded.contract.artifacts.savedProject,
      'fsp',
      'artifact.savedProject',
    );
    const lifecycleReport = candidateReport as AgenticControlLifecycleCandidateReport;
    if (loaded.contract.artifacts.packageExport && lifecycleReport.capabilities.exportPackage) {
      await inspectArtifact(loaded.contract.artifacts.packageExport, 'package-zip', 'artifact.packageExport');
    }
    const savedSnapshot = savedEvidence?.projectSnapshot;
    const savedMatchesInspect = Boolean(
      savedSnapshot
      && savedSnapshot.projectId === lifecycleReport.inspectAfter.projectId
      && shotIdSetEqual(savedSnapshot.shotIds, lifecycleReport.inspectAfter.shotIds)
      && savedSnapshot.castCount === lifecycleReport.inspectAfter.castCount
      && savedSnapshot.assetCount === lifecycleReport.inspectAfter.assetCount,
    );
    checks.push(check(
      'artifact.savedProjectContinuity',
      savedMatchesInspect,
      savedMatchesInspect
        ? 'Saved FSP semantic identity agrees with inspect-after.'
        : 'Saved FSP semantic identity does not agree with inspect-after.',
    ));
  }

  await writeFile(
    path.join(runRoot, 'artifact-evidence.json'),
    `${JSON.stringify({ version: 1, artifacts: artifactEvidence }, null, 2)}\n`,
    'utf8',
  );

  const logical = scoreAgenticControlCandidateReport({
    contract: loaded.contract,
    runRoot,
    report: candidateReport,
    gitBefore: input.gitBefore,
    gitAfter: input.gitAfter,
  });

  const harnessEvidence = await tryLoadAgenticControlEvidence(runRoot);
  if (harnessEvidence) {
    const derived = deriveAgenticControlReportFromEvidence({
      contract: loaded.contract,
      runRoot,
      seedPath: path.join(runRoot, harnessEvidence.manifest.seed.path),
      records: harnessEvidence.records,
      runner: candidateReport.runner,
    });
    let candidateConsistent = candidateReport.invocations.length === derived.invocations.length
      && candidateReport.invocations.every((claimed, index) => {
        const captured = derived.invocations[index];
        return claimed.npmScript === captured?.npmScript
          && claimed.exitCode === captured.exitCode
          && claimed.envelopeOk === captured.envelopeOk;
      });
    if (isImportCandidateReport(candidateReport) && isImportCandidateReport(derived)) {
      candidateConsistent = candidateConsistent
        && JSON.stringify(candidateReport.inspectSeed) === JSON.stringify(derived.inspectSeed)
        && JSON.stringify(candidateReport.inspectAfterFirst) === JSON.stringify(derived.inspectAfterFirst)
        && JSON.stringify(candidateReport.inspectAfterSecond) === JSON.stringify(derived.inspectAfterSecond);
    } else if (isFreshProfileCandidateReport(candidateReport) && isFreshProfileCandidateReport(derived)) {
      candidateConsistent = candidateConsistent
        && path.resolve(candidateReport.profiles.primary) === path.resolve(derived.profiles.primary)
        && path.resolve(candidateReport.profiles.fresh) === path.resolve(derived.profiles.fresh)
        && JSON.stringify(candidateReport.inspectBefore) === JSON.stringify(derived.inspectBefore)
        && JSON.stringify(candidateReport.inspectAfter) === JSON.stringify(derived.inspectAfter);
    } else if (!isImportCandidateReport(candidateReport) && !isImportCandidateReport(derived)
      && !isFreshProfileCandidateReport(candidateReport) && !isFreshProfileCandidateReport(derived)) {
      candidateConsistent = candidateConsistent
        && JSON.stringify(candidateReport.capabilities) === JSON.stringify(derived.capabilities)
        && JSON.stringify(candidateReport.inspectBefore) === JSON.stringify(derived.inspectBefore)
        && JSON.stringify(candidateReport.inspectAfter) === JSON.stringify(derived.inspectAfter)
        && candidateReport.package?.status === derived.package?.status
        && (
          derived.package?.status !== 'skipped'
          || candidateReport.package?.reason === derived.package.reason
        );
    } else {
      candidateConsistent = false;
    }
    checks.push(check(
      'evidence.candidateReport',
      candidateConsistent,
      candidateConsistent
        ? `Candidate report agrees with ${harnessEvidence.records.length} harness-captured CLI invocation(s).`
        : 'Candidate report does not agree with harness-captured CLI evidence.',
    ));
  } else {
    checks.push(check(
      'evidence.harness',
      true,
      'No harness CLI evidence present; scored from candidate report and artifacts only.',
    ));
  }

  const merged = [...checks, ...logical.checks];
  const technicalPass = computeTechnicalPass(merged);
  return {
    ...logical,
    checks: merged,
    ok: technicalPass,
    technicalPass,
  };
}

function validInspectSnapshot(snapshot: AgenticControlInspectRecord | undefined): snapshot is AgenticControlInspectRecord {
  return Boolean(
    snapshot
    && typeof snapshot.projectId === 'string'
    && snapshot.projectId.length > 0
    && Array.isArray(snapshot.shotIds)
    && snapshot.shotIds.every((id) => typeof id === 'string')
    && Number.isInteger(snapshot.castCount)
    && snapshot.castCount >= 0
    && Number.isInteger(snapshot.assetCount)
    && snapshot.assetCount >= 0
    && (snapshot.importedModelCount === undefined || (
      Number.isInteger(snapshot.importedModelCount) && snapshot.importedModelCount >= 0
    )),
  );
}

function validInvocations(invocations: AgenticControlInvocationRecord[] | undefined): boolean {
  if (!Array.isArray(invocations)) return false;
  const validInvocation = invocations.every((entry) => (
    entry
    && typeof entry.step === 'string'
    && typeof entry.npmScript === 'string'
    && Number.isInteger(entry.exitCode)
    && typeof entry.envelopeOk === 'boolean'
  ));
  const uniqueSteps = new Set(invocations.map((entry) => entry.step));
  return validInvocation && uniqueSteps.size === invocations.length;
}

export function parseAgenticControlCandidateReport(value: unknown): AgenticControlCandidateReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('candidate-report must be an object.');
  }
  const record = value as Partial<AgenticControlCandidateReport>;
  if (record.runner !== 'cheap-agent' && record.runner !== 'oracle') {
    throw new Error('candidate-report runner must be cheap-agent or oracle.');
  }
  if (!validInvocations(record.invocations)) {
    throw new Error('candidate-report invocations must be valid and have unique steps.');
  }

  const importRecord = record as Partial<AgenticControlImportCandidateReport>;
  if (importRecord.inspectSeed && importRecord.inspectAfterFirst && importRecord.inspectAfterSecond) {
    if (!validInspectSnapshot(importRecord.inspectSeed)
      || !validInspectSnapshot(importRecord.inspectAfterFirst)
      || !validInspectSnapshot(importRecord.inspectAfterSecond)) {
      throw new Error('candidate-report import inspect snapshots are invalid.');
    }
    return importRecord as AgenticControlImportCandidateReport;
  }

  const freshRecord = record as Partial<AgenticControlFreshProfileCandidateReport>;
  if (freshRecord.profiles?.primary && freshRecord.profiles?.fresh
    && freshRecord.inspectBefore && freshRecord.inspectAfter
    && !('capabilities' in record)) {
    if (!validInspectSnapshot(freshRecord.inspectBefore) || !validInspectSnapshot(freshRecord.inspectAfter)) {
      throw new Error('candidate-report fresh-profile inspect snapshots are invalid.');
    }
    if (typeof freshRecord.profiles.primary !== 'string' || typeof freshRecord.profiles.fresh !== 'string') {
      throw new Error('candidate-report profiles.primary and profiles.fresh must be strings.');
    }
    return freshRecord as AgenticControlFreshProfileCandidateReport;
  }

  const lifecycleRecord = record as Partial<AgenticControlLifecycleCandidateReport>;
  if (!lifecycleRecord.inspectBefore || !lifecycleRecord.inspectAfter) {
    throw new Error('candidate-report requires inspectBefore/inspectAfter or import inspect snapshots.');
  }
  if (!validInspectSnapshot(lifecycleRecord.inspectBefore) || !validInspectSnapshot(lifecycleRecord.inspectAfter)) {
    throw new Error('candidate-report inspect snapshots are invalid.');
  }
  if (typeof lifecycleRecord.capabilities?.exportPackage !== 'boolean') {
    throw new Error('candidate-report capabilities.exportPackage must be boolean.');
  }
  if (!lifecycleRecord.package || (lifecycleRecord.package.status !== 'completed' && lifecycleRecord.package.status !== 'skipped')) {
    throw new Error('candidate-report package status is invalid.');
  }
  return lifecycleRecord as AgenticControlLifecycleCandidateReport;
}
