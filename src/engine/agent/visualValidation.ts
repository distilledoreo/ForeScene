/**
 * Shot selection and visual-gate collection for CLI/API validation.
 *
 * Contract:
 * - Omitting visual results (caller did not request the gate) → skipped.
 * - Explicitly supplying zero visual results → failed, never a passed gate.
 * - An explicit `--shots` / shot-id selection that matches nothing → failed
 *   with unmatched ids. Any unmatched requested id fails the whole selection
 *   (same rule as other CLI shot resolvers).
 * - `verify` / visual-preflight with no requested ids on a project that has
 *   no shots omits the visual gate (skipped). Empty projects are a supported
 *   state; they are not a vacuous visual pass.
 */

import type {
  AgentVisualPreflightCollection,
  AgentVisualPreflightResult,
  AgentVisualPreflightSelection,
} from './protocol';

export interface AgentShotSelectionTarget {
  id: string;
  shotNumber: string;
}

export function selectAgentShotsForValidation<T extends AgentShotSelectionTarget>(
  shots: readonly T[],
  requestedIds?: readonly string[],
): {
  selected: T[];
  requestedIds: string[];
  unmatchedIds: string[];
  explicitSelection: boolean;
  emptyProject: boolean;
} {
  const explicitSelection = requestedIds !== undefined;
  const requested = (requestedIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (!explicitSelection) {
    return {
      selected: [...shots],
      requestedIds: [],
      unmatchedIds: [],
      explicitSelection: false,
      emptyProject: shots.length === 0,
    };
  }

  const selected: T[] = [];
  const unmatchedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of requested) {
    const match = shots.find((shot) => shot.id === id || shot.shotNumber === id);
    if (!match) {
      unmatchedIds.push(id);
      continue;
    }
    if (seen.has(match.id)) continue;
    seen.add(match.id);
    selected.push(match);
  }
  return {
    selected,
    requestedIds: requested,
    unmatchedIds,
    explicitSelection: true,
    emptyProject: shots.length === 0,
  };
}

function describeUnmatchedSelection(unmatchedIds: string[]): string {
  return unmatchedIds.length === 0
    ? 'Visual preflight was requested but no shot results were supplied.'
    : `Requested visual selection includes unknown shot id(s): ${unmatchedIds.join(', ')}.`;
}

export function collectVisualPreflightResults(input: {
  shots: ReadonlyArray<AgentShotSelectionTarget>;
  requestedShotIds?: readonly string[];
  inspect: (shotId: string) => AgentVisualPreflightResult;
}): AgentVisualPreflightCollection {
  const resolved = selectAgentShotsForValidation(input.shots, input.requestedShotIds);
  const selectionBase: AgentVisualPreflightSelection = {
    selectedShotIds: resolved.selected.map((shot) => shot.id),
    unmatchedShotIds: resolved.unmatchedIds,
    requestedShotIds: resolved.requestedIds,
    emptyProject: resolved.emptyProject,
    explicitSelection: resolved.explicitSelection,
  };

  if (resolved.explicitSelection && (resolved.unmatchedIds.length > 0 || resolved.selected.length === 0)) {
    const diagnostic = describeUnmatchedSelection(resolved.unmatchedIds);
    return {
      ok: false,
      selection: { ...selectionBase, diagnostic },
      visualPreflight: [],
    };
  }

  if (!resolved.explicitSelection && resolved.emptyProject) {
    return {
      ok: true,
      selection: selectionBase,
    };
  }

  return {
    ok: true,
    selection: selectionBase,
    visualPreflight: resolved.selected.map((shot) => input.inspect(shot.id)),
  };
}

export function emptyVisualSelectionDiagnostic(unmatchedShotIds: readonly string[] = []): string {
  return describeUnmatchedSelection([...unmatchedShotIds]);
}
