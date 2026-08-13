/**
 * Machine-readable asset resolution and pose-preset contract for inspect/export.
 */

import type { LocationProject, Shot } from '../../domain/types';
import { resolveHumanPosePresetId } from '../humanPosePresets';
import { listMissingProjectAssets } from '../projectAssetRecovery';
import {
  resolveProjectPackageInclusion,
  type ProducedPackageManifestProof,
} from '../projectPackageInclusion';
import type { AgentAssetPoseContract } from './protocol';
import { readActiveRevisionId } from './revisionSync';

function posePresetFromObject(shot: Shot | undefined, objectId: string, fallback?: string): {
  requestedPosePreset?: string;
  resolvedPosePreset?: string;
  poseAliased: boolean;
  poseSource: 'base' | 'shot_override' | 'keyframe' | 'none';
} {
  const overridePreset = shot?.objectOverrides?.[objectId]?.humanPose?.presetId;
  const requested = overridePreset ?? fallback;
  if (!requested) {
    return { poseAliased: false, poseSource: fallback ? 'base' : 'none' };
  }
  const resolved = resolveHumanPosePresetId(requested);
  return {
    requestedPosePreset: requested,
    resolvedPosePreset: resolved.resolvedId,
    poseAliased: resolved.aliased,
    poseSource: overridePreset ? 'shot_override' : 'base',
  };
}

export function inspectAssetPoseContract(
  project: LocationProject,
  shotId?: string,
  options?: {
    packageManifestPaths?: Iterable<string>;
    producedPackageManifest?: ProducedPackageManifestProof;
  },
): AgentAssetPoseContract {
  const missing = new Set(listMissingProjectAssets(project).map((asset) => asset.id));
  const shots = shotId
    ? project.shots.filter((shot) => shot.id === shotId)
    : project.shots;
  const objects = project.scene.objects.map((object) => {
    const shot = shots[0];
    const pose = posePresetFromObject(shot, object.id, object.humanPose?.presetId);
    const asset = object.modelAssetId ? project.assets.assets[object.modelAssetId] : undefined;
    const inclusion = resolveProjectPackageInclusion(
      project,
      object.modelAssetId,
      options?.producedPackageManifest ?? options?.packageManifestPaths,
    );
    return {
      objectId: object.id,
      name: object.name,
      type: object.type,
      modelAssetId: object.modelAssetId,
      assetStatus: object.modelAssetId
        ? (missing.has(object.modelAssetId)
          ? 'missing' as const
          : asset?.resolutionStatus === 'available'
            ? 'available' as const
            : asset?.resolutionStatus === 'corrupt'
              ? 'corrupt' as const
              : asset?.resolutionStatus === 'unsupported'
                ? 'unsupported' as const
                : 'missing' as const)
        : 'none' as const,
      includedInPackage: inclusion.includedInPackage,
      packagePath: inclusion.packagePath,
      poseable: Boolean(object.poseableCharacter || object.humanPose),
      ...pose,
    };
  });

  return {
    revisionId: readActiveRevisionId() || undefined,
    objects,
    shots: shots.map((shot) => ({
      shotId: shot.id,
      shotNumber: shot.shotNumber,
      linkedPanoId: shot.linkedPanoId,
      panoramaResolved: shot.linkedPanoId === null
        ? true
        : Boolean(shot.linkedPanoId && project.panoRefs.some((pano) => pano.id === shot.linkedPanoId)),
      stagedObjectIds: Object.keys(shot.objectOverrides ?? {}),
      poseOverrides: Object.entries(shot.objectOverrides ?? {}).flatMap(([objectId, override]) => {
        const requested = override.humanPose?.presetId;
        if (!requested) return [];
        const resolved = resolveHumanPosePresetId(requested);
        return [{
          objectId,
          requestedPosePreset: requested,
          resolvedPosePreset: resolved.resolvedId,
        }];
      }),
    })),
  };
}
