/**
 * Controlled manifest update — invalidate only changed work for resume.
 */

import type {
  PrevisLocationDefinition,
  PrevisProductionManifestV1,
  PrevisShotDefinition,
} from './manifest';
import {
  setPhase,
  touchRunState,
  upsertShotState,
  type PrevisRunState,
  type PrevisShotRunState,
} from './runState';

export interface ManifestUpdateDiff {
  locationsChanged: string[];
  castChanged: string[];
  propsChanged: string[];
  /** Shot numbers present in next that changed vs previous. */
  shotsChanged: string[];
  /** Shot numbers present in previous but missing from next. */
  shotsRemoved: string[];
  /** Shot numbers that must be recompiled (changed themselves or depend on changed entities). */
  shotsToInvalidate: string[];
  /** Scene phases that must rerun. */
  invalidateLocations: boolean;
  invalidateCast: boolean;
  invalidateProps: boolean;
}

export interface RemovedShotEntry {
  shotNumber: string;
  shotId?: string;
  framePath?: string;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function entityChanged<T extends { id: string }>(
  previous: T[] | undefined,
  next: T[] | undefined,
): string[] {
  const prevMap = new Map((previous ?? []).map((item) => [item.id, item]));
  const nextMap = new Map((next ?? []).map((item) => [item.id, item]));
  const changed = new Set<string>();
  for (const [id, item] of nextMap) {
    const prior = prevMap.get(id);
    if (!prior || stableJson(prior) !== stableJson(item)) changed.add(id);
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) changed.add(id);
  }
  return [...changed];
}

function shotDependsOn(
  shot: PrevisShotDefinition,
  changed: { locations: Set<string>; cast: Set<string>; props: Set<string> },
): boolean {
  if (changed.locations.has(shot.locationId)) return true;
  const subjects = new Set([
    ...shot.subjects,
    ...shot.camera.subjects,
    ...(shot.camera.foregroundSubject ? [shot.camera.foregroundSubject] : []),
    ...(shot.requirements?.visibleSubjects ?? []),
    ...(shot.requirements?.visibleProps ?? []),
    ...(shot.blocking ?? []).flatMap((instruction) => [
      instruction.subject,
      ...(instruction.face ? [instruction.face] : []),
      ...(instruction.placement.type === 'relative' ? [instruction.placement.anchor] : []),
    ]),
  ]);
  for (const subject of subjects) {
    if (changed.cast.has(subject) || changed.props.has(subject)) return true;
  }
  return false;
}

function classifyShotEdits(
  previous: PrevisShotDefinition[] | undefined,
  next: PrevisShotDefinition[] | undefined,
): { shotsChanged: string[]; shotsRemoved: string[] } {
  const prevMap = new Map((previous ?? []).map((item) => [item.shotNumber, item]));
  const nextMap = new Map((next ?? []).map((item) => [item.shotNumber, item]));
  const shotsChanged: string[] = [];
  const shotsRemoved: string[] = [];
  for (const [shotNumber, item] of nextMap) {
    const prior = prevMap.get(shotNumber);
    if (!prior || stableJson(prior) !== stableJson(item)) shotsChanged.push(shotNumber);
  }
  for (const shotNumber of prevMap.keys()) {
    if (!nextMap.has(shotNumber)) shotsRemoved.push(shotNumber);
  }
  return { shotsChanged, shotsRemoved };
}

export function diffPrevisManifests(
  previous: PrevisProductionManifestV1,
  next: PrevisProductionManifestV1,
): ManifestUpdateDiff {
  const locationsChanged = entityChanged(previous.locations, next.locations);
  const castChanged = entityChanged(previous.cast, next.cast);
  const propsChanged = entityChanged(previous.props, next.props);
  const { shotsChanged, shotsRemoved } = classifyShotEdits(previous.shots, next.shots);

  const changedSets = {
    locations: new Set(locationsChanged),
    cast: new Set(castChanged),
    props: new Set(propsChanged),
  };

  const shotsToInvalidate = new Set<string>(shotsChanged);
  for (const shot of next.shots) {
    if (shotDependsOn(shot, changedSets)) {
      shotsToInvalidate.add(shot.shotNumber);
    }
  }

  return {
    locationsChanged,
    castChanged,
    propsChanged,
    shotsChanged,
    shotsRemoved,
    shotsToInvalidate: [...shotsToInvalidate],
    invalidateLocations: locationsChanged.length > 0,
    invalidateCast: castChanged.length > 0,
    invalidateProps: propsChanged.length > 0,
  };
}

const PENDING_SHOT: PrevisShotRunState = {
  compile: 'pending',
  render: 'pending',
  video: 'pending',
  validation: 'pending',
  attempts: 0,
  renderAttempts: 0,
  repairAttempts: 0,
};

/**
 * Apply a controlled manifest update onto an existing run-state.
 * Preserves completed work for unchanged shots; invalidates dependents;
 * removes deleted shots from run-state (caller must delete them live).
 */
export function applyManifestUpdateToRunState(params: {
  state: PrevisRunState;
  previousManifest: PrevisProductionManifestV1;
  nextManifest: PrevisProductionManifestV1;
  nextManifestHash: string;
}): {
  state: PrevisRunState;
  diff: ManifestUpdateDiff;
  removedShots: RemovedShotEntry[];
} {
  const diff = diffPrevisManifests(params.previousManifest, params.nextManifest);
  let state = touchRunState({
    ...params.state,
    manifestHash: params.nextManifestHash,
  });

  const removedShots: RemovedShotEntry[] = [];
  if (diff.shotsRemoved.length > 0) {
    const nextShots = { ...state.shots };
    for (const shotNumber of diff.shotsRemoved) {
      const existing = nextShots[shotNumber];
      removedShots.push({
        shotNumber,
        shotId: existing?.shotId,
        framePath: existing?.framePath,
      });
      delete nextShots[shotNumber];
    }
    state = touchRunState({ ...state, shots: nextShots });
  }

  // Ensure every next shot has a slot.
  for (const shot of params.nextManifest.shots) {
    if (!state.shots[shot.shotNumber]) {
      state = upsertShotState(state, shot.shotNumber, { ...PENDING_SHOT });
    }
  }

  for (const shotNumber of diff.shotsToInvalidate) {
    const existing = state.shots[shotNumber];
    state = upsertShotState(state, shotNumber, {
      compile: 'pending',
      render: 'pending',
      video: 'pending',
      validation: 'pending',
      attempts: 0,
      renderAttempts: 0,
      repairAttempts: 0,
      issues: undefined,
      lastError: undefined,
      framePath: undefined,
      videoPath: undefined,
      videoAssetId: undefined,
      // Keep shotId if the live project still has it — recompile updates in place.
      shotId: existing?.shotId,
    });
  }

  if (diff.invalidateLocations) {
    state = setPhase(state, 'locations', 'pending');
    // Location rebuild implies cast/props parking may need refresh too.
    state = setPhase(state, 'cast', 'pending');
    state = setPhase(state, 'props', 'pending');
  } else {
    if (diff.invalidateCast) state = setPhase(state, 'cast', 'pending');
    if (diff.invalidateProps) state = setPhase(state, 'props', 'pending');
  }

  if (
    diff.shotsToInvalidate.length > 0
    || diff.shotsRemoved.length > 0
    || diff.invalidateLocations
    || diff.invalidateCast
    || diff.invalidateProps
  ) {
    state = setPhase(state, 'shots', 'pending');
    state = setPhase(state, 'render', 'pending');
    state = setPhase(state, 'validation', 'pending');
    state = setPhase(state, 'contactSheet', 'pending');
    state = setPhase(state, 'package', 'pending');
  }

  return { state, diff, removedShots };
}

export { locationPrimitiveBlockers, type LocationPrimitiveBlocker } from './locationBlockers';
