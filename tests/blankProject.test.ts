import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  isEffectivelyBlankProject,
  isPlaceholderShot,
} from '../src/domain/blankProject';
import { createBlankGrayboxProject } from '../src/engine/previs/blankProject';
import {
  createDialogueDemoSample,
  DIALOGUE_DEMO_SAMPLE_ID,
  isDialogueDemoSample,
  loadSampleProject,
  resetSampleProject,
  SAMPLE_PROJECTS,
} from '../src/engine/sampleProjects';
import { createExportPlan } from '../src/engine/exportPlan';
import {
  getExportSelectionWarnings,
  getProjectWarnings,
} from '../src/engine/warnings';

describe('isEffectivelyBlankProject', () => {
  it('treats a blank graybox shell as blank', () => {
    const project = createBlankGrayboxProject({ name: 'Untitled Production' });
    expect(isEffectivelyBlankProject(project)).toBe(true);
  });

  it('treats the default temple starter as non-blank', () => {
    const project = createDefaultProject();
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('treats the dialogue sample as non-blank', () => {
    const project = createDialogueDemoSample();
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('ignores scaffold floor/sun and a single origin placeholder shot', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    expect(project.scene.objects.every((object) => (
      object.type === 'floor' || object.type === 'sun_marker'
    ))).toBe(true);
    expect(project.shots).toHaveLength(1);
    expect(isPlaceholderShot(project.shots[0]!)).toBe(true);
    expect(isEffectivelyBlankProject(project)).toBe(true);
  });

  it('becomes non-blank when a real production shot is added', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    project.shots.push({
      ...project.shots[0]!,
      id: 'shot_real_020',
      shotNumber: '020',
      name: 'Wide establishing',
      description: 'Wide of the courtyard entrance.',
    });
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('becomes non-blank when a character is added', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    const character = {
      ...project.scene.objects[0]!,
      id: 'obj_person',
      type: 'human_dummy' as const,
      name: 'Hero',
      stagingRole: 'person' as const,
      dimensions: [0.55, 1.75, 0.55] as [number, number, number],
    };
    project.scene.objects.push(character);
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });

  it('becomes non-blank when a pano reference is present', () => {
    const project = createBlankGrayboxProject({ name: 'Shell' });
    project.panoRefs.push({
      id: 'pano_1',
      name: 'Graybox',
      imageAssetId: 'asset_missing',
      type: 'graybox_render',
      projection: 'equirectangular',
      origin: [0, 1.65, 0],
      rotation: [0, 0, 0],
      width: 4,
      height: 2,
      isCanonical: true,
      createdAt: new Date().toISOString(),
    });
    expect(isEffectivelyBlankProject(project)).toBe(false);
  });
});

describe('sample project load and reset', () => {
  it('registers the dialogue demo sample with outcome-oriented copy', () => {
    const sample = SAMPLE_PROJECTS.find((entry) => entry.id === DIALOGUE_DEMO_SAMPLE_ID);
    expect(sample).toBeTruthy();
    expect(sample!.title.length).toBeGreaterThan(0);
    expect(sample!.outcome.length).toBeGreaterThan(20);
  });

  it('loads a self-contained dialogue production with expected structure', () => {
    const project = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);

    expect(project.name).toBe('Dialogue Demo');
    expect(isDialogueDemoSample(project)).toBe(true);
    expect(isEffectivelyBlankProject(project)).toBe(false);

    const shotNumbers = project.shots.map((shot) => shot.shotNumber);
    const shotNames = project.shots.map((shot) => shot.name);
    expect(shotNumbers).toEqual(['010', '020', '030', '040']);
    expect(shotNames).toEqual([
      'Wide two-shot',
      'Alex medium',
      'Blair OTS',
      'Alex close-up',
    ]);

    const people = project.scene.objects.filter((object) => object.stagingRole === 'person');
    expect(people.map((object) => object.name).sort()).toEqual(['Alex', 'Blair']);

    const props = project.scene.objects.filter((object) => object.stagingRole === 'prop');
    expect(props.some((object) => /table/i.test(object.name))).toBe(true);

    expect(project.panoRefs.length).toBeGreaterThanOrEqual(1);
    expect(project.panoRefs.some((pano) => pano.type === 'ai_global_reference')).toBe(true);

    const assets = Object.values(project.assets.assets);
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const asset of assets) {
      expect(asset.uri.startsWith('data:image/png')).toBe(true);
    }

    expect(project.exportConfiguration).toBeTruthy();
    expect(project.exportConfiguration!.defaults.includeViewport).toBe(true);
    expect(project.exportConfiguration!.defaults.width).toBeGreaterThan(0);

    // Every shot has staging overrides and is linked to the styled pano.
    const styledPano = project.panoRefs.find((pano) => pano.type === 'ai_global_reference');
    expect(styledPano).toBeTruthy();
    for (const shot of project.shots) {
      expect(Object.keys(shot.objectOverrides ?? {}).length).toBeGreaterThan(0);
      expect(shot.linkedPanoId).toBe(styledPano!.id);
      expect(shot.exportSettings.width).toBeGreaterThan(0);
      expect(shot.exportSettings.includeGrayboxPano).toBe(true);
    }
  });

  it('reset restores the bundled baseline independent of prior mutation', () => {
    const original = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    original.name = 'Mutated';
    original.shots.pop();
    original.scene.objects = [];

    const restored = resetSampleProject(DIALOGUE_DEMO_SAMPLE_ID);
    expect(restored.name).toBe('Dialogue Demo');
    expect(restored.shots).toHaveLength(4);
    expect(restored.shots.map((shot) => shot.shotNumber)).toEqual(['010', '020', '030', '040']);
    expect(restored.scene.objects.length).toBeGreaterThan(5);
    expect(isDialogueDemoSample(restored)).toBe(true);
    // Fresh document ids so it can replace the live project cleanly.
    expect(restored.id).not.toBe(original.id);
  });

  it('rejects unknown sample ids', () => {
    expect(() => loadSampleProject('not-a-real-sample')).toThrow(/Unknown sample/i);
  });

  it('reaches Export without graybox or missing-file preflight warnings', () => {
    const project = loadSampleProject(DIALOGUE_DEMO_SAMPLE_ID);

    expect(project.panoRefs.some((pano) => pano.type === 'graybox_render')).toBe(true);
    expect(project.panoRefs.some((pano) => pano.type === 'ai_global_reference')).toBe(true);
    for (const pano of project.panoRefs) {
      const asset = project.assets.assets[pano.imageAssetId];
      expect(asset?.uri.startsWith('data:image/png')).toBe(true);
    }

    // Project-level setup warnings should not flag missing panos for the sample.
    const projectWarnings = getProjectWarnings(project);
    expect(projectWarnings.filter((item) => item.severity === 'warning').map((item) => item.id))
      .not.toContain('missing-graybox-pano');
    expect(projectWarnings.filter((item) => item.severity === 'warning').map((item) => item.id))
      .not.toContain('missing-canonical-pano');

    // Export selection for all sample shots must not request missing graybox assets.
    const selectionWarnings = getExportSelectionWarnings(project, project.shots);
    const warningIds = selectionWarnings
      .filter((item) => item.severity === 'warning')
      .map((item) => item.id);
    expect(warningIds).not.toContain('selection-missing-graybox-pano');
    expect(warningIds).not.toContain('selection-missing-projector');
    expect(warningIds).not.toContain('selection-missing-full-pano');

    const plan = createExportPlan(project, project.shots, { packageType: 'selected-shots' });
    const grayboxOmits = plan.shots.flatMap((entry) =>
      entry.artifacts.filter((artifact) => (
        artifact.kind === 'global-graybox' && artifact.disposition === 'omit'
      )),
    );
    expect(grayboxOmits).toEqual([]);
    const grayboxProduces = plan.shots.flatMap((entry) =>
      entry.artifacts.filter((artifact) => (
        artifact.kind === 'global-graybox' && artifact.disposition === 'produce'
      )),
    );
    expect(grayboxProduces.length).toBe(project.shots.length);

    const warningCodes = plan.issues
      .filter((issue) => issue.severity === 'warning')
      .map((issue) => issue.code);
    expect(warningCodes.some((code) => code.includes('graybox'))).toBe(false);
    expect(warningCodes.some((code) => code.includes('missing'))).toBe(false);
  });
});
