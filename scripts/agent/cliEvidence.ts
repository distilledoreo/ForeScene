import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentCliEnvelope, AgentCliExitCode } from './cliResult';

export interface CliEvidenceRecordV1 {
  version: 1;
  runId: string;
  invocationId: string;
  startedAt: string;
  endedAt: string;
  command: string;
  rawArgs: string[];
  exitCode: AgentCliExitCode;
  envelope: AgentCliEnvelope;
  envelopeSha256: string;
}

const invocationId = randomUUID();
const startedAt = new Date().toISOString();
let evidenceWritten = false;

function evidenceTarget(directory: string): string {
  if (!path.isAbsolute(directory)) {
    throw new Error('FORESCENE_EVIDENCE_DIR must be an absolute path.');
  }
  const resolved = path.resolve(directory);
  const target = path.resolve(resolved, `${Date.now()}-${invocationId}.json`);
  const relative = path.relative(resolved, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('CLI evidence target escaped FORESCENE_EVIDENCE_DIR.');
  }
  return target;
}

/**
 * Passive, product-level command evidence. This is enabled only when a
 * harness supplies both evidence environment variables. It never changes the
 * command's behavior and deliberately records no inherited environment or
 * stderr, which may contain credentials or machine-specific details.
 */
export function writeCliEvidence(
  envelope: AgentCliEnvelope,
  exitCode: AgentCliExitCode,
  rawArgs = process.argv.slice(2),
): void {
  if (evidenceWritten) return;
  const directory = process.env.FORESCENE_EVIDENCE_DIR;
  const runId = process.env.FORESCENE_EVIDENCE_RUN_ID;
  if (!directory && !runId) return;
  if (!directory || !runId) {
    throw new Error('FORESCENE_EVIDENCE_DIR and FORESCENE_EVIDENCE_RUN_ID must be set together.');
  }

  const target = evidenceTarget(directory);
  mkdirSync(directory, { recursive: true });
  const envelopeJson = JSON.stringify(envelope);
  const record: CliEvidenceRecordV1 = {
    version: 1,
    runId,
    invocationId,
    startedAt,
    endedAt: new Date().toISOString(),
    command: rawArgs[0] ?? 'inspect',
    rawArgs: [...rawArgs],
    exitCode,
    envelope,
    envelopeSha256: createHash('sha256').update(envelopeJson).digest('hex'),
  };
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
  evidenceWritten = true;
}
