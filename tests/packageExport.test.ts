import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createDefaultProject, createPanoAsset, createPanoReference } from '../src/domain/defaults';
import { getShotPackageBaseName } from '../src/engine/exportNaming';
import { setTwoPointCameraKeyframe } from '../src/engine/cameraKeyframes';
import { CAMERA_MOVE_CUBEMAP_FACES, type CameraMoveCubemapFaceId } from '../src/engine/cameraMoveCubemap';
import { stitchCubemapFaceBlobsCrossAsync } from '../src/engine/cubemapStitch';
import {
  buildMultiShotPackage,
  buildShotPackage,
  countShotPackageUnits,
  PackageExportProgress,
  resolveClayCameraMovePackageSource,
} from '../src/engine/packageExport';
import { type BlobImageRenderResult, renderPanoCubemapFacesAsBlobs, renderShotCameraMoveMp4 } from '../src/engine/renderers';

vi.mock('../src/engine/renderers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/renderers')>();
  return {
    ...actual,
    renderShotCameraMoveMp4: vi.fn(actual.renderShotCameraMoveMp4),
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

function withGrayboxAndShot(name = 'Temple') {
  const project = createDefaultProject();
  project.name = name;
  const asset = createPanoAsset({
    name: 'graybox.png',
    uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    width: 4,
    height: 2,
  });
  const pano = createPanoReference({
    name: 'Graybox',
    assetId: asset.id,
    type: 'graybox_render',
    origin: project.scene.panoOrigin,
    width: 4,
    height: 2,
    isCanonical: true,
  });
  project.assets.assets[asset.id] = asset;
  project.panoRefs.push(pano);
  project.workflow.grayboxApprovedForReferenceAt = new Date().toISOString();

  // Disable expensive render paths for unit tests.
  for (const shot of project.shots) {
    shot.exportSettings = {
      ...shot.exportSettings,
      includeViewport: false,
      includeAiResultFrame: false,
      includePanoCrop: false,
      includeFullPano: false,
      includeGrayboxPano: false,
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
  return Object.keys(zip.files);
}

describe('package export', () => {
  beforeEach(() => {
    vi.mocked(renderShotCameraMoveMp4).mockReset();
    vi.mocked(renderShotCameraMoveMp4).mockImplementation(async () => {
      throw new Error('renderShotCameraMoveMp4 should be mocked in camera-move package tests');
    });
    vi.mocked(renderPanoCubemapFacesAsBlobs).mockReset();
    vi.mocked(stitchCubemapFaceBlobsCrossAsync).mockReset();
  });

  it('generates camera move MP4 during packaging when keyframes exist without a pre-exported asset', () => {
    const source = readFileSync(new URL('../src/engine/packageExport.ts', import.meta.url), 'utf8');
    expect(source).toContain('resolveClayCameraMovePackageSource');
    expect(source).toContain('hasRenderableCameraMove(shot.cameraKeyframes)');
    expect(source).toContain('renderShotCameraMoveMp4');
    expect(source).toContain('viewport_clay_motion.mp4');
    expect(source).toContain("resolutionPreset: '1080p'");
    expect(source).toContain("mode: 'render'");
    expect(source).toContain('Legacy fallback only when rerendering is impossible');
    expect(source).not.toContain('getSupportedCameraMoveMp4MimeType');
  });

  it('prefers fresh deterministic clay encode over a stored Quick Preview asset when keyframes exist', () => {
    const project = withGrayboxAndShot();
    const shot = project.shots[0];
    shot.exportSettings = {
      ...shot.exportSettings,
      includeCameraMoveVideo: true,
    };
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: [],
      slot: 'start',
      camera: shot.camera,
      durationSeconds: 2,
    });
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: shot.cameraKeyframes,
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [1, 1.6, 3],
        target: [1, 1.6, 8],
      },
      durationSeconds: 2,
    });

    const legacyId = 'legacy-quick-preview';
    project.assets.assets[legacyId] = {
      id: legacyId,
      type: 'video',
      name: 'legacy_quick_preview.mp4',
      uri: `data:video/mp4;base64,${Buffer.from('LEGACY_QUICK_PREVIEW_BYTES').toString('base64')}`,
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      createdAt: new Date().toISOString(),
      metadata: {
        source: 'graybox_camera_keyframes',
        encodeMode: 'quickPreview',
      },
    };
    shot.assets.cameraMoveVideoAssetId = legacyId;

    expect(resolveClayCameraMovePackageSource(shot, project.assets.assets[legacyId])).toBe('encode');
  });

  it('ignores a stored Quick Preview clay asset and packs a freshly encoded MP4 when keyframes exist', async () => {
    const project = withGrayboxAndShot();
    const shot = project.shots[0];
    shot.exportSettings = {
      ...shot.exportSettings,
      includeCameraMoveVideo: true,
    };
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: [],
      slot: 'start',
      camera: shot.camera,
      durationSeconds: 2,
    });
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: shot.cameraKeyframes,
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [1, 1.6, 3],
        target: [1, 1.6, 8],
      },
      durationSeconds: 2,
    });

    const legacyId = 'legacy-quick-preview';
    project.assets.assets[legacyId] = {
      id: legacyId,
      type: 'video',
      name: 'legacy_quick_preview.mp4',
      uri: `data:video/mp4;base64,${Buffer.from('LEGACY_QUICK_PREVIEW_BYTES').toString('base64')}`,
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      createdAt: new Date().toISOString(),
      metadata: {
        source: 'graybox_camera_keyframes',
        encodeMode: 'quickPreview',
      },
    };
    shot.assets.cameraMoveVideoAssetId = legacyId;

    vi.mocked(renderShotCameraMoveMp4).mockResolvedValue({
      blob: new Blob([Uint8Array.from(Buffer.from('FRESH_DETERMINISTIC_ENCODE'))], { type: 'video/mp4' }),
      width: 1920,
      height: 1080,
      durationSeconds: 2,
      frameRate: 30,
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      encodeMode: 'render',
      frameCount: 60,
      codecString: 'avc1.640028',
    });

    const result = await buildShotPackage(project, shot);
    expect(renderShotCameraMoveMp4).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderShotCameraMoveMp4).mock.calls[0]?.[2]).toMatchObject({
      mode: 'render',
      appearance: 'clay',
      resolutionPreset: '1080p',
    });
    expect(result.manifestPaths.some((path) => path.includes('viewport_clay_motion.mp4'))).toBe(true);

    // Confirm the packed bytes came from the fresh encode, not the legacy data-URL asset.
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const motionPath = Object.keys(zip.files).find((path) => path.endsWith('viewport_clay_motion.mp4'));
    expect(motionPath).toBeTruthy();
    const packed = new TextDecoder().decode(await zip.file(motionPath!)!.async('uint8array'));
    expect(packed).toContain('FRESH_DETERMINISTIC_ENCODE');
    expect(packed).not.toContain('LEGACY_QUICK_PREVIEW_BYTES');
  });

  it('copies a stored clay asset only when keyframes cannot be re-encoded', () => {
    const project = withGrayboxAndShot();
    const shot = project.shots[0];
    shot.exportSettings = {
      ...shot.exportSettings,
      includeCameraMoveVideo: true,
    };
    shot.cameraKeyframes = [];
    expect(resolveClayCameraMovePackageSource(shot, { uri: 'data:video/mp4;base64,AAA' })).toBe('copy');
    expect(resolveClayCameraMovePackageSource(shot, null)).toBe('skip');
  });

  it('uses production-aware package folder names', async () => {
    const project = withGrayboxAndShot();
    const shot = {
      ...project.shots[0],
      productionShotId: '42A',
      name: 'Courtyard entrance',
    };
    project.shots[0] = shot;

    const result = await buildShotPackage(project, shot);
    expect(result.fileName).toBe(`${getShotPackageBaseName(shot)}_package.zip`);

    const paths = await zipPaths(result.blob);
    expect(paths.some((path) => path.startsWith('42A_courtyard_entrance/metadata/shot.json'))).toBe(true);
  });

  it('writes collision-suffixed manifests with matching root folders', async () => {
    const project = withGrayboxAndShot('Collision Export');
    const first = {
      ...project.shots[0],
      id: 'shot-a',
      productionShotId: '42A',
      name: 'Courtyard entrance',
    };
    const second = {
      ...project.shots[0],
      id: 'shot-b',
      productionShotId: '42A',
      name: 'Courtyard entrance',
    };
    project.shots = [first, second];

    const result = await buildMultiShotPackage(project, project.shots);
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const secondManifestPath = '42A_courtyard_entrance_2/manifest.json';
    const manifestJson = await zip.file(secondManifestPath)?.async('string');
    expect(manifestJson).toBeTruthy();

    const manifest = JSON.parse(manifestJson!) as {
      rootFolder: string;
      files: Array<{ path: string }>;
    };
    expect(manifest.rootFolder).toBe('42A_courtyard_entrance_2');
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const file of manifest.files) {
      expect(file.path.startsWith('42A_courtyard_entrance_2/')).toBe(true);
    }
    expect(result.manifestPaths.every((path) => path.startsWith('42A_courtyard_entrance'))).toBe(true);
    expect(result.manifestPaths.some((path) => path.startsWith('42A_courtyard_entrance_2/'))).toBe(true);
  });

  it('builds a single-shot package zip', async () => {
    const project = withGrayboxAndShot();
    const result = await buildShotPackage(project, project.shots[0]);
    expect(result.fileName).toMatch(/_package\.zip$/);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.manifestPaths.some((path) => path.includes('metadata/shot.json'))).toBe(true);

    const paths = await zipPaths(result.blob);
    expect(paths.some((path) => path.endsWith('manifest.json'))).toBe(true);
    expect(paths.some((path) => path.includes('metadata/shot.json'))).toBe(true);
  });

  it('streams sequential binary cubemap faces into the package before stitching them', async () => {
    const project = withGrayboxAndShot();
    const shot = project.shots[0];
    shot.exportSettings = {
      ...shot.exportSettings,
      includeFullPano: true,
    };
    project.settings.panoLetterboxExports169 = false;
    const faces = Object.fromEntries(
      CAMERA_MOVE_CUBEMAP_FACES.map((face) => [
        face,
        { blob: new Blob([`face-${face}`], { type: 'image/png' }), width: 2, height: 2 },
      ]),
    ) as Record<CameraMoveCubemapFaceId, BlobImageRenderResult>;
    const stitched = {
      blob: new Blob(['stitched-cubemap'], { type: 'image/png' }),
      width: 8,
      height: 6,
    };

    vi.mocked(renderPanoCubemapFacesAsBlobs).mockImplementation(async (_uri, options) => {
      for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
        await options!.onFaceRendered?.(face, faces[face]);
      }
      return { faceSize: 2, faces };
    });
    vi.mocked(stitchCubemapFaceBlobsCrossAsync).mockResolvedValue(stitched);

    const result = await buildShotPackage(project, shot);
    const canonicalPano = project.panoRefs.find((pano) => pano.isCanonical)!;
    expect(renderPanoCubemapFacesAsBlobs).toHaveBeenCalledWith(
      project.assets.assets[canonicalPano.imageAssetId].uri,
      expect.objectContaining({ panoRotation: canonicalPano.rotation }),
    );
    expect(stitchCubemapFaceBlobsCrossAsync).toHaveBeenCalledWith(faces, 2);

    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
      const content = await zip.file(`shot_001/inputs/cubemap/${face}.png`)?.async('text');
      expect(content).toBe(`face-${face}`);
    }
    expect(await zip.file('shot_001/inputs/cubemap/cubemap_stitched.png')?.async('text')).toBe('stitched-cubemap');
  });

  it('packs multiple shots into one outer zip download', async () => {
    const project = withGrayboxAndShot('Multi Export');
    const second = {
      ...project.shots[0],
      id: 'shot-test-2',
      shotNumber: '002',
      name: 'Camera 002',
    };
    project.shots.push(second);

    const result = await buildMultiShotPackage(project, project.shots);
    expect(result.fileName).toBe('Multi_Export_2_shots_package.zip');
    expect(result.blob.size).toBeGreaterThan(0);

    const paths = await zipPaths(result.blob);
    const shotFolders = new Set(
      paths
        .map((path) => path.split('/')[0])
        .filter((folder) => folder.startsWith('shot_')),
    );
    expect(shotFolders.size).toBeGreaterThanOrEqual(2);
    expect(paths.filter((path) => path.endsWith('manifest.json')).length).toBeGreaterThanOrEqual(2);
  });

  it('delegates single-shot multi export to the single package path', async () => {
    const project = withGrayboxAndShot();
    const multi = await buildMultiShotPackage(project, [project.shots[0]]);
    const single = await buildShotPackage(project, project.shots[0]);
    expect(multi.fileName).toBe(single.fileName);
  });

  it('emits staged package progress and advances the active shot', async () => {
    const project = withGrayboxAndShot('Progress Export');
    const second = {
      ...project.shots[0],
      id: 'shot-test-2',
      shotNumber: '002',
      name: 'Camera 002',
    };
    project.shots.push(second);

    const events: PackageExportProgress[] = [];
    await buildMultiShotPackage(project, project.shots, {
      onProgress: (progress) => events.push({ ...progress }),
    });

    expect(events.length).toBeGreaterThan(3);
    expect(events[0]?.phase).toBe('preparing');
    expect(events.some((event) => event.phase === 'packaging')).toBe(true);
    expect(events.some((event) => event.phase === 'compressing')).toBe(true);
    expect(events.at(-1)?.phase).toBe('complete');
    expect(events.some((event) => event.currentShot === 1 && event.shotId === project.shots[0].id)).toBe(true);
    expect(events.some((event) => event.currentShot === 2 && event.shotId === second.id)).toBe(true);
    expect(events.at(-1)?.progress).toBe(1);
  });

  it('honours abort during multi-shot package export', async () => {
    const project = withGrayboxAndShot('Cancel Export');
    const second = {
      ...project.shots[0],
      id: 'shot-test-2',
      shotNumber: '002',
      name: 'Camera 002',
    };
    project.shots.push(second);

    const controller = new AbortController();
    controller.abort();
    await expect(
      buildMultiShotPackage(project, project.shots, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('counts at least one package unit per shot', () => {
    const project = withGrayboxAndShot();
    expect(countShotPackageUnits(project, project.shots[0])).toBeGreaterThanOrEqual(1);
  });
});
