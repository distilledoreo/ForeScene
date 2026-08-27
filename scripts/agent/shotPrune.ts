/**
 * Scaffold-aware previs shot-prune decision.
 *
 * After shot compilation the previs runner prunes leftover shots that are not
 * in the manifest. Blank-project scaffold shots (the Origin shot) are safe to
 * prune because they carry no user work; any other non-manifest shot is real
 * content and is retained (and reported) unless the operator explicitly passes
 * --prune-non-manifest-shots.
 */

export interface PrunableShotInfo {
  id: string;
  shotNumber: string;
  /** True for intact origin-scaffold shots (tagged and still matching their snapshot). */
  isIntactScaffold: boolean;
}

export interface ShotPruneDecision {
  /** Shots safe to delete under the current authorization. */
  prune: PrunableShotInfo[];
  /** Non-manifest user shots kept alive; reported so operators can decide. */
  retainedNonManifest: PrunableShotInfo[];
}

export function selectPrunableShots(
  liveShots: readonly PrunableShotInfo[],
  keepShotNumbers: ReadonlySet<string>,
  options: { pruneNonManifest: boolean },
): ShotPruneDecision {
  const prune: PrunableShotInfo[] = [];
  const retainedNonManifest: PrunableShotInfo[] = [];
  for (const shot of liveShots) {
    if (keepShotNumbers.has(shot.shotNumber)) continue;
    if (shot.isIntactScaffold || options.pruneNonManifest) {
      prune.push(shot);
    } else {
      retainedNonManifest.push(shot);
    }
  }
  return { prune, retainedNonManifest };
}
