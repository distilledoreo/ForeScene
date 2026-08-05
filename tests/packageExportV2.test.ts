import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  createDefaultProject,
  createPanoAsset,
  createPanoReference,
} from '../src/domain/defaults';
import { CAMERA_MOVE_CUBEMAP_FACES, type CameraMoveCubemapFaceId } from '../src/engine/cameraMoveCubemap';
import { stitchCubemapFaceBlobsCrossAsync } from '../src/engine/cubemapStitch';
import { buildMultiShotPackage, buildShotPackage } from '../src/engine/packageExport';
import { createExportPlan, listPlannedFiles } from '../src/engine/exportPlan';
import {
  type BlobImageRenderResult,
  renderPanoCubemapFacesAsBlobs,
} from '../src/engine/renderers';
import type { LocationProject } from '../src/domain/types';

vi.mock('../src/engine/renderers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/renderers')>();
  return {
    ...actual,
    renderPanoCubemapFacesAsBlobs: vi.fn(actual.renderPanoCubemapFacesAsBlobs),
  };
});

vi.mock('../src/engine/cubemapStitch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/cubemapStitch')>();
  return {
    ...actual,
    stitchCubemapFaceBlobsCrossAsync: vi.fn(actual.stitchCubemapFaceBlobsCrossAsync),
  };
});

function mockCubemapRender() {
  const faces = Object.fromEntries(
    CAMERA_MOVE_CUBEMAP_FACES.map((face) => [
      face,
      { blob: new Blob([`face-${face}`], { type: 'image/png' }), width: 2, height: 2 },
    ]),
  ) as Record<CameraMoveCubemapFaceId, BlobImageRenderResult>;
  vi.mocked(renderPanoCubemapFacesAsBlobs).mockImplementation(async (_uri, options) => {
    for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
      await options!.onFaceRendered?.(face, faces[face]);
    }
    return { faceSize: 2, faces };
  });
  vi.mocked(stitchCubemapFaceBlobsCrossAsync).mockResolvedValue({
    blob: new Blob(['stitched-cubemap'], { type: 'image/png' }),
    width: 8,
    height: 6,
  });
}

/** Base v2 project: one canonical (styled) pano + one graybox pano, one shot. */
function withV2Project(name = 'Temple V2'): LocationProject {
  const project = createDefaultProject();
  project.name = name;
  project.exportConfiguration = {
    ...project.exportConfiguration!,
    packageFormat: 'forescene-v2',
  };

  const canonicalAsset = createPanoAsset({
    name: 'styled_reference.png',
    uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    width: 4,
    height: 2,
  });
  const canonicalPano = createPanoReference({
    name: 'Styled Reference',
    assetId: canonicalAsset.id,
    type: 'ai_global_reference',
    origin: project.scene.panoOrigin,
    width: 4,
    height: 2,
    isCanonical: true,
  });
  const grayboxAsset = createPanoAsset({
    name: 'graybox.png',
    uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    width: 4,
    height: 2,
  });
  const grayboxPano = createPanoReference({
    name: 'Graybox',
    assetId: grayboxAsset.id,
    type: 'graybox_render',
    origin: project.scene.panoOrigin,
    width: 4,
    height: 2,
    isCanonical: false,
  });
  project.assets.assets[canonicalAsset.id] = canonicalAsset;
  project.assets.assets[grayboxAsset.id] = grayboxAsset;
  project.panoRefs.push(canonicalPano, grayboxPano);
  project.workflow.grayboxApprovedForReferenceAt = new Date().toISOString();
  // Letterboxing loads the source through `Image`, unavailable in this test environment.
  project.settings.panoLetterboxExports169 = false;

  for (const shot of project.shots) {
    shot.exportSettings = {
      ...shot.exportSettings,
      includeViewport: false,
      includeAiResultFrame: false,
      includePanoCrop: false,
      includeFullPano: false,
      includeGrayboxPano: false,
      includeCubemap: false,
      includeCameraMoveVideo: false,
      includeProjectedCameraMoveVideo: false,
      includeCameraMoveReferenceFrames: false,
      includeProjectedCameraMoveReferenceFrames: false,
      includeProjectedViewport: false,
      includeMetadata: true,
      includePrompt: true,
    };
  }
  return project;
}

async function zipPaths(blob: Blob): Promise<string[]> {
  const buffer = await blob.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files).filter((path) => !path.endsWith('/'));
}

describe('forescene-v2 package export', () => {
  beforeEach(() => {
    vi.mocked(renderPanoCubemapFacesAsBlobs).mockReset();
    vi.mocked(stitchCubemapFaceBlobsCrossAsync).mockReset();
  });

  it('keeps ZIP paths aligned with the v2 plan for a single shot', async () => {
    const project = withV2Project();
    const shot = project.shots[0]!;
    const plan = createExportPlan(project, [shot], { packageType: 'current-shot' });
    expect(plan.packageFormat).toBe('forescene-v2');

    const result = await buildShotPackage(project, shot, { plan });
    const planned = listPlannedFiles(plan).map((file) => file.path).sort();
    const zipped = (await zipPaths(result.blob)).sort();
    expect(zipped).toEqual(planned);
    expect(result.fileName).toBe(plan.archiveFileName);
  });

  it('writes shots under shots/<folder>/ with generation, prompts, and technical subfolders', async () => {
    const project = withV2Project();
    const shot = project.shots[0]!;
    const result = await buildShotPackage(project, shot);
    const paths = await zipPaths(result.blob);

    expect(paths.some((path) => /^shots\/[^/]+\/manifest\.json$/.test(path))).toBe(true);
    expect(paths.some((path) => /^shots\/[^/]+\/technical\/shot\.json$/.test(path))).toBe(true);
    expect(paths.some((path) => /^shots\/[^/]+\/prompts\/image_gen_prompt\.txt$/.test(path))).toBe(true);
    expect(paths.some((path) => path.startsWith('shots/') && path.includes('/inputs/'))).toBe(false);
  });

  it('writes the root manifest and START_HERE.html at the archive root', async () => {
    const project = withV2Project();
    const result = await buildShotPackage(project, project.shots[0]!);
    const paths = await zipPaths(result.blob);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('START_HERE.html');

    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const rootManifest = JSON.parse((await zip.file('manifest.json')!.async('string')));
    expect(rootManifest.format).toBe('forescene-v2');
    expect(rootManifest.shots).toHaveLength(1);
    expect(rootManifest.shots[0].manifestPath).toBe(paths.find((path) => path.endsWith('/manifest.json') && path.startsWith('shots/')));

    const startHere = await zip.file('START_HERE.html')!.async('string');
    for (const shotEntry of rootManifest.shots as Array<{ manifestPath: string }>) {
      expect(startHere).toContain(shotEntry.manifestPath);
    }
  });

  it('links the shot manifest to shared-reference ids from the root manifest', async () => {
    const project = withV2Project();
    const shot = project.shots[0]!;
    shot.exportSettings = { ...shot.exportSettings, includeFullPano: true };
    const result = await buildShotPackage(project, shot);
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const rootManifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const shotManifestPath = (rootManifest.shots[0] as { manifestPath: string }).manifestPath;
    const shotManifest = JSON.parse(await zip.file(shotManifestPath)!.async('string'));

    expect(shotManifest.sharedReferenceIds.length).toBeGreaterThan(0);
    for (const sharedId of shotManifest.sharedReferenceIds as string[]) {
      expect((rootManifest.sharedReferences as Array<{ id: string }>).some((ref) => ref.id === sharedId)).toBe(true);
    }
  });

  it('writes the canonical panorama once under shared_references/panoramas/ and never under shots/', async () => {
    const project = withV2Project();
    const shot = project.shots[0]!;
    shot.exportSettings = { ...shot.exportSettings, includeFullPano: true };
    const result = await buildShotPackage(project, shot);
    const paths = await zipPaths(result.blob);

    const panoramaFiles = paths.filter((path) => path.endsWith('/panorama.png'));
    expect(panoramaFiles).toHaveLength(1);
    expect(panoramaFiles[0]).toMatch(/^shared_references\/panoramas\/[^/]+\/panorama\.png$/);
    expect(paths.some((path) => path.includes('global_reference'))).toBe(false);
  });

  it('writes the graybox panorama in its own shared folder, separate from the canonical panorama', async () => {
    const project = withV2Project();
    const shot = project.shots[0]!;
    shot.exportSettings = { ...shot.exportSettings, includeFullPano: true, includeGrayboxPano: true };
    const result = await buildShotPackage(project, shot);
    const paths = await zipPaths(result.blob);

    const panoramaFile = paths.find((path) => path.endsWith('/panorama.png'));
    const grayboxFile = paths.find((path) => path.endsWith('/graybox.png'));
    expect(panoramaFile).toBeTruthy();
    expect(grayboxFile).toBeTruthy();
    const panoramaFolder = panoramaFile!.split('/')[2];
    const grayboxFolder = grayboxFile!.split('/')[2];
    expect(panoramaFolder).not.toBe(grayboxFolder);
  });

  it('renders a shared cubemap once across a 31-shot v2 export with no per-shot cubemap copies', async () => {
    const project = withV2Project('Cubemap Cache V2');
    project.settings.panoLetterboxExports169 = false;
    const template = project.shots[0]!;
    template.exportSettings = {
      ...template.exportSettings,
      includeFullPano: true,
      includeCubemap: true,
      includeGrayboxPano: false,
      includeMetadata: false,
      includePrompt: false,
    };
    project.shots = Array.from({ length: 31 }, (_, index) => ({
      ...template,
      id: `shot-v2-cache-${index + 1}`,
      shotNumber: String(index + 1).padStart(3, '0'),
      name: `Camera ${String(index + 1).padStart(3, '0')}`,
      exportSettings: { ...template.exportSettings },
    }));

    mockCubemapRender();

    const plan = createExportPlan(project, project.shots, { packageType: 'selected-shots' });
    expect(plan.packageFormat).toBe('forescene-v2');
    expect(plan.sharedArtifacts.filter((artifact) => artifact.kind === 'cubemap')).toHaveLength(1);
    expect(plan.sharedArtifacts.filter((artifact) => artifact.kind === 'global-reference')).toHaveLength(1);
    expect(plan.shots.every((shotPlan) => shotPlan.artifacts.every((artifact) => (
      artifact.kind !== 'cubemap'
      && artifact.kind !== 'global-reference'
      && artifact.kind !== 'global-graybox'
    )))).toBe(true);

    const result = await buildMultiShotPackage(project, project.shots, { plan });
    expect(renderPanoCubemapFacesAsBlobs).toHaveBeenCalledTimes(1);
    expect(stitchCubemapFaceBlobsCrossAsync).toHaveBeenCalledTimes(1);

    const paths = await zipPaths(result.blob);
    const cubemapFaceFiles = paths.filter((path) => path.endsWith('/px.png'));
    expect(cubemapFaceFiles).toHaveLength(1);
    expect(cubemapFaceFiles[0]).toMatch(/^shared_references\/panoramas\/[^/]+\/cubemap\/px\.png$/);
    expect(paths.filter((path) => path.endsWith('/panorama.png'))).toHaveLength(1);
    expect(paths.some((path) => path.startsWith('shots/') && path.includes('/cubemap/'))).toBe(false);
    expect(paths.some((path) => path.includes('global_reference'))).toBe(false);
  });

  it('assigns collision-safe shared panorama folders when labels collide', async () => {
    const project = withV2Project('Collision V2');
    project.settings.panoLetterboxExports169 = false;
    // Two panos with the same display name → distinct sanitized folders.
    const assetA = createPanoAsset({ name: 'a.png', uri: 'data:image/png;base64,AAAA', width: 4, height: 2 });
    const assetB = createPanoAsset({ name: 'b.png', uri: 'data:image/png;base64,BBBB', width: 4, height: 2 });
    const panoA = createPanoReference({
      name: 'Same Name', assetId: assetA.id, type: 'ai_global_reference',
      origin: project.scene.panoOrigin, width: 4, height: 2, isCanonical: true,
    });
    const panoB = createPanoReference({
      name: 'Same Name', assetId: assetB.id, type: 'graybox_render',
      origin: project.scene.panoOrigin, width: 4, height: 2, isCanonical: false,
    });
    project.assets.assets[assetA.id] = assetA;
    project.assets.assets[assetB.id] = assetB;
    project.panoRefs = [panoA, panoB];

    const shot = project.shots[0]!;
    shot.exportSettings = {
      ...shot.exportSettings,
      includeFullPano: true,
      includeGrayboxPano: true,
    };

    const result = await buildShotPackage(project, shot);
    const paths = await zipPaths(result.blob);
    const folders = new Set(
      paths
        .filter((path) => path.startsWith('shared_references/panoramas/'))
        .map((path) => path.split('/')[2]),
    );
    expect(folders.size).toBe(2);
    expect([...folders].some((folder) => folder.endsWith('_2'))).toBe(true);
  });

  it('assigns collision-safe shot folders under shots/ when production IDs collide', async () => {
    const project = withV2Project('Shot Collision V2');
    const first = project.shots[0]!;
    first.productionShotId = 'SC_01';
    first.name = 'Shared Title';
    const second = {
      ...first,
      id: 'shot-collision-2',
      shotNumber: '002',
      name: 'Shared Title',
      productionShotId: 'SC_01',
    };
    project.shots = [first, second];

    const plan = createExportPlan(project, project.shots, { packageType: 'selected-shots' });
    expect(plan.shots.map((shot) => shot.rootFolder).sort()).toEqual([
      'SC_01_shared_title',
      'SC_01_shared_title_2',
    ]);

    const result = await buildMultiShotPackage(project, project.shots, { plan });
    const paths = await zipPaths(result.blob);
    expect(paths.some((path) => path.startsWith('shots/SC_01_shared_title/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('shots/SC_01_shared_title_2/'))).toBe(true);
  });

  it('compares legacy-v1 vs forescene-v2 ZIP file counts for the same 31-shot shared cubemap selection', async () => {
    const makeProject = (format: 'legacy-v1' | 'forescene-v2') => {
      const project = withV2Project(`Count ${format}`);
      project.exportConfiguration = { ...project.exportConfiguration!, packageFormat: format };
      project.settings.panoLetterboxExports169 = false;
      const template = project.shots[0]!;
      template.exportSettings = {
        ...template.exportSettings,
        includeFullPano: true,
        includeCubemap: true,
        includeGrayboxPano: false,
        includeMetadata: false,
        includePrompt: false,
      };
      project.shots = Array.from({ length: 31 }, (_, index) => ({
        ...template,
        id: `shot-count-${format}-${index + 1}`,
        shotNumber: String(index + 1).padStart(3, '0'),
        name: `Camera ${String(index + 1).padStart(3, '0')}`,
        exportSettings: { ...template.exportSettings },
      }));
      return project;
    };

    mockCubemapRender();
    const legacyProject = makeProject('legacy-v1');
    const v2Project = makeProject('forescene-v2');
    const legacyPlan = createExportPlan(legacyProject, legacyProject.shots, { packageType: 'selected-shots' });
    const v2Plan = createExportPlan(v2Project, v2Project.shots, { packageType: 'selected-shots' });

    const legacyResult = await buildMultiShotPackage(legacyProject, legacyProject.shots, { plan: legacyPlan });
    vi.mocked(renderPanoCubemapFacesAsBlobs).mockClear();
    vi.mocked(stitchCubemapFaceBlobsCrossAsync).mockClear();
    mockCubemapRender();
    const v2Result = await buildMultiShotPackage(v2Project, v2Project.shots, { plan: v2Plan });

    const legacyPaths = await zipPaths(legacyResult.blob);
    const v2Paths = await zipPaths(v2Result.blob);
    const legacyCubemapFaces = legacyPaths.filter((path) => /\/cubemap\/px\.png$/.test(path)).length;
    const v2CubemapFaces = v2Paths.filter((path) => /\/cubemap\/px\.png$/.test(path)).length;

    expect(legacyCubemapFaces).toBe(31);
    expect(v2CubemapFaces).toBe(1);
    expect(v2Paths.length).toBeLessThan(legacyPaths.length);
    // Expose counts for the implementation report via assertion messages.
    expect({
      legacyFileCount: legacyPaths.length,
      v2FileCount: v2Paths.length,
      legacyCubemapFaceSets: legacyCubemapFaces,
      v2CubemapFaceSets: v2CubemapFaces,
    }).toMatchObject({
      legacyCubemapFaceSets: 31,
      v2CubemapFaceSets: 1,
    });
  });

  it('assigns distinct shared cubemap folders for shots that fall back to different linked panos', async () => {
    const project = withV2Project('Multi Pano V2');
    // Remove the canonical pano so cubemap falls back to each shot's linked pano.
    project.panoRefs = project.panoRefs.filter((pano) => !pano.isCanonical);

    const assetA = createPanoAsset({ name: 'pano_a.png', uri: 'data:image/png;base64,AAAA', width: 4, height: 2 });
    const panoA = createPanoReference({
      name: 'Pano A', assetId: assetA.id, type: 'graybox_render', origin: project.scene.panoOrigin, width: 4, height: 2,
    });
    const assetB = createPanoAsset({ name: 'pano_b.png', uri: 'data:image/png;base64,BBBB', width: 4, height: 2 });
    const panoB = createPanoReference({
      name: 'Pano B', assetId: assetB.id, type: 'graybox_render', origin: project.scene.panoOrigin, width: 4, height: 2,
    });
    project.assets.assets[assetA.id] = assetA;
    project.assets.assets[assetB.id] = assetB;
    project.panoRefs.push(panoA, panoB);

    const template = project.shots[0]!;
    template.exportSettings = { ...template.exportSettings, includeCubemap: true };
    const shotA = { ...template, id: 'shot-pano-a', linkedPanoId: panoA.id };
    const shotB = { ...template, id: 'shot-pano-b', linkedPanoId: panoB.id };
    project.shots = [shotA, shotB];

    mockCubemapRender();

    const result = await buildMultiShotPackage(project, project.shots);
    expect(renderPanoCubemapFacesAsBlobs).toHaveBeenCalledTimes(2);
    const paths = await zipPaths(result.blob);
    const cubemapDirs = new Set(
      paths
        .filter((path) => path.endsWith('/px.png'))
        .map((path) => path.split('/')[2]),
    );
    expect(cubemapDirs.size).toBe(2);
  });

  it('omits missing shared assets without crashing', async () => {
    const project = withV2Project();
    const shot = project.shots[0]!;
    // Canonical pano record exists, but its registry asset does not.
    const canonical = project.panoRefs.find((pano) => pano.isCanonical)!;
    delete project.assets.assets[canonical.imageAssetId];
    shot.exportSettings = { ...shot.exportSettings, includeFullPano: true };

    const plan = createExportPlan(project, [shot], { packageType: 'current-shot' });
    expect(plan.sharedArtifacts.some((artifact) => artifact.kind === 'global-reference' && artifact.disposition === 'produce')).toBe(false);

    const result = await buildShotPackage(project, shot, { plan });
    const paths = await zipPaths(result.blob);
    expect(paths.some((path) => path.endsWith('/panorama.png'))).toBe(false);
  });

  it('packages a single shot under the v2 layout via buildMultiShotPackage delegation', async () => {
    const project = withV2Project();
    const result = await buildMultiShotPackage(project, [project.shots[0]!]);
    const paths = await zipPaths(result.blob);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('START_HERE.html');
    expect(paths.some((path) => path.startsWith('shots/'))).toBe(true);
  });

  it('honours abort during a v2 multi-shot export', async () => {
    const project = withV2Project('Cancel Export V2');
    const second = { ...project.shots[0]!, id: 'shot-v2-cancel-2', shotNumber: '002', name: 'Camera 002' };
    project.shots.push(second);

    const controller = new AbortController();
    controller.abort();
    await expect(
      buildMultiShotPackage(project, project.shots, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
