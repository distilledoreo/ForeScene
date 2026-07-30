import { describe, expect, it } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultProject,
  createSceneObject,
  defaultShotExportSettings,
  normalizeShotExportSettings,
} from '../src/domain/defaults';
import type { LocationProject, Shot } from '../src/domain/types';
import {
  countProducedArtifacts,
  createExportPlan,
  createLegacyShotManifest,
  listPlannedFiles,
  planHasBlockingErrors,
} from '../src/engine/exportPlan';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import { setShotExportOverride } from '../src/engine/exportConfiguration';
import { countShotPackageUnits } from '../src/engine/packageExport';

function cloneProject(): LocationProject {
  return structuredClone(createDefaultProject());
}

function withMove(shot: Shot): Shot {
  return {
    ...shot,
    cameraKeyframes: [
      createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shot.camera }),
      createCameraKeyframe({
        label: 'End',
        timeSeconds: 2,
        camera: {
          ...shot.camera,
          position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
        },
      }),
    ],
  };
}

describe('export plan', () => {
  it('describes a complete legacy package without rendering', () => {
    const project = cloneProject();
    const plan = createExportPlan(project, project.shots, { packageType: 'scene' });

    expect(plan.schemaVersion).toBe(1);
    expect(plan.packageFormat).toBe('legacy-v1');
    expect(plan.packageType).toBe('scene');
    expect(plan.shots).toHaveLength(1);
    expect(plan.estimatedFileCount).toBeGreaterThan(5);
    expect(plan.archiveFileName).toMatch(/_package\.zip$/);
    expect(listPlannedFiles(plan).some((file) => file.path.endsWith('/manifest.json'))).toBe(true);
    expect(listPlannedFiles(plan, { manifestEntriesOnly: true })
      .some((file) => file.path.endsWith('/manifest.json'))).toBe(false);
  });

  it('matches createShotPackageManifest inventory for a default shot', () => {
    const project = cloneProject();
    const shot = project.shots[0]!;
    const plan = createExportPlan(project, [shot]);
    const legacy = createShotPackageManifest(project, shot);
    const fromPlan = createLegacyShotManifest(plan.shots[0]!);

    expect(fromPlan.rootFolder).toBe(legacy.rootFolder);
    expect(fromPlan.files.map((file) => file.path).sort()).toEqual(
      legacy.files.map((file) => file.path).sort(),
    );
  });

  it('resolves scene defaults + overrides for planned settings', () => {
    let project = cloneProject();
    const shotId = project.shots[0]!.id;
    project = setShotExportOverride(project, shotId, {
      includeViewport: false,
      depth: { enabled: true },
    });
    const plan = createExportPlan(project, project.shots);
    expect(plan.shots[0]!.resolvedSettings.includeViewport).toBe(false);
    expect(plan.shots[0]!.resolvedSettings.depth?.enabled).toBe(true);
    expect(plan.shots[0]!.hasOverrides).toBe(true);
    expect(plan.summary.overrideShotCount).toBe(1);
    expect(plan.issues.some((issue) => issue.code === 'shot-has-export-overrides')).toBe(true);
  });

  it('omits projected artifacts when no projector is available and records a warning', () => {
    const project = cloneProject();
    project.shots[0]!.exportSettings = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      includeProjectedViewport: true,
      includeProjectedCameraMoveVideo: true,
    });
    const plan = createExportPlan(project, project.shots);
    const projected = plan.shots[0]!.artifacts.find((artifact) => artifact.kind === 'projected-viewport');
    expect(projected?.disposition).toBe('omit');
    expect(projected?.omissionCode).toBe('missing-projector');
    expect(plan.issues.some((issue) => issue.message.includes('Projected'))).toBe(true);
  });

  it('counts camera-move and character sequence files when a move exists', () => {
    let project = cloneProject();
    const character = createSceneObject('human_dummy', 2);
    project.scene.objects.push(character);
    project.shots[0] = withMove(project.shots[0]!);
    project.shots[0]!.exportSettings = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      characterPass: {
        enabled: true,
        includeStill: true,
        includeMotion: true,
        motionFormat: 'transparent_png_sequence',
        backgroundColor: '#00FF00',
        includeAttachedProps: true,
      },
    });

    const plan = createExportPlan(project, project.shots);
    expect(countProducedArtifacts(plan, 'clay-camera-move')).toBe(1);
    expect(countProducedArtifacts(plan, 'character-sequence')).toBe(1);
    expect(plan.shots[0]!.estimatedFileCount).toBeGreaterThan(10);
  });

  it('treats empty selection as a blocking error', () => {
    const project = cloneProject();
    const plan = createExportPlan(project, []);
    expect(planHasBlockingErrors(plan)).toBe(true);
    expect(plan.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('assigns collision-safe root folders for duplicate production IDs', () => {
    const project = cloneProject();
    const second = structuredClone(project.shots[0]!);
    second.id = 'shot-b';
    second.productionShotId = '42A';
    project.shots[0]!.productionShotId = '42A';
    project.shots.push(second);

    const plan = createExportPlan(project, project.shots);
    const folders = plan.shots.map((shot) => shot.rootFolder);
    expect(new Set(folders).size).toBe(2);
    expect(plan.issues.some((issue) => issue.code.includes('duplicate-production') || issue.id.includes('duplicate-production'))).toBe(true);
  });

  it('keeps countShotPackageUnits aligned with planned work units', () => {
    const project = cloneProject();
    const shot = withMove(project.shots[0]!);
    project.shots[0] = shot;
    const plan = createExportPlan(project, [shot]);
    expect(countShotPackageUnits(project, shot)).toBe(plan.shots[0]!.workUnits);
  });

  it('notes when forescene-v2 is requested but not yet implemented', () => {
    const project = cloneProject();
    project.exportConfiguration = {
      ...project.exportConfiguration!,
      packageFormat: 'forescene-v2',
    };
    const plan = createExportPlan(project, project.shots);
    expect(plan.packageFormat).toBe('legacy-v1');
    expect(plan.requestedPackageFormat).toBe('forescene-v2');
    expect(plan.issues.some((issue) => issue.code === 'package-format-v2-unsupported')).toBe(true);
  });
});
