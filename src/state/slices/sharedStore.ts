import type { ContinuityStoreSlices } from './types';
import { createContinuityStoreState } from './continuityStoreImpl';

type SetFn = Parameters<typeof createContinuityStoreState>[0];
type GetFn = Parameters<typeof createContinuityStoreState>[1];

let shared: ContinuityStoreSlices | undefined;
let sharedSet: SetFn | undefined;

/**
 * One full store factory per Zustand create() set identity.
 * Domain slice creators pick partitions without re-running initializers five times.
 */
export function getSharedContinuityState(set: SetFn, get: GetFn): ContinuityStoreSlices {
  if (sharedSet !== set || !shared) {
    shared = createContinuityStoreState(set, get);
    sharedSet = set;
  }
  return shared;
}

export function pickSlice<K extends keyof ContinuityStoreSlices>(
  full: ContinuityStoreSlices,
  keys: readonly K[],
): Pick<ContinuityStoreSlices, K> {
  const slice = {} as Pick<ContinuityStoreSlices, K>;
  for (const key of keys) {
    slice[key] = full[key];
  }
  return slice;
}
