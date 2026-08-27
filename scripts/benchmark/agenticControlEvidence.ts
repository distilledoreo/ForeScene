import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isAgentCliEnvelope } from '../agent/cliResult';
import type { CliEvidenceRecordV1 } from '../agent/cliEvidence';
import {
  capabilitiesExportPackage,
  inspectSnapshotFromEnvelope,
  type InspectSnapshot,
} from './agenticControlInspect';
import type { AgenticControlContract, AgenticControlLifecycleContract } from './agenticControlContract';
import { isFreshProfileRecoveryContract, isImportIdempotencyContract } from './agenticControlContract';
import type {
  AgenticControlCandidateReport,
  AgenticControlFreshProfileCandidateReport,
  AgenticControlImportCandidateReport,
  AgenticControlInvocationRecord,
  AgenticControlLifecycleCandidateReport,
} from './agenticControlScorer';

interface EvidenceManifestV1 {
  version: 1;
  runId: string;
  seed: { path: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseEvidence(value: unknown, expectedRunId: string): CliEvidenceRecordV1 {
  if (!isRecord(value) || value.version !== 1 || value.runId !== expectedRunId) {
    throw new Error('CLI evidence has an invalid version or run id.');
  }
  if (typeof value.invocationId !== 'string' || typeof value.command !== 'string') {
    throw new Error('CLI evidence is missing invocation identity.');
  }
  if (!Array.isArray(value.rawArgs) || value.rawArgs.some((item) => typeof item !== 'string')) {
    throw new Error('CLI evidence rawArgs must be a string array.');
  }
  if (value.rawArgs[0] !== value.command || (value.exitCode !== 0 && value.exitCode !== 1 && value.exitCode !== 2)) {
    throw new Error('CLI evidence command or exit code is inconsistent.');
  }
  if (!isAgentCliEnvelope(value.envelope)) throw new Error('CLI evidence envelope is invalid.');
  const hash = createHash('sha256').update(JSON.stringify(value.envelope)).digest('hex');
  if (value.envelopeSha256 !== hash) throw new Error('CLI evidence envelope hash does not match.');
  if ((value.exitCode === 0) !== value.envelope.ok) {
    throw new Error('CLI evidence exit code and envelope success disagree.');
  }
  return value as unknown as CliEvidenceRecordV1;
}

export async function tryLoadAgenticControlEvidence(runRoot: string): Promise<{
  manifest: EvidenceManifestV1;
  records: CliEvidenceRecordV1[];
} | null> {
  const manifestPath = path.join(runRoot, 'harness', 'evidence.json');
  try {
    await access(manifestPath);
  } catch {
    return null;
  }
  return loadAgenticControlEvidence(runRoot);
}

export async function loadAgenticControlEvidence(runRoot: string): Promise<{
  manifest: EvidenceManifestV1;
  records: CliEvidenceRecordV1[];
}> {
  const manifestPath = path.join(runRoot, 'harness', 'evidence.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvidenceManifestV1;
  if (manifest.version !== 1 || typeof manifest.runId !== 'string' || !manifest.seed?.path) {
    throw new Error('Harness evidence manifest is invalid.');
  }
  const evidenceDir = path.join(runRoot, 'harness', 'evidence', 'cli');
  const names = (await readdir(evidenceDir)).filter((name) => name.endsWith('.json')).sort();
  const records = await Promise.all(names.map(async (name) => (
    parseEvidence(JSON.parse(await readFile(path.join(evidenceDir, name), 'utf8')), manifest.runId)
  )));
  const invocationIds = new Set<string>();
  for (const record of records) {
    if (invocationIds.has(record.invocationId)) throw new Error(`Duplicate CLI evidence invocation ${record.invocationId}.`);
    invocationIds.add(record.invocationId);
  }
  records.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return { manifest, records };
}

function flagValue(record: CliEvidenceRecordV1, flag: string): string | undefined {
  const index = record.rawArgs.indexOf(flag);
  return index >= 0 ? record.rawArgs[index + 1] : undefined;
}

function hasFlag(record: CliEvidenceRecordV1, flag: string): boolean {
  return record.rawArgs.includes(flag);
}

function samePath(left: string | undefined, right: string): boolean {
  return typeof left === 'string' && path.resolve(left) === path.resolve(right);
}

function successful(record: CliEvidenceRecordV1): boolean {
  return record.exitCode === 0 && record.envelope.ok;
}

function profilePath(record: CliEvidenceRecordV1): string | undefined {
  return flagValue(record, '--profile');
}

export function deriveAgenticControlReportFromEvidence(input: {
  contract: AgenticControlContract;
  runRoot: string;
  seedPath: string;
  records: CliEvidenceRecordV1[];
  runner: AgenticControlCandidateReport['runner'];
  freshProfileDir?: string;
}): AgenticControlCandidateReport {
  if (isImportIdempotencyContract(input.contract)) {
    return deriveImportReportFromEvidence(input);
  }
  if (isFreshProfileRecoveryContract(input.contract)) {
    return deriveFreshProfileReportFromEvidence(input);
  }
  return deriveLifecycleReportFromEvidence(input);
}

function deriveLifecycleReportFromEvidence(input: {
  contract: AgenticControlContract;
  runRoot: string;
  seedPath: string;
  records: CliEvidenceRecordV1[];
  runner: AgenticControlCandidateReport['runner'];
}): AgenticControlLifecycleCandidateReport {
  if (isImportIdempotencyContract(input.contract) || isFreshProfileRecoveryContract(input.contract)) {
    throw new Error('Lifecycle evidence derivation requires a lifecycle contract.');
  }
  const contract = input.contract as AgenticControlLifecycleContract;
  let cursor = 0;
  const selected: Array<{ step: string; record: CliEvidenceRecordV1 }> = [];
  const take = (
    step: string,
    command: string,
    predicate: (record: CliEvidenceRecordV1) => boolean = () => true,
  ): CliEvidenceRecordV1 => {
    const index = input.records.findIndex((record, candidateIndex) => (
      candidateIndex >= cursor && record.command === command && predicate(record)
    ));
    if (index < 0) throw new Error(`Harness evidence is missing a valid ${step} invocation.`);
    cursor = index + 1;
    const record = input.records[index]!;
    selected.push({ step, record });
    return record;
  };

  const capabilities = take('capabilities', 'capabilities');
  const exportPackage = capabilitiesExportPackage(capabilities.envelope.result);
  take('open-seed', 'open', (record) => (
    samePath(flagValue(record, '--file'), input.seedPath) && hasFlag(record, '--write')
  ));
  const inspectBeforeRecord = take('inspect-before', 'inspect', (record) => hasFlag(record, '--document'));
  const inspectBefore = inspectSnapshotFromEnvelope(inspectBeforeRecord.envelope);
  if (!inspectBefore) throw new Error('Harness evidence inspect-before payload is invalid.');
  const firstShotId = inspectBefore.shotIds[0];
  if (!firstShotId) throw new Error('Harness evidence inspect-before has no shot id.');

  const framePath = path.join(input.runRoot, contract.render.artifact);
  take('render-clay', 'frame', (record) => (
    flagValue(record, '--shot') === firstShotId
    && flagValue(record, '--mode') === contract.render.mode
    && samePath(flagValue(record, '--output'), framePath)
  ));
  const savedProject = path.join(input.runRoot, contract.artifacts.savedProject);
  take('save', 'save', (record) => (
    samePath(flagValue(record, '--output'), savedProject) && hasFlag(record, '--write')
  ));
  take('reopen', 'open', (record) => (
    samePath(flagValue(record, '--file'), savedProject) && hasFlag(record, '--write')
  ));
  const inspectAfterRecord = take('inspect-after', 'inspect', (record) => hasFlag(record, '--document'));
  const inspectAfter = inspectSnapshotFromEnvelope(inspectAfterRecord.envelope);
  if (!inspectAfter) throw new Error('Harness evidence inspect-after payload is invalid.');

  let packageRecord: AgenticControlLifecycleCandidateReport['package'];
  if (exportPackage && contract.artifacts.packageExport) {
    const packagePath = path.join(input.runRoot, contract.artifacts.packageExport);
    take('package', 'package', (record) => (
      samePath(flagValue(record, '--output'), packagePath) && hasFlag(record, '--write')
    ));
    packageRecord = { status: 'completed' };
  } else {
    packageRecord = { status: 'skipped', reason: 'export.package capability is false in captured evidence' };
  }

  const invocations: AgenticControlInvocationRecord[] = selected.map(({ step, record }) => ({
    step,
    npmScript: record.command,
    exitCode: record.exitCode,
    envelopeOk: successful(record),
  }));
  return {
    runner: input.runner,
    invocations,
    capabilities: { exportPackage },
    inspectBefore: inspectBefore as InspectSnapshot,
    inspectAfter: inspectAfter as InspectSnapshot,
    package: packageRecord,
  };
}

function deriveImportReportFromEvidence(input: {
  contract: AgenticControlContract;
  runRoot: string;
  seedPath: string;
  records: CliEvidenceRecordV1[];
  runner: AgenticControlCandidateReport['runner'];
}): AgenticControlImportCandidateReport {
  if (!isImportIdempotencyContract(input.contract)) {
    throw new Error('Import evidence derivation requires an import-idempotency contract.');
  }
  let cursor = 0;
  const selected: Array<{ step: string; record: CliEvidenceRecordV1 }> = [];
  const take = (
    step: string,
    command: string,
    predicate: (record: CliEvidenceRecordV1) => boolean = () => true,
  ): CliEvidenceRecordV1 => {
    const index = input.records.findIndex((record, candidateIndex) => (
      candidateIndex >= cursor && record.command === command && predicate(record)
    ));
    if (index < 0) throw new Error(`Harness evidence is missing a valid ${step} invocation.`);
    cursor = index + 1;
    const record = input.records[index]!;
    selected.push({ step, record });
    return record;
  };

  take('open-seed', 'open', (record) => (
    samePath(flagValue(record, '--file'), input.seedPath) && hasFlag(record, '--write')
  ));
  const inspectSeedRecord = take('inspect-seed', 'inspect', (record) => hasFlag(record, '--document'));
  const inspectSeed = inspectSnapshotFromEnvelope(inspectSeedRecord.envelope);
  if (!inspectSeed) throw new Error('Harness evidence inspect-seed payload is invalid.');

  const modelPath = path.join(input.runRoot, input.contract.importModel.runRelativePath);
  take('import-first', 'import-model', (record) => (
    samePath(flagValue(record, '--file'), modelPath) && hasFlag(record, '--write')
  ));
  const inspectAfterFirstRecord = take('inspect-after-first', 'inspect', (record) => hasFlag(record, '--document'));
  const inspectAfterFirst = inspectSnapshotFromEnvelope(inspectAfterFirstRecord.envelope);
  if (!inspectAfterFirst) throw new Error('Harness evidence inspect-after-first payload is invalid.');

  take('import-second', 'import-model', (record) => (
    samePath(flagValue(record, '--file'), modelPath) && hasFlag(record, '--write')
  ));
  const inspectAfterSecondRecord = take('inspect-after-second', 'inspect', (record) => hasFlag(record, '--document'));
  const inspectAfterSecond = inspectSnapshotFromEnvelope(inspectAfterSecondRecord.envelope);
  if (!inspectAfterSecond) throw new Error('Harness evidence inspect-after-second payload is invalid.');

  const savedProject = path.join(input.runRoot, input.contract.artifacts.savedProject);
  take('save', 'save', (record) => (
    samePath(flagValue(record, '--output'), savedProject) && hasFlag(record, '--write')
  ));

  const invocations: AgenticControlInvocationRecord[] = selected.map(({ step, record }) => ({
    step,
    npmScript: record.command,
    exitCode: record.exitCode,
    envelopeOk: successful(record),
  }));
  return {
    runner: input.runner,
    invocations,
    inspectSeed: inspectSeed as InspectSnapshot,
    inspectAfterFirst: inspectAfterFirst as InspectSnapshot,
    inspectAfterSecond: inspectAfterSecond as InspectSnapshot,
  };
}

function deriveFreshProfileReportFromEvidence(input: {
  contract: AgenticControlContract;
  runRoot: string;
  seedPath: string;
  records: CliEvidenceRecordV1[];
  runner: AgenticControlCandidateReport['runner'];
  freshProfileDir?: string;
}): AgenticControlFreshProfileCandidateReport {
  if (!isFreshProfileRecoveryContract(input.contract)) {
    throw new Error('Fresh-profile evidence derivation requires a fresh-profile-recovery contract.');
  }
  let cursor = 0;
  const selected: Array<{ step: string; record: CliEvidenceRecordV1 }> = [];
  const take = (
    step: string,
    command: string,
    predicate: (record: CliEvidenceRecordV1) => boolean = () => true,
  ): CliEvidenceRecordV1 => {
    const index = input.records.findIndex((record, candidateIndex) => (
      candidateIndex >= cursor && record.command === command && predicate(record)
    ));
    if (index < 0) throw new Error(`Harness evidence is missing a valid ${step} invocation.`);
    cursor = index + 1;
    const record = input.records[index]!;
    selected.push({ step, record });
    return record;
  };

  const openSeed = take('open-seed', 'open', (record) => (
    samePath(flagValue(record, '--file'), input.seedPath) && hasFlag(record, '--write')
  ));
  const primaryProfile = profilePath(openSeed);
  if (!primaryProfile) throw new Error('Harness evidence open-seed is missing --profile.');

  const inspectBeforeRecord = take('inspect-before', 'inspect', (record) => hasFlag(record, '--document'));
  const inspectBefore = inspectSnapshotFromEnvelope(inspectBeforeRecord.envelope);
  if (!inspectBefore) throw new Error('Harness evidence inspect-before payload is invalid.');

  const savedProject = path.join(input.runRoot, input.contract.artifacts.savedProject);
  take('save', 'save', (record) => (
    samePath(flagValue(record, '--output'), savedProject) && hasFlag(record, '--write')
  ));

  const reopenRecord = take('reopen-fresh', 'open', (record) => (
    samePath(flagValue(record, '--file'), savedProject) && hasFlag(record, '--write')
  ));
  const freshProfile = profilePath(reopenRecord);
  if (!freshProfile) throw new Error('Harness evidence reopen-fresh is missing --profile.');

  const inspectAfterRecord = take('inspect-after', 'inspect', (record) => hasFlag(record, '--document'));
  const inspectAfter = inspectSnapshotFromEnvelope(inspectAfterRecord.envelope);
  if (!inspectAfter) throw new Error('Harness evidence inspect-after payload is invalid.');

  const invocations: AgenticControlInvocationRecord[] = selected.map(({ step, record }) => ({
    step,
    npmScript: record.command,
    exitCode: record.exitCode,
    envelopeOk: successful(record),
    profile: profilePath(record),
  }));

  return {
    runner: input.runner,
    profiles: {
      primary: primaryProfile,
      fresh: freshProfile,
    },
    invocations,
    inspectBefore: inspectBefore as InspectSnapshot,
    inspectAfter: inspectAfter as InspectSnapshot,
    clayFrame: { status: 'skipped', reason: 'optional proof not captured in harness evidence' },
  };
}
