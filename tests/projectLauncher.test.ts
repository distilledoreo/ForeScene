import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readSrc(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('Project launcher wiring (Phase 1)', () => {
  it('ships onboarding components and sample registry at the expected paths', () => {
    const launcher = readSrc('src/components/onboarding/ProjectLauncher.tsx');
    const manual = readSrc('src/components/onboarding/ManualProjectOptions.tsx');
    const sampleCard = readSrc('src/components/onboarding/SampleProjectCard.tsx');
    const samples = readSrc('src/engine/sampleProjects.ts');
    const blank = readSrc('src/domain/blankProject.ts');

    expect(launcher).toContain('data-project-launcher');
    expect(launcher).toContain('Automated Previs');
    expect(launcher).toContain('Build Manually');
    expect(launcher).toContain('Explore a Sample');
    expect(launcher).toContain('Open Existing Project');
    // Outcome-oriented copy (not title-only).
    expect(launcher).toMatch(/shot list/i);
    expect(launcher).toMatch(/complete example|complete mini production|Alex & Blair/i);
    expect(launcher).toMatch(/Import a ForeScene backup|locally recovered/i);
    expect(launcher).toContain('data-project-launcher-dismiss');
    expect(launcher).toContain('Skip to Build');

    expect(manual).toContain('data-manual-project-options');
    expect(manual).toContain('Blank graybox');
    expect(manual).toContain('Temple starter');

    expect(sampleCard).toContain('data-sample-project-card');
    expect(sampleCard).toContain('Reset sample');

    expect(samples).toContain('createDialogueDemoSample');
    expect(samples).toContain('loadSampleProject');
    expect(samples).toContain('resetSampleProject');
    expect(blank).toContain('export function isEffectivelyBlankProject');
  });

  it('gates the launcher on Studio + blank project + not dismissed', () => {
    const app = readSrc('src/App.tsx');
    expect(app).toContain('isEffectivelyBlankProject');
    expect(app).toContain('showProjectLauncher');
    expect(app).toContain('launcherDismissed');
    expect(app).toContain('<ProjectLauncher');
    expect(app).toContain("case 'dismiss'");
    expect(app).toContain("case 'load-sample'");
    expect(app).toContain("case 'open-existing'");
    expect(app).toContain("case 'automated-previs'");
    expect(app).toContain('loadSampleProject');
    expect(app).toContain('resetSampleProject');
    expect(app).toContain('data-project-reset-sample');
    expect(app).toContain('data-project-load-sample');
  });

  it('does not dismiss the launcher before open-existing or sample load resolve', () => {
    const app = readSrc('src/App.tsx');
    // Extract the open-existing and load-sample cases so early dismiss is not hidden.
    const openExisting = app.match(/case 'open-existing':[\s\S]*?break;/);
    const loadSample = app.match(/case 'load-sample':[\s\S]*?break;/);
    const buildBlank = app.match(/case 'build-blank':[\s\S]*?break;/);
    const buildStarter = app.match(/case 'build-starter':[\s\S]*?break;/);

    expect(openExisting?.[0]).toBeTruthy();
    expect(openExisting![0]).not.toContain('setLauncherDismissed(true)');
    expect(openExisting![0]).toContain('openProjectPicker()');

    expect(loadSample?.[0]).toBeTruthy();
    expect(loadSample![0]).not.toContain('setLauncherDismissed(true)');
    expect(loadSample![0]).toContain('loadSampleProject');

    // Blank stays blank — dismiss only after successful startBlankProject().
    expect(buildBlank?.[0]).toMatch(/startBlankProject\(\)\.then/);
    expect(buildBlank![0]).toMatch(/if \(ok\) setLauncherDismissed\(true\)/);

    // Starter becomes non-blank and hides the launcher without an early dismiss.
    expect(buildStarter?.[0]).not.toContain('setLauncherDismissed(true)');
    expect(buildStarter![0]).toContain('startStarterProject');
  });

  it('wires sample load/reset and blank/starter starts through project lifecycle', () => {
    const lifecycle = readSrc('src/hooks/useProjectLifecycle.ts');
    expect(lifecycle).toContain('loadSampleProject');
    expect(lifecycle).toContain('resetSampleProject');
    expect(lifecycle).toContain('startBlankProject');
    expect(lifecycle).toContain('startStarterProject');
    expect(lifecycle).toContain('createBlankGrayboxProject');
    expect(lifecycle).toContain('createDefaultProject');
    expect(lifecycle).toContain('loadBundledSample');
  });

  it('starts fresh installs on a blank graybox so the launcher can appear', () => {
    const initial = readSrc('src/state/slices/initialProject.ts');
    expect(initial).toContain('createBlankGrayboxProject');
    expect(initial).not.toMatch(/createDefaultProject\s*\(\s*\)/);
  });

  it('documents the launcher in the help catalog', () => {
    const help = readSrc('src/components/help/helpCatalog.ts');
    expect(help).toContain("id: 'first-project-launcher'");
    expect(help).toContain('Automated Previs');
    expect(help).toContain('Explore a Sample');
    expect(help).toContain('Reset sample');
  });

  it('bundles a dialogue-demo project JSON snapshot without external asset URLs', () => {
    const snapshot = JSON.parse(
      readSrc('src/samples/dialogue-demo.project.json'),
    ) as {
      sampleId: string;
      project: {
        name: string;
        shots: Array<{ shotNumber: string; name: string }>;
        panoRefs: unknown[];
        assets: { assets: Record<string, { uri: string }> };
      };
    };
    expect(snapshot.sampleId).toBe('dialogue-demo');
    expect(snapshot.project.name).toBe('Dialogue Demo');
    expect(snapshot.project.shots.map((shot) => shot.shotNumber)).toEqual([
      '010',
      '020',
      '030',
      '040',
    ]);
    expect(snapshot.project.panoRefs.length).toBeGreaterThanOrEqual(1);
    for (const asset of Object.values(snapshot.project.assets.assets)) {
      expect(asset.uri.startsWith('data:')).toBe(true);
      expect(asset.uri).not.toMatch(/^https?:\/\//);
    }
  });
});
