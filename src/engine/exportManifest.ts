import { LocationProject, PanoReference, Shot } from '../domain/types';
import { getShotPackageBaseName } from './exportNaming';
import {
  createExportPlan,
  createLegacyShotManifest,
  getPlannedShot,
  type ShotPackageManifest,
} from './exportPlan';
import { generateImagePrompt, generateVideoPrompt } from './prompts';
import { listMissingProjectAssetWarnings } from './projectAssetRecovery';

export type { ShotPackageManifest } from './exportPlan';

export const PRIORITY_EXPORT_PATH_MARKERS = ['/outputs/ai_result_frame.png'] as const;

export function selectExportPathPreview(paths: readonly string[], limit: number): string[] {
  if (paths.length <= limit) return [...paths];

  const isPriority = (path: string) => PRIORITY_EXPORT_PATH_MARKERS.some((marker) => path.includes(marker));
  const selected = new Set<string>();

  for (const path of paths) {
    if (isPriority(path)) selected.add(path);
  }
  for (const path of paths) {
    if (selected.size >= limit) break;
    if (!selected.has(path)) selected.add(path);
  }

  return paths.filter((path) => selected.has(path));
}

/**
 * Predicted package inventory for one shot.
 * Delegates to the shared ExportPlan so preview and packaging agree.
 */
export function createShotPackageManifest(
  project: LocationProject,
  shot: Shot,
  rootFolder = getShotPackageBaseName(shot),
): ShotPackageManifest {
  const plan = createExportPlan(project, [shot], { packageType: 'current-shot' });
  const shotPlan = getPlannedShot(plan, shot.id);
  if (!shotPlan) {
    return { rootFolder, files: [], missingAssets: listMissingProjectAssetWarnings(project) };
  }
  const manifest = createLegacyShotManifest(shotPlan);
  const missingAssets = listMissingProjectAssetWarnings(project);
  // Preserve caller-supplied root folder when explicitly provided (collision suffixes).
  if (rootFolder !== shotPlan.rootFolder) {
    const rewrite = (path: string) => (
      path === shotPlan.rootFolder || path.startsWith(`${shotPlan.rootFolder}/`)
        ? `${rootFolder}${path.slice(shotPlan.rootFolder.length)}`
        : path
    );
    return {
      rootFolder,
      files: manifest.files.map((file) => ({ ...file, path: rewrite(file.path) })),
      missingAssets,
    };
  }
  return { ...manifest, missingAssets };
}

export function buildShotMetadata(project: LocationProject, shot: Shot, linkedPano?: PanoReference) {
  return {
    project: {
      id: project.id,
      name: project.name,
      schemaVersion: project.schemaVersion,
      units: project.units,
    },
    shot,
    linkedPano,
    missingAssets: listMissingProjectAssetWarnings(project),
    landmarks: project.landmarks.filter((landmark) => shot.landmarkIds.includes(landmark.id)),
    prompts: {
      image: generateImagePrompt(project, shot),
      video: generateVideoPrompt(shot),
      negative: shot.promptOverrides.negativePrompt || '',
    },
  };
}
