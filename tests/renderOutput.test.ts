import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  computeGrayboxPanoFarPlane,
  grayboxCubeSampleDirection,
} from '../src/engine/renderers';
import { applyInversePanoYaw } from '../src/engine/projectedStyleMath';
import { buildScene, disposeScene } from '../src/engine/sceneObjects';
import { degreesToRadians } from '../src/engine/sync';

describe('rendered shot output', () => {
  it('does not synthesize final AI frames inside the app renderer', () => {
    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/renderSkinnedShotFrame|composeShotLockedSkinnedFrame|canonical_reference_skinning/i);
    expect(source).toContain('renderViewportClay');
    expect(source).toContain('renderShotFrame');
    expect(source).toContain('applyFlyCameraToPerspectiveCamera');
    expect(source).toContain('panoMap');
    expect(source).toContain('yaw: { value: degreesToRadians(crop.yawDegrees - panoRotation[1]) }');
    // Screen-right samples +X so pano crops match the 3D viewfinder (not mirrored).
    expect(source).toContain('vec3 dir = normalize(vec3(ndc.x * aspect * tanHalfFov');
    expect(source).not.toContain('vec3(-ndc.x * aspect * tanHalfFov');
    expect(source).toContain('atan(dir.x, dir.z)');
    expect(source).toContain('#include <colorspace_fragment>');
    expect(source).not.toContain('renderContinuityControlView');
    expect(source).toContain('renderPanoPerspectiveCrop');
    expect(source).toContain('renderPanoCubemapFaces');
    expect(source).not.toContain('stitchCubemapFacesGridAsync');
    expect(source).not.toContain('stitchImageStripAsync');
  });

  it('keeps sun markers out of AI-facing export renders', () => {
    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    const profile = readFileSync(new URL('../src/engine/finalRenderProfile.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/renderGrayboxEquirectangularPano[\s\S]*hiddenObjectTypes: \['sun_marker'\]/);
    expect(source).toMatch(/renderProjectedEquirectangularPano[\s\S]*hiddenObjectTypes: \['sun_marker'\]/);
    expect(source).toContain('createFinalRenderSceneOptions');
    expect(profile).toContain("'sun_marker'");
  });

  it('disables fog on clay and projected viewport still exports', () => {
    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/renderViewportClay[\s\S]*createFinalRenderSceneOptions\(\)/);
    expect(source).toMatch(/renderViewportProjected[\s\S]*createFinalRenderSceneOptions\(\)/);
    expect(source).toContain('createFinalRenderSceneOptions');
  });

  it('exports projected equirect from the capture origin without writing a graybox pano ref', () => {
    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const coverage = readFileSync(new URL('../src/components/common/CoverageOptimizerPanel.tsx', import.meta.url), 'utf8');

    expect(source).toContain('export async function renderProjectedEquirectangularPano');
    expect(source).toContain("appearance: 'projected'");
    expect(source).toContain('showGrid: false');
    expect(source).toContain('loadProjectedSceneResources');
    expect(source).toContain('captureEquirectangularFromOrigin');
    expect(source).toMatch(/Projected 360 export requires an importable styled panorama/);

    expect(build).toContain('Download Projected 360');
    expect(build).toContain('data-build-download-projected-360');
    expect(build).toContain('renderProjectedEquirectangularPano');
    expect(build).toContain('projected_360.png');
    expect(build).toContain('handleDownloadProjected360');
    // Download-only path: must not register the PNG as a graybox_render project asset.
    expect(build).toMatch(
      /handleDownloadProjected360[\s\S]*?renderProjectedEquirectangularPano[\s\S]*?downloadPanoImage/,
    );
    expect(build).not.toMatch(
      /handleDownloadProjected360[\s\S]*?type:\s*'graybox_render'/,
    );

    expect(coverage).toContain('Download Projected 360');
  });

  it('defaults graybox 360 renders to 4K equirectangular resolution', () => {
    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    const storeSource = readFileSync(new URL('../src/state/useContinuityStore.ts', import.meta.url), 'utf8');

    expect(source).toContain('DEFAULT_GRAYBOX_PANO_WIDTH');
    expect(source).toContain('DEFAULT_GRAYBOX_PANO_HEIGHT');
    expect(storeSource).toMatch(/renderGrayboxEquirectangularPano\(state\.project/);
    expect(storeSource).toContain('useThemeStore.getState().theme');
    expect(storeSource).not.toContain('renderGrayboxEquirectangularPano(state.project, 2048, 1024)');
    expect(storeSource).not.toMatch(/renderGrayboxPano:[\s\S]*downloadDataUrl/);
    expect(storeSource).toContain('storeProjectAssetBlob');
    expect(storeSource).toContain('render.blob');
    expect(source).toContain('const cubeFaceSize = Math.min(1024, Math.max(512, Math.round(width / 4)));');
    expect(source).toContain('generateMipmaps: false');
    expect(source).toContain("canvasToBlob(renderer.domElement, 'image/png')");
  });

  it('defaults shots, letterboxed panos, and simple viewer downloads to 4K UHD', () => {
    const defaults = readFileSync(new URL('../src/domain/defaults.ts', import.meta.url), 'utf8');
    const panoImage = readFileSync(new URL('../src/engine/panoImage.ts', import.meta.url), 'utf8');
    const simpleViewer = readFileSync(new URL('../src/components/workspaces/PanoViewerWorkspace.tsx', import.meta.url), 'utf8');
    const project = createDefaultProject();

    expect(defaults).toContain('export const DEFAULT_SHOT_WIDTH = 3840');
    expect(defaults).toContain('export const DEFAULT_SHOT_HEIGHT = 2160');
    expect(defaults).toContain('DEFAULT_GRAYBOX_PANO_WIDTH = 4096');
    expect(defaults).toContain('DEFAULT_GRAYBOX_PANO_HEIGHT = 2048');
    expect(project.settings.defaultShotWidth).toBe(3840);
    expect(project.settings.defaultShotHeight).toBe(2160);
    expect(project.shots[0].exportSettings.width).toBe(3840);
    expect(project.shots[0].exportSettings.height).toBe(2160);
    expect(panoImage).toContain('targetWidth = DEFAULT_SHOT_WIDTH');
    expect(panoImage).toContain('targetHeight = DEFAULT_SHOT_HEIGHT');
    expect(simpleViewer).toContain('const DEFAULT_DOWNLOAD_WIDTH = 3840');
    expect(simpleViewer).toContain('const DEFAULT_DOWNLOAD_HEIGHT = 2160');
  });

  it('renders the full graybox scene without fog or a fixed distance cutoff', () => {
    const project = createDefaultProject();
    project.scene.objects[1].transform.position = [0, 0, 500];
    const scene = buildScene(project, {
      showHelpers: false,
      hiddenObjectTypes: ['sun_marker'],
      fog: false,
    });

    expect(scene.fog).toBeNull();
    expect(computeGrayboxPanoFarPlane(scene, project.scene.panoOrigin)).toBeGreaterThan(500);

    disposeScene(scene);
  });

  it('bakes scene.panoRotation yaw into graybox equirect so stamped projector pose matches projection', () => {
    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    const storeSource = readFileSync(new URL('../src/state/useContinuityStore.ts', import.meta.url), 'utf8');

    // Capture path stamps scene rotation on the graybox ref.
    expect(storeSource).toMatch(
      /type:\s*'graybox_render'[\s\S]*?rotation:\s*state\.project\.scene\.panoRotation/,
    );
    // Equirect stitch must honor that yaw (CubeCamera alone is world-aligned).
    expect(source).toContain('panoYaw: { value: panoYawRadians }');
    expect(source).toContain('project.scene.panoRotation');
    expect(source).toContain('localDir.x * c + localDir.z * s');
    expect(source).toContain('-localDir.x * s + localDir.z * c');

    // Pure inverse consistency: world → local (projection) → world (cube sample).
    const yaw = degreesToRadians(37);
    const world: [number, number, number] = [0.4, 0.2, 0.9];
    const len = Math.hypot(...world);
    const unitWorld: [number, number, number] = [world[0] / len, world[1] / len, world[2] / len];
    const local = applyInversePanoYaw(unitWorld, yaw);
    const recovered = grayboxCubeSampleDirection(local, yaw);
    expect(recovered[0]).toBeCloseTo(unitWorld[0], 6);
    expect(recovered[1]).toBeCloseTo(unitWorld[1], 6);
    expect(recovered[2]).toBeCloseTo(unitWorld[2], 6);

    // Zero yaw is identity (legacy path).
    expect(grayboxCubeSampleDirection([0, 0, 1], 0)).toEqual([0, 0, 1]);
  });

  it('applies linked pano rotation to local reference exports', () => {
    const source = readFileSync(new URL('../src/engine/packageExport.ts', import.meta.url), 'utf8');
    expect(source).toContain('renderPanoPerspectiveCrop(linkedPanoAsset.uri, shot.panoCrop, linkedPano.rotation)');
    expect(source).toContain('renderPanoCubemapFacesAsBlobs(cubemapSourcePano.asset.uri');
    expect(source).toContain('panoRotation: cubemapSourcePano.pano.rotation');
    expect(source).toContain('inputs/cubemap/');
    expect(source).toContain('onFaceRendered: async (face, rendered) =>');
    expect(source).toContain('rendered.blob');
    expect(source).toContain('stitchCubemapFaceBlobsCrossAsync');
    expect(source).not.toContain('stitchCubemapVisibleFacesAsync');
    expect(source).not.toContain('cubemap_visible');
  });

  it('letterboxes full pano exports when the project setting is enabled', () => {
    const source = readFileSync(new URL('../src/engine/packageExport.ts', import.meta.url), 'utf8');
    expect(source).toContain('preparePanoExportDataUrl');
    expect(source).toContain('panoLetterboxExports169');
  });

  it('keeps compare overlay as a preview-only yaw and opacity check', () => {
    const viewerSource = readFileSync(new URL('../src/components/viewers/PanoViewer.tsx', import.meta.url), 'utf8');
    const referenceSource = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');

    expect(viewerSource).not.toMatch(/panoFovDegrees|compareFovDegrees/);
    expect(viewerSource).toContain('rendererRef.current.render(compareSceneRef.current, cameraRef.current)');
    expect(viewerSource).toContain('rendererRef.current.clearDepth()');
    expect(viewerSource).toContain('rendererRef.current.render(activeSceneRef.current, cameraRef.current)');
    expect(viewerSource).toContain('panoYawToThreeJsYawDegrees(view.yawDegrees - rotation[1])');
    expect(referenceSource).not.toContain('label="Pano FOV"');
    expect(referenceSource).not.toContain('label="Graybox FOV"');
    expect(referenceSource).not.toContain('Object Stamps');
  });

  it('does not include continuity control projection in export renders', () => {
    const rendererSource = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    const packageSource = readFileSync(new URL('../src/engine/packageExport.ts', import.meta.url), 'utf8');

    expect(rendererSource).not.toContain('createProjectedPanoMaterial');
    expect(rendererSource).not.toContain('createStampedProjectionMaterials');
    expect(packageSource).not.toContain('continuity_control_view.png');
  });

  it('can hide helper object types while preserving build-scene visibility controls', () => {
    const project = createDefaultProject();
    const visibleScene = buildScene(project, { showHelpers: false });
    const filteredScene = buildScene(project, { showHelpers: false, hiddenObjectTypes: ['sun_marker'] });

    expect(visibleScene.getObjectByName('Sun Marker 1')).toBeTruthy();
    expect(filteredScene.getObjectByName('Sun Marker 1')).toBeUndefined();

    disposeScene(visibleScene);
    disposeScene(filteredScene);
  });
});
