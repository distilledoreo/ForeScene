/**
 * Stable Agent CLI stdout contract.
 *
 * Human diagnostics stay on stderr. Machine consumers must parse this envelope
 * and must not scrape free-form terminal text.
 */

export const AGENT_CLI_EXIT = {
  success: 0,
  failure: 1,
  usage: 2,
} as const;

export type AgentCliExitCode = (typeof AGENT_CLI_EXIT)[keyof typeof AGENT_CLI_EXIT];

export interface AgentCliErrorObject {
  code: string;
  message: string;
}

export interface AgentCliWarning {
  code?: string;
  message: string;
}

export interface AgentCliEnvelope {
  ok: boolean;
  operation: string;
  operationId?: string;
  durationMs: number;
  projectId?: string;
  revisionId?: string;
  affectedObjectIds?: string[];
  affectedShotIds?: string[];
  warnings: AgentCliWarning[];
  error?: AgentCliErrorObject;
  profileRecovery?: unknown;
  result: unknown;
}

export interface CliStdoutContext {
  operation: string;
  operationId?: string;
  startedAt: number;
  profileRecovery?: unknown;
}

export class AgentCliUsageError extends Error {
  readonly code = 'usage_error';

  constructor(message: string) {
    super(message);
    this.name = 'AgentCliUsageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string');
  return items.length > 0 ? items : undefined;
}

function readNested(record: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = record;
  for (const part of pathParts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function extractProjectId(payload: Record<string, unknown>): string | undefined {
  return asString(payload.projectId)
    ?? asString(readNested(payload, ['project', 'id']))
    ?? asString(readNested(payload, ['status', 'projectId']))
    ?? asString(readNested(payload, ['after', 'projectId']))
    ?? asString(readNested(payload, ['before', 'projectId']));
}

function extractRevisionId(payload: Record<string, unknown>): string | undefined {
  return asString(payload.revisionId)
    ?? asString(payload.verifiedRevisionId)
    ?? asString(readNested(payload, ['status', 'revisionId']))
    ?? asString(readNested(payload, ['validation', 'revisionId']))
    ?? asString(readNested(payload, ['provenance', 'revisionId']));
}

function extractAffectedObjectIds(payload: Record<string, unknown>): string[] | undefined {
  return asStringArray(payload.affectedObjectIds)
    ?? asStringArray(readNested(payload, ['summary', 'affectedObjectIds']));
}

function extractAffectedShotIds(payload: Record<string, unknown>): string[] | undefined {
  return asStringArray(payload.affectedShotIds)
    ?? asStringArray(payload.shotIds)
    ?? asStringArray(readNested(payload, ['summary', 'affectedShotIds']))
    ?? asStringArray(readNested(payload, ['failedShotIds']));
}

function warningFromUnknown(entry: unknown): AgentCliWarning | undefined {
  if (typeof entry === 'string' && entry.length > 0) return { message: entry };
  if (!isRecord(entry)) return undefined;
  const message = asString(entry.message);
  if (!message) return undefined;
  const severity = asString(entry.severity);
  if (severity === 'error') return undefined;
  return { code: asString(entry.code), message };
}

function extractWarnings(payload: Record<string, unknown>): AgentCliWarning[] {
  const collected: AgentCliWarning[] = [];
  for (const key of ['warnings', 'diagnostics'] as const) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const warning = warningFromUnknown(entry);
      if (warning) collected.push(warning);
    }
  }
  return collected;
}

function extractError(payload: Record<string, unknown>): AgentCliErrorObject | undefined {
  const error = payload.error;
  if (typeof error === 'string' && error.length > 0) {
    return { code: asString(payload.code) ?? 'operation_failed', message: error };
  }
  if (isRecord(error)) {
    const message = asString(error.message);
    if (message) {
      return { code: asString(error.code) ?? 'operation_failed', message };
    }
  }
  const diagnostics = payload.diagnostics;
  if (Array.isArray(diagnostics)) {
    for (const entry of diagnostics) {
      if (!isRecord(entry)) continue;
      if (asString(entry.severity) === 'warning') continue;
      const message = asString(entry.message);
      if (message) {
        return { code: asString(entry.code) ?? 'operation_failed', message };
      }
    }
  }
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (typeof first === 'string') return { code: 'operation_failed', message: first };
    if (isRecord(first) && asString(first.message)) {
      return { code: asString(first.code) ?? 'operation_failed', message: asString(first.message)! };
    }
  }
  return { code: 'operation_failed', message: 'Operation failed.' };
}

export function isAgentCliEnvelope(value: unknown): value is AgentCliEnvelope {
  if (!isRecord(value)) return false;
  return typeof value.ok === 'boolean'
    && typeof value.operation === 'string'
    && typeof value.durationMs === 'number'
    && Array.isArray(value.warnings)
    && 'result' in value;
}

export function wrapAgentCliStdout(context: CliStdoutContext, value: unknown): AgentCliEnvelope {
  if (isAgentCliEnvelope(value)) return value;
  const payload = isRecord(value) ? value : { value };
  const ok = 'ok' in payload ? Boolean(payload.ok) : true;
  const envelope: AgentCliEnvelope = {
    ok,
    operation: context.operation,
    durationMs: Math.max(0, Date.now() - context.startedAt),
    warnings: extractWarnings(payload),
    result: value,
  };
  if (context.operationId) envelope.operationId = context.operationId;
  if (context.profileRecovery) envelope.profileRecovery = context.profileRecovery;
  const projectId = extractProjectId(payload);
  const revisionId = extractRevisionId(payload);
  const affectedObjectIds = extractAffectedObjectIds(payload);
  const affectedShotIds = extractAffectedShotIds(payload);
  if (projectId) envelope.projectId = projectId;
  if (revisionId) envelope.revisionId = revisionId;
  if (affectedObjectIds) envelope.affectedObjectIds = affectedObjectIds;
  if (affectedShotIds) envelope.affectedShotIds = affectedShotIds;
  if (!ok) envelope.error = extractError(payload);
  return envelope;
}

export function envelopeFromError(
  context: CliStdoutContext,
  error: unknown,
  exitCode: AgentCliExitCode = AGENT_CLI_EXIT.failure,
): { envelope: AgentCliEnvelope; exitCode: AgentCliExitCode } {
  const usage = error instanceof AgentCliUsageError;
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: usage ? AGENT_CLI_EXIT.usage : exitCode,
    envelope: {
      ok: false,
      operation: context.operation,
      operationId: context.operationId,
      durationMs: Math.max(0, Date.now() - context.startedAt),
      warnings: [],
      error: {
        code: usage ? 'usage_error' : 'operation_failed',
        message,
      },
      result: null,
    },
  };
}
