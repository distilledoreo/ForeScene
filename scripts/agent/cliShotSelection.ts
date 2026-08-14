/**
 * Shared CLI --shot / --shots parsing and command arity.
 *
 * Omitted flags are distinct from an explicit selection. Unknown or empty
 * explicit selections fail visual validation; single-shot commands reject
 * extra ids before the browser opens.
 */

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
  if (command === 'frame' || command === 'video' || command === 'shot-panorama') {
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
