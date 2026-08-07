/**
 * Diff / fingerprint helpers for prepared agent plans.
 */

import type { LocationProject, ProjectAsset, Shot, Workspace } from '../../domain/types';
import type { AgentPlanDiff, AgentPlanSummary, AgentEntityReference } from './protocol';

export interface AgentSelectionState {
  selectedObjectIds: string[];
  selectedShotId?: string;
  workspace: Workspace;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function fingerprintHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isPreparedDerivedAsset(asset: ProjectAsset): boolean {
  const provenance = asset.metadata?.provenance;
  return provenance === 'forescene-derived-still'
    || provenance === 'forescene-export-recovery-temporary';
}

/**
 * Agent stale-plan/undo fingerprints represent authored project state, not
 * asynchronously regenerated prepared references. Prepared still attachment can
 * legitimately occur immediately after an agent edit; treating that as a user
 * edit would make undo stale even though no authored state changed.
 */
function authoredProjectFingerprintState(project: LocationProject): unknown {
  const preparedAssetIds = new Set<string>();
  for (const [assetId, asset] of Object.entries(project.assets.assets)) {
    if (isPreparedDerivedAsset(asset)) preparedAssetIds.add(assetId);
  }
  for (const shot of project.shots) {
    for (const artifact of Object.values(shot.materializedMedia?.stills ?? {})) {
      preparedAssetIds.add(artifact.assetId);
    }
  }

  const normalizeShot = (shot: Shot) => {
    const {
      materializedMedia: _materializedMedia,
      updatedAt: _updatedAt,
      ...authoredShot
    } = shot;
    const assets = { ...shot.assets };
    const preparedLegacySlots: Array<keyof Shot['assets']> = [
      'viewportRenderAssetId',
      'viewportCleanPlateAssetId',
      'viewportProjectedAssetId',
      'viewportProjectedCleanPlateAssetId',
    ];
    for (const slot of preparedLegacySlots) {
      const assetId = assets[slot];
      if (assetId && preparedAssetIds.has(assetId)) delete assets[slot];
    }
    return { ...authoredShot, assets };
  };

  const {
    updatedAt: _updatedAt,
    ...authoredProject
  } = project;
  return {
    ...authoredProject,
    assets: {
      ...project.assets,
      assets: Object.fromEntries(
        Object.entries(project.assets.assets)
          .filter(([assetId]) => !preparedAssetIds.has(assetId)),
      ),
    },
    shots: project.shots.map(normalizeShot),
  };
}

export function projectFingerprint(project: LocationProject): string {
  // Keep a readable structural prefix for diagnostics. The state hash excludes
  // prepared-derived media so background reconciliation does not invalidate
  // agent undo/stale-plan checks, while authored same-millisecond edits still do.
  const objectIds = project.scene.objects.map((object) => object.id).join(',');
  const shotIds = project.shots.map((shot) => shot.id).join(',');
  const landmarkIds = project.landmarks.map((landmark) => landmark.id).join(',');
  const stateHash = fingerprintHash(stableSerialize(authoredProjectFingerprintState(project)));
  return [
    project.id,
    project.name,
    String(project.scene.objects.length),
    String(project.shots.length),
    String(project.landmarks.length),
    objectIds,
    shotIds,
    landmarkIds,
    `state:${stateHash}`,
  ].join('|');
}

export function emptyPlanDiff(): AgentPlanDiff {
  return {
    objectsCreated: [],
    objectsUpdated: [],
    objectsDeleted: [],
    shotsCreated: [],
    shotsUpdated: [],
    shotsDeleted: [],
    landmarksCreated: [],
    landmarksUpdated: [],
    landmarksDeleted: [],
    selectionChanged: false,
    workspaceChanged: false,
    projectInfoChanged: false,
    exportConfigurationChanged: false,
  };
}

export function buildPlanSummary(params: {
  commandCount: number;
  description?: string;
  refs: Record<string, AgentEntityReference>;
  diff: AgentPlanDiff;
}): AgentPlanSummary {
  const affectedObjectIds = unique([
    ...params.diff.objectsCreated,
    ...params.diff.objectsUpdated,
    ...params.diff.objectsDeleted,
  ]);
  const affectedShotIds = unique([
    ...params.diff.shotsCreated,
    ...params.diff.shotsUpdated,
    ...params.diff.shotsDeleted,
  ]);
  const affectedLandmarkIds = unique([
    ...params.diff.landmarksCreated,
    ...params.diff.landmarksUpdated,
    ...params.diff.landmarksDeleted,
  ]);
  return {
    commandCount: params.commandCount,
    affectedObjectIds,
    affectedShotIds,
    affectedLandmarkIds,
    createdRefs: { ...params.refs },
    description: params.description,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function selectionChanged(
  before: AgentSelectionState,
  after: AgentSelectionState,
): boolean {
  if (before.selectedShotId !== after.selectedShotId) return true;
  if (before.selectedObjectIds.length !== after.selectedObjectIds.length) return true;
  const beforeSet = new Set(before.selectedObjectIds);
  return after.selectedObjectIds.some((id) => !beforeSet.has(id));
}