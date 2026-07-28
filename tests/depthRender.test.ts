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
  shouldExportViewportDepth,
} from '../src/engine/depthRender';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import { generateImagePrompt } from '../src/engine/prompts';

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

  it('gates package depth stills behind enabled + includeViewportStill', () => {
    expect(shouldExportViewportDepth({ ...defaultShotDepthSettings, enabled: true })).toBe(true);
    expect(shouldExportViewportDepth({
      ...defaultShotDepthSettings,
      enabled: true,
      includeViewportStill: false,
    })).toBe(false);
    expect(shouldExportViewportDepth(defaultShotDepthSettings)).toBe(false);
  });

  it('records encoding convention and range in depth metadata', () => {
    const meta = buildDepthMetadata(
      { ...defaultShotDepthSettings, enabled: true, invert: false },
      { nearMeters: 0.5, farMeters: 18.2 },
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
    });
    expect(formatDepthRangeLegend({ nearMeters: 0.5, farMeters: 18.2 })).toBe('Near 0.5 m → Far 18.2 m');
  });

  it('lists viewport_depth.png and depth.json in the package manifest when enabled', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.exportSettings.depth = {
      ...defaultShotDepthSettings,
      enabled: true,
      includeViewportStill: true,
    };
    const manifest = createShotPackageManifest(project, shot);
    expect(manifest.files.some((file) => file.path.endsWith('inputs/viewport_depth.png'))).toBe(true);
    expect(manifest.files.some((file) => file.path.endsWith('metadata/depth.json'))).toBe(true);
  });

  it('mentions depth usage guidance in the image prompt when depth stills are enabled', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.exportSettings.depth = {
      ...defaultShotDepthSettings,
      enabled: true,
    };
    const prompt = generateImagePrompt(project, shot);
    expect(prompt).toContain('Use the depth image only for spatial depth');
    expect(prompt).toContain('Do not copy its grayscale appearance');
  });

  it('implements MeshDepthMaterial packed-depth still rendering', () => {
    const source = readFileSync(new URL('../src/engine/depthRender.ts', import.meta.url), 'utf8');
    expect(source).toContain('MeshDepthMaterial');
    expect(source).toContain('RGBADepthPacking');
    expect(source).toContain('perspectiveDepthToViewZ');
    expect(source).toContain('renderViewportDepth');
    expect(source).toContain('renderShotDepthFrame');
    expect(source).toContain('createFinalRenderSceneOptions');
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
    expect(toggle).toContain('Depth');
    expect(toggle).toContain("onChange('depth')");
    expect(panel).toContain('data-depth-range-legend');
    expect(panel).toContain('data-depth-invert');
    expect(shots).toContain('data-shots-depth-settings');
    expect(shots).toContain('DepthSettingsPanel');
  });
});
