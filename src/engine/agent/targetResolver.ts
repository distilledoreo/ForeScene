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
import type { AgentEntityReference, AgentEntityTarget, AgentKeyframeTarget } from './protocol';
import { matchShotsByShotNumber, normalizeShotNumber } from './shotNumberMatch';

export type ResolveTargetResult =
  | { ok: true; id: string; fromRef?: string }
  | { ok: false; diagnostics: AgentDiagnostic[] };

export function coerceShotTarget(input?: {
  shotId?: string;
  shotNumber?: string;
  shot?: AgentEntityTarget | null;
} | AgentEntityTarget | null): AgentEntityTarget | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if ('op' in input) return undefined;
  if ('id' in input || 'ref' in input || 'query' in input || 'shotNumber' in input) {
    if (!('shotId' in input) && !('shot' in input)) {
      return input as AgentEntityTarget;
    }
  }
  const record = input as { shotId?: string; shotNumber?: string; shot?: AgentEntityTarget | null };
  if (record.shot && typeof record.shot === 'object') return record.shot;
  if (typeof record.shotId === 'string' && record.shotId.trim()) return { id: record.shotId };
  if (typeof record.shotNumber === 'string' && record.shotNumber.trim()) {
    return { shotNumber: record.shotNumber };
  }
  return undefined;
}

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
  if ('shotNumber' in target) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          'Object target does not accept shotNumber; use id, ref, or query.',
          { path: 'object.shotNumber' },
        ),
      ],
    };
  }
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

export function matchShotsByNumber(project: LocationProject, shotNumber: string) {
  return matchShotsByShotNumber(project.shots, shotNumber);
}

export function resolveShotTarget(
  project: LocationProject,
  target: AgentEntityTarget,
  refs: Record<string, AgentEntityReference>,
): ResolveTargetResult {
  if ('shotNumber' in target && typeof target.shotNumber === 'string') {
    const matches = matchShotsByNumber(project, target.shotNumber);
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No shot with shotNumber "${target.shotNumber}".`,
            { path: 'shot.shotNumber' },
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
            `shotNumber "${target.shotNumber}" matched ${matches.length} shots; use id.`,
            { path: 'shot.shotNumber', candidates: matches.map((shot) => shot.id) },
          ),
        ],
      };
    }
    return { ok: true, id: matches[0]!.id };
  }
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
    const shotNumber = target.query.shotNumber;
    const matches = project.shots.filter((shot) => {
      if (shotNumber !== undefined && shot.shotNumber !== shotNumber
        && normalizeShotNumber(shot.shotNumber) !== normalizeShotNumber(shotNumber)) {
        return false;
      }
      if (name === undefined) return shotNumber !== undefined;
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
        'Shot target must include id, ref, query, or shotNumber.',
        { path: 'shot' },
      ),
    ],
  };
}

export function resolveKeyframeTarget(
  project: LocationProject,
  shotId: string,
  target: AgentKeyframeTarget,
  refs: Record<string, AgentEntityReference>,
): ResolveTargetResult {
  const shot = project.shots.find((candidate) => candidate.id === shotId);
  if (!shot) {
    return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${shotId}".`)] };
  }
  if ('id' in target) {
    if (shot.cameraKeyframes.some((keyframe) => keyframe.id === target.id)) return { ok: true, id: target.id };
    return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No keyframe with id "${target.id}" in shot "${shotId}".`)] };
  }
  const resolved = refs[target.ref];
  if (!resolved || resolved.kind !== 'keyframe') {
    return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `Unknown keyframe ref "${target.ref}".`)] };
  }
  if (!shot.cameraKeyframes.some((keyframe) => keyframe.id === resolved.id)) {
    return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `Keyframe ref "${target.ref}" is not in shot "${shotId}".`)] };
  }
  return { ok: true, id: resolved.id, fromRef: target.ref };
}

export function resolveLandmarkTarget(
  project: LocationProject,
  target: AgentEntityTarget,
  refs: Record<string, AgentEntityReference>,
): ResolveTargetResult {
  if ('id' in target && typeof target.id === 'string') {
    const found = project.landmarks.some((landmark) => landmark.id === target.id);
    if (!found) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No landmark with id "${target.id}".`,
            { path: 'landmark.id' },
          ),
        ],
      };
    }
    return { ok: true, id: target.id };
  }

  if ('ref' in target) {
    const resolved = refs[target.ref];
    if (!resolved || resolved.kind !== 'landmark') {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `Unknown landmark ref "${target.ref}".`,
            { path: 'landmark.ref' },
          ),
        ],
      };
    }
    return { ok: true, id: resolved.id, fromRef: target.ref };
  }

  if ('query' in target) {
    const match = target.query.match ?? 'contains';
    const name = target.query.name;
    const matches = project.landmarks.filter((landmark) => {
      if (name === undefined) return true;
      return (
        nameMatches(landmark.name, name, match)
        || nameMatches(landmark.displayName, name, match)
      );
    });
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            'No landmark matched the query.',
            { path: 'landmark.query' },
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
            `Landmark query matched ${matches.length} entities; refine the query.`,
            {
              path: 'landmark.query',
              candidates: matches.map((landmark) => landmark.id),
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
        'Landmark target must include id, ref, or query.',
        { path: 'landmark' },
      ),
    ],
  };
}
