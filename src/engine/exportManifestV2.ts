/**
 * forescene-v2 package manifests (root + per-shot) and the self-contained
 * START_HERE.html landing page. Consumes an already-built `ExportPlan` so the
 * manifests describe exactly what the writer put in the archive.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  SHARED_REFERENCE_KINDS,
  type ExportPlan,
  type PlannedFileKind,
  type PlannedShotExport,
} from './exportPlan';
import { getShotExportProgressLabel } from './exportNaming';
import { parseSharedPanoramaFolder, v2ShotManifest } from './exportPaths';

export const FORESCENE_PACKAGE_MANIFEST_VERSION = 2 as const;

export interface ForeSceneV2RootManifestShotEntry {
  id: string;
  folder: string;
  manifestPath: string;
  label: string;
}

export interface ForeSceneV2RootManifestSharedFile {
  path: string;
  role: string;
}

export interface ForeSceneV2RootManifestSharedReference {
  id: string;
  kind: string;
  folder: string;
  files: ForeSceneV2RootManifestSharedFile[];
}

export interface ForeSceneV2RootManifest {
  schemaVersion: typeof FORESCENE_PACKAGE_MANIFEST_VERSION;
  format: 'forescene-v2';
  projectId: string;
  projectName: string;
  packageType: string;
  profileId: string;
  createdAt: string;
  shots: ForeSceneV2RootManifestShotEntry[];
  sharedReferences: ForeSceneV2RootManifestSharedReference[];
}

export interface ForeSceneV2ShotManifestFile {
  path: string;
  kind: PlannedFileKind;
  role: string;
}

export interface ForeSceneV2ShotManifest {
  schemaVersion: typeof FORESCENE_PACKAGE_MANIFEST_VERSION;
  format: 'forescene-v2';
  shotId: string;
  folder: string;
  sharedReferenceIds: string[];
  files: ForeSceneV2ShotManifestFile[];
}

/** Descriptive role derived from a shared reference file's name (for manifest readability). */
function deriveSharedFileRole(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (base === 'panorama.png') return 'panorama';
  if (base === 'graybox.png') return 'graybox';
  if (base === 'cubemap_stitched.png') return 'cubemap_stitched';
  const faceMatch = /^([a-z]{2})\.png$/.exec(base);
  if (faceMatch) return `cubemap_face_${faceMatch[1]}`;
  return base.replace(/\.[^.]+$/, '');
}

/** Descriptive role derived from a shot file's name (for manifest readability). */
function deriveShotFileRole(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

export function buildForeSceneV2RootManifest(
  plan: ExportPlan,
  project: LocationProject,
  shots: readonly Shot[],
): ForeSceneV2RootManifest {
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const shotEntries: ForeSceneV2RootManifestShotEntry[] = plan.shots.map((shotPlan) => {
    const shot = shotById.get(shotPlan.shotId);
    return {
      id: shotPlan.shotId,
      folder: shotPlan.rootFolder,
      manifestPath: v2ShotManifest(shotPlan.rootFolder),
      label: shot ? getShotExportProgressLabel(shot) : shotPlan.rootFolder,
    };
  });

  const sharedReferences: ForeSceneV2RootManifestSharedReference[] = plan.sharedArtifacts
    .filter((artifact) => artifact.disposition === 'produce' && SHARED_REFERENCE_KINDS.has(artifact.kind))
    .map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      folder: parseSharedPanoramaFolder(artifact.files[0]?.path ?? '') ?? 'panorama',
      files: artifact.files.map((file) => ({ path: file.path, role: deriveSharedFileRole(file.path) })),
    }));

  return {
    schemaVersion: FORESCENE_PACKAGE_MANIFEST_VERSION,
    format: 'forescene-v2',
    projectId: project.id,
    projectName: project.name,
    packageType: plan.packageType,
    profileId: plan.profileId,
    createdAt: new Date().toISOString(),
    shots: shotEntries,
    sharedReferences,
  };
}

export function buildForeSceneV2ShotManifest(
  shotPlan: PlannedShotExport,
  shot: Shot,
): ForeSceneV2ShotManifest {
  const files = shotPlan.artifacts
    .filter((artifact) => artifact.disposition === 'produce')
    .flatMap((artifact) => artifact.files)
    .filter((file) => file.manifestEntry)
    .map((file) => ({ path: file.path, kind: file.kind, role: deriveShotFileRole(file.path) }));

  return {
    schemaVersion: FORESCENE_PACKAGE_MANIFEST_VERSION,
    format: 'forescene-v2',
    shotId: shot.id,
    folder: shotPlan.rootFolder,
    sharedReferenceIds: shotPlan.sharedReferenceIds,
    files,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Self-contained landing page: inline CSS only, no external scripts/fonts/CDNs. */
export function buildStartHereHtml(
  plan: ExportPlan,
  project: LocationProject,
  shots: readonly Shot[],
): string {
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const shotRows = plan.shots.map((shotPlan) => {
    const shot = shotById.get(shotPlan.shotId);
    const label = shot ? getShotExportProgressLabel(shot) : shotPlan.rootFolder;
    const manifestPath = v2ShotManifest(shotPlan.rootFolder);
    return `<tr><td>${escapeHtml(label)}</td><td><a href="${escapeHtml(manifestPath)}">${escapeHtml(shotPlan.rootFolder)}</a></td></tr>`;
  }).join('\n');

  const sharedRows = plan.sharedArtifacts
    .filter((artifact) => artifact.disposition === 'produce' && SHARED_REFERENCE_KINDS.has(artifact.kind))
    .map((artifact) => {
      const folder = parseSharedPanoramaFolder(artifact.files[0]?.path ?? '') ?? 'panorama';
      const dirPath = `shared_references/panoramas/${folder}/`;
      return `<tr><td>${escapeHtml(artifact.kind)}</td><td><a href="${escapeHtml(dirPath)}">${escapeHtml(folder)}</a></td></tr>`;
    }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(project.name)} — ForeScene package</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #14161a; color: #e8eaed; margin: 0; padding: 2rem; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin-bottom: 0.5rem; color: #cbd0d6; }
  p.meta { color: #9aa0a6; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #2a2d33; font-size: 0.9rem; }
  th { color: #9aa0a6; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; }
  a { color: #8ab4f8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  section { margin-top: 2rem; }
</style>
</head>
<body>
<h1>${escapeHtml(project.name)}</h1>
<p class="meta">ForeScene package v2 &middot; ${escapeHtml(plan.packageType)} &middot; generated ${escapeHtml(new Date().toISOString())}</p>

<section>
<h2>Shots</h2>
<table>
<thead><tr><th>Shot</th><th>Folder</th></tr></thead>
<tbody>
${shotRows || '<tr><td colspan="2">None</td></tr>'}
</tbody>
</table>
</section>

<section>
<h2>Shared references</h2>
<table>
<thead><tr><th>Kind</th><th>Folder</th></tr></thead>
<tbody>
${sharedRows || '<tr><td colspan="2">None</td></tr>'}
</tbody>
</table>
</section>
</body>
</html>
`;
}
