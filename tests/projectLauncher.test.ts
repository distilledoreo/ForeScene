import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIALOGUE_DEMO_SAMPLE_ID,
  isDialogueDemoSample,
  loadSampleProject,
} from '../src/engine/sampleProjects';
import { isEffectivelyBlankProject } from '../src/domain/blankProject';
import { createBlankGrayboxProject } from '../src/engine/previs/blankProject';
import { DIALOGUE_DEMO_ASSETS } from '../src/samples/dialogueDemoAssets';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readSrc(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('Project launcher wiring (Phase 1 polish)', () => {
  it('ships featured-sample layout without a duplicate Explore card', () => {
    const launcher = readSrc('src/components/onboarding/ProjectLauncher.tsx');
    expect(launcher).toContain('data-project-launcher');
    expect(launcher).toContain('data-launcher-option={dataOption}');
    expect(launcher).toContain('dataOption="automated-previs"');
    expect(launcher).toContain('dataOption="build-manually"');
    expect(launcher).toContain('dataOption="open-existing"');
    // Three primary cards — no fourth "explore-sample" card that duplicates SampleProjectCard.
    expect(launcher).not.toContain('dataOption="explore-sample"');
    expect(launcher).toContain('SampleProjectCard');
    expect(launcher).toContain('Advanced');
    expect(launcher).toMatch(/Agent Console for use with an external coding agent/i);
    expect(launcher).toContain('data-project-launcher-dismiss');
  });

  it('does not dismiss the launcher before open-existing or sample load resolve', () => {
    const app = readSrc('src/App.tsx');
    const openExisting = app.match(/case 'open-existing':[\s\S]*?break;/);
    const loadSample = app.match(/case 'load-sample':[\s\S]*?break;/);
    const buildBlank = app.match(/case 'build-blank':[\s\S]*?break;/);

    expect(openExisting?.[0]).toBeTruthy();
    expect(openExisting![0]).not.toContain('setLauncherDismissed(true)');
    expect(openExisting![0]).toContain('openProjectPicker()');

    expect(loadSample?.[0]).toBeTruthy();
    expect(loadSample![0]).not.toContain('setLauncherDismissed(true)');
    expect(loadSample![0]).toContain('loadSampleProject');

    expect(buildBlank?.[0]).toMatch(/startBlankProject\(\)\.then/);
    expect(buildBlank![0]).toMatch(/if \(ok\) setLauncherDismissed\(true\)/);
  });

  it('gates launcher visibility with scaffold-based blank detection', () => {
    const blank = createBlankGrayboxProject({ name: 'Untitled' });
    expect(isEffectivelyBlankProject(blank)).toBe(true);
    const sample = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    expect(isEffectivelyBlankProject(sample)).toBe(false);
    expect(isDialogueDemoSample(sample)).toBe(true);
  });

  it('documents sample:generate and embeds distinct asset data URIs', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['sample:generate']).toMatch(/generate-sample-assets/);
    expect(DIALOGUE_DEMO_ASSETS.grayboxPano.dataUri).not.toBe(DIALOGUE_DEMO_ASSETS.styledPano.dataUri);
    expect(DIALOGUE_DEMO_ASSETS.grayboxPano.width).toBe(1024);
    expect(DIALOGUE_DEMO_ASSETS.styledPano.width).toBe(1024);
    expect(DIALOGUE_DEMO_ASSETS.contactSheet.width).toBe(1280);
    const thumbs = Object.values(DIALOGUE_DEMO_ASSETS.shotThumbnails).map((t) => t.dataUri);
    expect(new Set(thumbs).size).toBe(4);
  });

  it('bundles a dialogue-demo project JSON snapshot with sampleId', () => {
    const snapshot = JSON.parse(
      readSrc('src/samples/dialogue-demo.project.json'),
    ) as {
      sampleId: string;
      project: {
        name: string;
        shots: Array<{ shotNumber: string }>;
        assets: { assets: Record<string, { uri: string; metadata?: { sampleProjectId?: string } }> };
      };
    };
    expect(snapshot.sampleId).toBe('dialogue-demo');
    expect(snapshot.project.shots.map((shot) => shot.shotNumber)).toEqual([
      '010',
      '020',
      '030',
      '040',
    ]);
    const marker = Object.values(snapshot.project.assets.assets).some(
      (asset) => asset.metadata?.sampleProjectId === 'dialogue-demo',
    );
    expect(marker).toBe(true);
  });
});
