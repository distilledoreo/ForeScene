import { describe, expect, it } from 'vitest';
import type { AgentVisualPreflightResult } from '../src/engine/agent/protocol';
import {
  collectVisualPreflightResults,
  selectAgentShotsForValidation,
} from '../src/engine/agent/visualValidation';

const shots = [
  { id: 'shot_1', shotNumber: '01' },
  { id: 'shot_2', shotNumber: '02' },
];

function fakePreflight(shotId: string): AgentVisualPreflightResult {
  return {
    shotId,
    ok: true,
    gateStatus: 'passed',
    score: 1,
    checks: [],
    diagnostics: [],
    subjects: [],
  };
}

describe('visual shot selection', () => {
  it('treats omitted requested ids as every shot', () => {
    const resolved = selectAgentShotsForValidation(shots, undefined);
    expect(resolved.explicitSelection).toBe(false);
    expect(resolved.selected.map((shot) => shot.id)).toEqual(['shot_1', 'shot_2']);
    expect(resolved.unmatchedIds).toEqual([]);
  });

  it('treats an explicit empty array as a failed selection, not every shot', () => {
    const collected = collectVisualPreflightResults({
      shots,
      requestedShotIds: [],
      inspect: (shotId) => fakePreflight(shotId),
    });
    expect(collected.ok).toBe(false);
    expect(collected.selection.explicitSelection).toBe(true);
    expect(collected.selection.selectedShotIds).toEqual([]);
    expect(collected.visualPreflight).toEqual([]);
    expect(collected.selection.diagnostic).toMatch(/no shot results/i);
  });

  it('fails when any requested id is unmatched even if others resolve', () => {
    const collected = collectVisualPreflightResults({
      shots,
      requestedShotIds: ['01', 'missing'],
      inspect: (shotId) => fakePreflight(shotId),
    });
    expect(collected.ok).toBe(false);
    expect(collected.visualPreflight).toEqual([]);
    expect(collected.selection.unmatchedShotIds).toEqual(['missing']);
    expect(collected.selection.diagnostic).toMatch(/missing/);
  });
});
