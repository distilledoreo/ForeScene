import { describe, expect, it } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultProject,
  createPanoReference,
  createSceneObject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
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
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import { buildStillArtifactSpecificationsForShot } from '../src/engine/stillArtifactPlanning';
import { stillArtifactKey, type StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

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

  it('plans a transparent character still for a cast-free shot', () => {
    const project = cloneProject();
    project.scene.objects = project.scene.objects.filter((object) => object.type !== 'human_dummy');
    project.shots[0]!.exportSettings = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      characterPass: {
        enabled: true,
        includeStill: true,
        includeMotion: true,
        motionFormat: 'both',
        backgroundColor: '#00FF00',
        includeAttachedProps: true,
      },
    });

    const plan = createExportPlan(project, project.shots);
    const characterStill = plan.shots[0]!.artifacts.find((artifact) => artifact.kind === 'character-still');
    expect(characterStill?.disposition).toBe('produce');
    expect(characterStill?.files.map((file) => file.path)).toEqual([
      expect.stringContaining('/inputs/characters/viewport_clay_characters.png'),
    ]);
    expect(plan.issues.some((issue) => issue.code === 'character-pass-empty')).toBe(true);
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

  it('emits a matching forescene-v2 plan when requested, with shared artifacts kept out of shot artifacts', () => {
    const project = cloneProject();
    project.exportConfiguration = {
      ...project.exportConfiguration!,
      packageFormat: 'forescene-v2',
    };
    const plan = createExportPlan(project, project.shots);
    expect(plan.packageFormat).toBe('forescene-v2');
    expect(plan.requestedPackageFormat).toBe('forescene-v2');
    expect(plan.issues.some((issue) => issue.code === 'package-format-v2-unsupported')).toBe(false);
    expect(plan.shots[0]!.artifacts.every((artifact) => (
      artifact.kind !== 'global-reference' && artifact.kind !== 'global-graybox' && artifact.kind !== 'cubemap'
    ))).toBe(true);
    expect(plan.sharedArtifacts.some((artifact) => artifact.kind === 'package-root-manifest')).toBe(true);
    expect(plan.sharedArtifacts.some((artifact) => artifact.kind === 'start-here')).toBe(true);
    for (const file of listPlannedFiles(plan)) {
      const isShotFile = file.path.startsWith('shots/');
      const isSharedOrRoot = file.path.startsWith('shared_references/') || file.path === 'manifest.json' || file.path === 'START_HERE.html';
      expect(isShotFile || isSharedOrRoot).toBe(true);
    }
  });

  it('omits panorama and AI artifacts when the registry asset is missing', () => {
    const project = cloneProject();
    const shot = project.shots[0]!;
    const missingAssetId = 'asset-missing-from-registry';
    const pano = createPanoReference({
      name: 'Broken canonical',
      assetId: missingAssetId,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 4,
      height: 2,
      isCanonical: true,
    });
    project.panoRefs.push(pano);
    shot.linkedPanoId = pano.id;
    shot.panoCrop = {
      panoId: pano.id,
      yawDegrees: 0,
      pitchDegrees: 0,
      rollDegrees: 0,
      fovDegrees: 60,
      aspectRatio: 16 / 9,
      width: 1920,
      height: 1080,
    };
    shot.assets.aiResultFrameAssetId = 'ai-missing-asset';
    shot.exportSettings = normalizeShotExportSettings({
      ...defaultShotExportSettings,
      includeViewport: false,
      includePanoCrop: true,
      includeFullPano: true,
      includeCubemap: true,
      includeGrayboxPano: false,
      includeAiResultFrame: true,
      includeCameraMoveVideo: false,
      includeMetadata: false,
      includePrompt: false,
    });

    const plan = createExportPlan(project, [shot]);
    const byKind = Object.fromEntries(
      plan.shots[0]!.artifacts.map((artifact) => [artifact.kind, artifact]),
    );

    expect(byKind['pano-crop']?.disposition).toBe('omit');
    expect(byKind['pano-crop']?.omissionCode).toBe('missing-pano-crop-asset');
    expect(byKind['global-reference']?.disposition).toBe('omit');
    expect(byKind['global-reference']?.omissionCode).toBe('missing-canonical-pano-asset');
    expect(byKind.cubemap?.disposition).toBe('omit');
    expect(byKind.cubemap?.omissionCode).toBe('missing-full-pano-asset');
    expect(byKind['ai-result-frame']?.disposition).toBe('omit');
    expect(byKind['ai-result-frame']?.omissionCode).toBe('missing-ai-result-asset');
    expect(listPlannedFiles(plan).some((file) => file.path.includes('pano_crop.png'))).toBe(false);
    expect(listPlannedFiles(plan).some((file) => file.path.includes('global_reference.png'))).toBe(false);
    expect(listPlannedFiles(plan).some((file) => file.path.includes('ai_result_frame.png'))).toBe(false);
    expect(plan.issues.some((issue) => issue.code === 'pano-crop-missing-asset')).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'global-reference-missing-asset')).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'ai-result-missing-asset')).toBe(true);
  });
});

describe('reference-frame group readiness', () => {
  function projectWithReferenceFrames(): LocationProject {
    const project = cloneProject();
    const shot = project.shots[0]!;
    project.shots = [withMove(shot)];
    project.shots[0]!.exportSettings = {
      ...project.shots[0]!.exportSettings,
      includeViewport: true,
      includeProjectedViewport: false,
      includeCameraMoveReferenceFrames: true,
      includeProjectedCameraMoveReferenceFrames: false,
      includeCameraMoveVideo: false,
      peopleExportMode: 'both',
      characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
      depth: { ...defaultShotDepthSettings, enabled: false },
    };
    return project;
  }

  function seedReferenceFrames(project: LocationProject, spec: StillArtifactSpecification): LocationProject {
    const shot = project.shots[0]!;
    const expected = computeStillArtifactFingerprint(project, shot, spec).key;
    const key = stillArtifactKey(spec);
    const assetId = `asset-${key.replace(/[^a-z0-9]/gi, '-')}`;
    return {
      ...project,
      assets: {
        ...project.assets,
        assets: {
          ...project.assets.assets,
          [assetId]: {
            id: assetId,
            type: 'image',
            name: key,
            uri: `blob:ref-${assetId}`,
            mimeType: 'image/png',
            width: spec.width,
            height: spec.height,
            createdAt: new Date().toISOString(),
          },
        },
      },
      shots: project.shots.map((item) => (
        item.id === shot.id
          ? {
            ...item,
            materializedMedia: {
              stills: {
                ...(item.materializedMedia?.stills ?? {}),
                [key]: {
                  id: `still-${key}`,
                  key,
                  kind: spec.kind,
                  assetId,
                  fingerprint: expected,
                  dependencyIds: [],
                  width: spec.width,
                  height: spec.height,
                  mimeType: 'image/png' as const,
                  appearance: spec.appearance,
                  peopleVariant: spec.peopleVariant,
                  timeSeconds: spec.timeSeconds,
                  frameRole: spec.frameRole,
                  createdAt: new Date().toISOString(),
                },
              },
            },
          }
          : item
      )),
    };
  }

  it('group is ready only when every frame and people variant is fresh', () => {
    let project = projectWithReferenceFrames();
    const shot = project.shots[0]!;
    const specs = buildStillArtifactSpecificationsForShot({ project, shot, purpose: 'export' })
      .filter((spec) => spec.kind === 'clay-reference-frame');
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) project = seedReferenceFrames(project, spec);

    const plan = createExportPlan(project, [project.shots[0]!]);
    const group = plan.shots[0]!.artifacts.find((artifact) => artifact.kind === 'clay-reference-frames');
    expect(group?.readiness).toBe('ready');
    expect(group?.source).toBe('materialized-asset');
  });

  it('reports stale when one frame of the group is missing or outdated', () => {
    let project = projectWithReferenceFrames();
    const shot = project.shots[0]!;
    const specs = buildStillArtifactSpecificationsForShot({ project, shot, purpose: 'export' })
      .filter((spec) => spec.kind === 'clay-reference-frame');
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) project = seedReferenceFrames(project, spec);

    // Drop exactly one frame from the group (e.g. mid frame of clean plate).
    const droppedKey = stillArtifactKey(specs[specs.length - 1]!);
    project = {
      ...project,
      shots: project.shots.map((item) => (
        item.id === shot.id
          ? {
            ...item,
            materializedMedia: {
              stills: (() => {
                const stills = { ...(item.materializedMedia?.stills ?? {}) };
                delete stills[droppedKey];
                return stills;
              })(),
            },
          }
          : item
      )),
    };

    const plan = createExportPlan(project, [project.shots[0]!]);
    const group = plan.shots[0]!.artifacts.find((artifact) => artifact.kind === 'clay-reference-frames');
    expect(group?.readiness).toBe('stale');
    expect(group?.source).toBe('render-recovery');
  });

  it('does not infer group readiness from an unrelated still', () => {
    const project = projectWithReferenceFrames();
    const shot = project.shots[0]!;
    // Seed only a single viewport still — the classic false-positive case.
    const clayViewport = buildStillArtifactSpecificationsForShot({ project, shot, purpose: 'export' })
      .find((spec) => spec.kind === 'clay-viewport')!;
    const seeded = seedReferenceFrames(project, clayViewport);

    const plan = createExportPlan(seeded, [seeded.shots[0]!]);
    const group = plan.shots[0]!.artifacts.find((artifact) => artifact.kind === 'clay-reference-frames');
    expect(group?.readiness).toBe('missing');
    expect(group?.source).toBe('render-recovery');
  });
});
