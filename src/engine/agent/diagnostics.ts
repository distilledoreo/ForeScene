/**
 * Stable diagnostic codes and helpers for the ForeScene Agent API.
 * Follows the SetBlueprint style: plain objects, no schema library.
 */

export type AgentDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface AgentDiagnostic {
  code: string;
  message: string;
  severity: AgentDiagnosticSeverity;
  path?: string;
  /** Candidate entity ids when a target query is ambiguous. */
  candidates?: string[];
}

/** Well-known diagnostic codes used across the agent surface. */
export const AGENT_DIAGNOSTIC_CODES = {
  writeAccessRequired: 'write_access_required',
  agentControlOff: 'agent_control_off',
  notImplemented: 'not_implemented',
  projectNotLoaded: 'project_not_loaded',
  targetNotFound: 'target_not_found',
  ambiguousTarget: 'ambiguous_target',
  invalidArgument: 'invalid_argument',
  busy: 'busy',
  staleRevision: 'stale_revision',
} as const;

export type AgentDiagnosticCode =
  (typeof AGENT_DIAGNOSTIC_CODES)[keyof typeof AGENT_DIAGNOSTIC_CODES];

export function agentError(
  code: string,
  message: string,
  extras: Partial<Pick<AgentDiagnostic, 'path' | 'candidates'>> = {},
): AgentDiagnostic {
  return { code, message, severity: 'error', ...extras };
}

export function agentWarning(
  code: string,
  message: string,
  extras: Partial<Pick<AgentDiagnostic, 'path' | 'candidates'>> = {},
): AgentDiagnostic {
  return { code, message, severity: 'warning', ...extras };
}

export function agentInfo(
  code: string,
  message: string,
  extras: Partial<Pick<AgentDiagnostic, 'path' | 'candidates'>> = {},
): AgentDiagnostic {
  return { code, message, severity: 'info', ...extras };
}

export function writeAccessRequiredDiagnostic(
  operation: string,
): AgentDiagnostic {
  return agentError(
    AGENT_DIAGNOSTIC_CODES.writeAccessRequired,
    `Write access is required for ${operation}. Enable Agent control (read-write) first.`,
  );
}

export function notImplementedDiagnostic(operation: string): AgentDiagnostic {
  return agentError(
    AGENT_DIAGNOSTIC_CODES.notImplemented,
    `${operation} is not available in this Agent API milestone.`,
  );
}
