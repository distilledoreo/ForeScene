/**
 * Resolve agent entity targets against a project plus plan-local refs.
 * Name queries that match multiple entities return ambiguous_target —
 * the engine never silently picks the first match.
 */

import type { LocationProject } from '../../domain/types';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  type AgentDiagnostic,
} from './diagnostics';
import { listObjectsSnapshot } from './inspection';
import type { AgentEntityReference, AgentEntityTarget } from './protocol';

export type ResolveTargetResult =
  | { ok: true; id: string; fromRef?: string }
  | { ok: false; diagnostics: AgentDiagnostic[] };

function nameMatches(
  candidate: string,
  query: string,
  match: 'exact' | 'contains',
): boolean {
  if (match === 'exact') return candidate === query;
  return candidate.toLowerCase().includes(query.toLowerCase());
}

export function resolveObjectTarget(
  project: LocationProject,
  target: AgentEntityTarget,
  refs: Record<string, AgentEntityReference>,
): ResolveTargetResult {
  if ('id' in target && typeof target.id === 'string') {
    const found = project.scene.objects.some((object) => object.id === target.id);
    if (!found) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No object with id "${target.id}".`,
            { path: 'object.id' },
          ),
        ],
      };
    }
    return { ok: true, id: target.id };
  }

  if ('ref' in target) {
    const resolved = refs[target.ref];
    if (!resolved || resolved.kind !== 'object') {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `Unknown object ref "${target.ref}".`,
            { path: 'object.ref' },
          ),
        ],
      };
    }
    return { ok: true, id: resolved.id, fromRef: target.ref };
  }

  if ('query' in target) {
    const matches = listObjectsSnapshot(project, target.query);
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            'No object matched the query.',
            { path: 'object.query' },
          ),
        ],
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.ambiguousTarget,
            `Object query matched ${matches.length} entities; refine the query.`,
            {
              path: 'object.query',
              candidates: matches.map((match) => match.id),
            },
          ),
        ],
      };
    }
    return { ok: true, id: matches[0]!.id };
  }

  return {
    ok: false,
    diagnostics: [
      agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'Object target must include id, ref, or query.',
        { path: 'object' },
      ),
    ],
  };
}

export function resolveShotTarget(
  project: LocationProject,
  target: AgentEntityTarget,
  refs: Record<string, AgentEntityReference>,
): ResolveTargetResult {
  if ('id' in target && typeof target.id === 'string') {
    const found = project.shots.some((shot) => shot.id === target.id);
    if (!found) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No shot with id "${target.id}".`,
            { path: 'shot.id' },
          ),
        ],
      };
    }
    return { ok: true, id: target.id };
  }

  if ('ref' in target) {
    const resolved = refs[target.ref];
    if (!resolved || resolved.kind !== 'shot') {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `Unknown shot ref "${target.ref}".`,
            { path: 'shot.ref' },
          ),
        ],
      };
    }
    return { ok: true, id: resolved.id, fromRef: target.ref };
  }

  if ('query' in target) {
    const match = target.query.match ?? 'contains';
    const name = target.query.name;
    const matches = project.shots.filter((shot) => {
      if (name === undefined) return true;
      return nameMatches(shot.name, name, match);
    });
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            'No shot matched the query.',
            { path: 'shot.query' },
          ),
        ],
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.ambiguousTarget,
            `Shot query matched ${matches.length} entities; refine the query.`,
            {
              path: 'shot.query',
              candidates: matches.map((shot) => shot.id),
            },
          ),
        ],
      };
    }
    return { ok: true, id: matches[0]!.id };
  }

  return {
    ok: false,
    diagnostics: [
      agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'Shot target must include id, ref, or query.',
        { path: 'shot' },
      ),
    ],
  };
}
