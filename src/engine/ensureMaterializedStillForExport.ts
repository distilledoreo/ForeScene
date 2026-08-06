import type { LocationProject, Shot } from '../domain/types';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from './stillArtifactTypes';
import { materializeStillArtifact } from './materializeStillArtifact';

export interface EnsureMaterializedStillResult {
  project: LocationProject;
  assetId?: string;
  fingerprint: string;
  blob?: Blob;
  source: 'materialized-asset' | 'render-recovery';
  readiness: 'ready' | 'recovered' | 'missing';
}

export async function ensureMaterializedStillForExport(params: {
  frozenProject: LocationProject;
  shot: Shot;
  specification: StillArtifactSpecification;
  allowRecoveryRender: boolean;
  signal?: AbortSignal;
}): Promise<EnsureMaterializedStillResult> {
  const { frozenProject, shot, specification, allowRecoveryRender, signal } = params;
  const fp = computeStillArtifactFingerprint(frozenProject, shot, specification);
  const key = stillArtifactKey(specification);
  const frozenShot = frozenProject.shots.find((s) => s.id === shot.id) ?? shot;
  const existing = frozenShot.materializedMedia?.stills[key];
  if (existing && existing.fingerprint === fp.key) {
    const asset = frozenProject.assets.assets[existing.assetId];
    if (asset) {
      return { project: frozenProject, assetId: existing.assetId, fingerprint: fp.key, source: 'materialized-asset', readiness: 'ready' };
    }
  }
  // Missing or stale
  if (!allowRecoveryRender) {
    return { project: frozenProject, fingerprint: fp.key, source: 'render-recovery', readiness: 'missing' };
  }
  // Recovery render: render and persist into frozenProject snapshot.
  const result = await materializeStillArtifact({ project: frozenProject, shotId: shot.id, specification, signal });
  return { project: result.project, assetId: result.artifact.assetId, fingerprint: fp.key, blob: result.blob, source: 'render-recovery', readiness: 'recovered' };
}
