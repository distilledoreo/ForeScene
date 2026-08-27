/**
 * Shared CLI --shot / --shots parsing and command arity.
 *
 * Omitted flags are distinct from an explicit selection. Unknown or empty
 * explicit selections fail visual validation; single-shot commands reject
 * extra ids before the browser opens.
 */

import { matchShotsByShotNumber } from '../../src/engine/agent/shotNumberMatch';

export interface CliShotReference {
  id: string;
  shotNumber: string;
}

export interface CliShotAmbiguity {
  selector: string;
  candidates: CliShotReference[];
}

export type ResolveCliShotReferencesResult =
  | { ok: true; shots: CliShotReference[] }
  | {
    ok: false;
    error: string;
    unknownSelectors: string[];
    ambiguous: CliShotAmbiguity[];
  };

/**
 * One resolver for every CLI shot selector.
 *
 * Order: exact id → exact shotNumber → padding-normalized shotNumber.
 * Multiple matches are ambiguous and fail closed with candidate ids; resolved
 * references carry the canonical id and shotNumber so every result can echo
 * both. Duplicate selections resolve to one shot.
 */
export function resolveCliShotReferences(
  available: readonly CliShotReference[],
  requested: readonly string[],
): ResolveCliShotReferencesResult {
  const shots: CliShotReference[] = [];
  const unknownSelectors: string[] = [];
  const ambiguous: CliShotAmbiguity[] = [];
  for (const selector of requested) {
    const trimmed = selector.trim();
    if (!trimmed) {
      unknownSelectors.push(selector);
      continue;
    }
    const byId = available.find((shot) => shot.id === trimmed);
    const matches = byId ? [byId] : matchShotsByShotNumber(available, trimmed);
    if (matches.length === 0) {
      unknownSelectors.push(selector);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push({
        selector,
        candidates: matches.map(({ id, shotNumber }) => ({ id, shotNumber })),
      });
      continue;
    }
    const shot = matches[0]!;
    if (!shots.some((existing) => existing.id === shot.id)) shots.push(shot);
  }
  if (unknownSelectors.length > 0 || ambiguous.length > 0) {
    const parts: string[] = [];
    if (unknownSelectors.length > 0) {
      parts.push(`Unknown shot id(s) or number(s): ${unknownSelectors.join(', ')}.`);
    }
    if (ambiguous.length > 0) {
      for (const entry of ambiguous) {
        parts.push(
          `Shot selector "${entry.selector}" matched ${entry.candidates.length} shots (`
          + entry.candidates.map((candidate) => `${candidate.shotNumber} (${candidate.id})`).join(', ')
          + '); use the canonical shot id.',
        );
      }
    }
    return { ok: false, error: parts.join(' '), unknownSelectors, ambiguous };
  }
  return { ok: true, shots };
}

export interface CliShotSelection {
  /** True when --shot or --shots appeared on the command line. */
  explicit: boolean;
  shotIds: string[];
}

export function emptyCliShotSelection(): CliShotSelection {
  return { explicit: false, shotIds: [] };
}

function requireShotFlagValue(flag: '--shot' | '--shots', rawValue: string | undefined): string {
  if (rawValue === undefined || rawValue.startsWith('--')) {
    throw new Error(`${flag} requires a shot id or comma-separated list of shot ids/numbers.`);
  }
  return rawValue;
}

export function parseShotFlagValue(flag: '--shot' | '--shots', rawValue: string | undefined): string[] {
  const value = requireShotFlagValue(flag, rawValue);
  if (flag === '--shot') {
    const id = value.trim();
    return id ? [id] : [];
  }
  return value.split(',').map((item) => item.trim()).filter((id) => id.length > 0);
}

export function appendCliShotFlag(
  selection: CliShotSelection,
  flag: '--shot' | '--shots',
  rawValue: string | undefined,
): CliShotSelection {
  return {
    explicit: true,
    shotIds: [...selection.shotIds, ...parseShotFlagValue(flag, rawValue)],
  };
}

/** Browser/API input: omitted flags stay undefined; explicit flags keep the array. */
export function toVisualCollectionInput(selection: CliShotSelection): { shotIds?: string[] } {
  return selection.explicit ? { shotIds: selection.shotIds } : {};
}

export function toOptionalRequestedShotIds(selection: CliShotSelection): string[] | undefined {
  return selection.explicit ? selection.shotIds : undefined;
}

export function requireSingleShotId(command: string, selection: CliShotSelection): string {
  if (!selection.explicit || selection.shotIds.length === 0) {
    throw new Error(`${command} requires --shot <shot-id-or-number>.`);
  }
  if (selection.shotIds.length > 1) {
    throw new Error(
      `${command} accepts exactly one shot id. Received ${selection.shotIds.length} (${selection.shotIds.join(', ')}). Pass a single --shot or one --shots value.`,
    );
  }
  return selection.shotIds[0]!;
}

export function requireOptionalSingleShotId(command: string, selection: CliShotSelection): string | undefined {
  if (!selection.explicit) return undefined;
  if (selection.shotIds.length === 0) {
    throw new Error(
      `${command} received an empty --shot/--shots selection. Omit the flag to inspect the whole project, or pass exactly one shot id.`,
    );
  }
  if (selection.shotIds.length > 1) {
    throw new Error(
      `${command} accepts at most one --shot. Received ${selection.shotIds.length} ids (${selection.shotIds.join(', ')}). The API inspects one optional shotId; pass a single id or omit the flag for the whole project.`,
    );
  }
  return selection.shotIds[0];
}

export interface CliCommandShotUsage {
  requestedShotIds?: string[];
  shotId?: string;
  visualCollectionInput: { shotIds?: string[] };
}

/**
 * Command-level shot contract used by verify / frame / video / asset-contract.
 * Call this before opening the browser so multi-id values cannot be truncated.
 */
export function resolveCliCommandShotUsage(command: string, selection: CliShotSelection): CliCommandShotUsage {
  if (command === 'frame' || command === 'video' || command === 'shot-panorama' || command === 'world-depth') {
    const shotId = requireSingleShotId(command, selection);
    return {
      shotId,
      requestedShotIds: [shotId],
      visualCollectionInput: { shotIds: [shotId] },
    };
  }
  if (command === 'asset-contract') {
    const shotId = requireOptionalSingleShotId(command, selection);
    return {
      shotId,
      requestedShotIds: shotId ? [shotId] : undefined,
      visualCollectionInput: shotId ? { shotIds: [shotId] } : {},
    };
  }
  return {
    requestedShotIds: toOptionalRequestedShotIds(selection),
    visualCollectionInput: toVisualCollectionInput(selection),
  };
}

/** Verify wiring: selected ids reach collectVisualPreflightValidation. */
export function collectVerifyVisualPreflight<T>(
  collect: (input?: { shotIds?: string[] }) => T,
  selection: CliShotSelection,
): T {
  const input = toVisualCollectionInput(selection);
  return Object.keys(input).length > 0 ? collect(input) : collect();
}
