import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createDefaultProject,
  defaultShotDepthSettings,
  normalizeShotDepthSettings,
} from '../src/domain/defaults';
import { parseProject } from '../src/engine/projectIO';
import {
  buildDepthMetadata,
  formatDepthRangeLegend,
  shouldExportAnyDepth,
  shouldExportCameraMoveDepth,
  shouldExportDepthReferenceFrames,
  shouldExportViewportDepth,
} from '../src/engine/depthRender';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import { generateImagePrompt, generateVideoPrompt } from '../src/engine/prompts';
import { createId } from '../src/utils/ids';

describe('shot depth settings', () => {
  it('defaults depth exports off with auto range and white-near convention', () => {
    expect(defaultShotDepthSettings).toEqual({
      enabled: false,
      includeViewportStill: true,
      includeReferenceFrames: true,
      includeCameraMoveVideo: true,
      rangeMode: 'auto',
      invert: false,
    });
    const project = createDefaultProject();
    expect(project.shots[0].exportSettings.depth).toEqual(defaultShotDepthSettings);
  });

  it('normalizes missing depth settings on legacy projects', () => {
    const project = createDefaultProject();
    const legacy = structuredClone(project);
    delete legacy.shots[0].exportSettings.depth;
    const parsed = parseProject(JSON.stringify(legacy));
    expect(parsed.shots[0].exportSettings.depth).toEqual(defaultShotDepthSettings);
  });

  it('normalizes partial depth settings without schema migration', () => {
    expect(normalizeShotDepthSettings({ enabled: true, rangeMode: 'manual', nearMeters: 0.5 }))
      .toMatchObject({
        enabled: true,
        includeViewportStill: true,
        includeReferenceFrames: true,
        includeCameraMoveVideo: true,
        rangeMode: 'manual',
        nearMeters: 0.5,
        invert: false,
      });
  });

  it('gates package depth artifacts behind nested toggles', () => {
    expect(shouldExportViewportDepth({ ...defaultShotDepthSettings, enabled: true })).toBe(true);
    expect(shouldExportViewportDepth({
      ...defaultShotDepthSettings,
      enabled: true,
      includeViewportStill: false,
    })).toBe(false);
    expect(shouldExportCameraMoveDepth({ ...defaultShotDepthSettings, enabled: true }, true)).toBe(true);
    expect(shouldExportCameraMoveDepth({ ...defaultShotDepthSettings, enabled: true }, false)).toBe(false);
    expect(shouldExportDepthReferenceFrames({ ...defaultShotDepthSettings, enabled: true }, true)).toBe(true);
    expect(shouldExportAnyDepth({
      ...defaultShotDepthSettings,
      enabled: true,
      includeViewportStill: false,
      includeReferenceFrames: false,
      includeCameraMoveVideo: true,
    }, { hasRenderableMove: true })).toBe(true);
    expect(shouldExportViewportDepth(defaultShotDepthSettings)).toBe(false);
  });

  it('records encoding convention and range in depth metadata', () => {
    const meta = buildDepthMetadata(
      { ...defaultShotDepthSettings, enabled: true, invert: false },
      { nearMeters: 0.5, farMeters: 18.2 },
      { frameRate: 30 },
    );
    expect(meta).toEqual({
      encoding: 'linear-camera-depth',
      nearMeters: 0.5,
      farMeters: 18.2,
      nearColor: 'white',
      farColor: 'black',
      backgroundColor: 'black',
      invert: false,
      rangeMode: 'auto',
      frameRate: 30,
    });
    expect(formatDepthRangeLegend({ nearMeters: 0.5, farMeters: 18.2 })).toBe('Near 0.5 m → Far 18.2 m');
  });

  it('lists depth still, motion, reference frames, and depth.json in the package manifest', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.cameraKeyframes = [
      {
        id: createId('kf'),
        label: 'Start',
        timeSeconds: 0,
        camera: { ...shot.camera },
        easing: 'linear',
      },
      {
        id: createId('kf'),
        label: 'End',
        timeSeconds: 2,
        camera: {
          ...shot.camera,
          position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
        },
        easing: 'linear',
      },
    ];
    shot.exportSettings.depth = {
      ...defaultShotDepthSettings,
      enabled: true,
    };
    const manifest = createShotPackageManifest(project, shot);
    expect(manifest.files.some((file) => file.path.endsWith('inputs/viewport_depth.png'))).toBe(true);
    expect(manifest.files.some((file) => file.path.endsWith('inputs/viewport_depth_motion.mp4'))).toBe(true);
    expect(manifest.files.some((file) => file.path.includes('camera_move/depth_start.png'))).toBe(true);
    expect(manifest.files.some((file) => file.path.endsWith('metadata/depth.json'))).toBe(true);
  });

  it('mentions depth usage guidance in image and video prompts', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.cameraKeyframes = [
      {
        id: createId('kf'),
        label: 'Start',
        timeSeconds: 0,
        camera: { ...shot.camera },
        easing: 'linear',
      },
      {
        id: createId('kf'),
        label: 'End',
        timeSeconds: 2,
        camera: { ...shot.camera },
        easing: 'linear',
      },
    ];
    shot.exportSettings.depth = {
      ...defaultShotDepthSettings,
      enabled: true,
    };
    const imagePrompt = generateImagePrompt(project, shot);
    expect(imagePrompt).toContain('Use the depth image only for spatial depth');
    expect(imagePrompt).toContain('Do not copy its grayscale appearance');
    expect(imagePrompt).toContain('inputs/camera_move/depth_*.png');

    const videoPrompt = generateVideoPrompt(shot);
    expect(videoPrompt).toContain('Use the depth video only for spatial depth');
    expect(videoPrompt).toContain('Do not copy its grayscale appearance');
  });

  it('implements MeshDepthMaterial packed-depth still rendering and reusable video resources', () => {
    const source = readFileSync(new URL('../src/engine/depthRender.ts', import.meta.url), 'utf8');
    expect(source).toContain('MeshDepthMaterial');
    expect(source).toContain('RGBADepthPacking');
    expect(source).toContain('perspectiveDepthToViewZ');
    expect(source).toContain('renderViewportDepth');
    expect(source).toContain('renderShotDepthFrame');
    expect(source).toContain('createDepthPassResources');
    expect(source).toContain('createFinalRenderSceneOptions');
  });

  it('routes depth through the shared camera-move frame renderer', () => {
    const source = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    expect(source).toContain("appearance?: 'clay' | 'projected' | 'depth'");
    expect(source).toContain('pass?: SceneRenderPass');
    expect(source).toContain('renderDepthGrayscale');
    expect(source).toContain('createDepthPassResources');
  });

  it('exposes Depth in the appearance toggle and depth settings panel', () => {
    const toggle = readFileSync(
      new URL('../src/components/common/AppearanceModeToggle.tsx', import.meta.url),
      'utf8',
    );
    const panel = readFileSync(
      new URL('../src/components/common/DepthSettingsPanel.tsx', import.meta.url),
      'utf8',
    );
    const shots = readFileSync(
      new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url),
      'utf8',
    );
    const exportWorkspace = readFileSync(
      new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url),
      'utf8',
    );
    const exportSettingsPanel = readFileSync(
      new URL('../src/components/export/ExportSettingsPanel.tsx', import.meta.url),
      'utf8',
    );
    expect(toggle).toContain('Depth');
    expect(toggle).toContain("onChange('depth')");
    expect(panel).toContain('data-depth-range-legend');
    expect(panel).toContain('data-depth-invert');
    expect(shots).toContain('data-shots-depth-settings');
    expect(shots).toContain('DepthSettingsPanel');
    expect(exportWorkspace).toContain('ExportSettingsPanel');
    expect(exportSettingsPanel).toContain('data-export-depth-camera-move-video');
    expect(exportSettingsPanel).toContain('data-export-depth-reference-frames');
  });
});
