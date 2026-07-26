import { describe, expect, it, vi } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference, createShot } from '../src/domain/defaults';
import { createShotPackageManifest, selectExportPathPreview } from '../src/engine/exportManifest';
import { generateImagePrompt } from '../src/engine/prompts';
import { ShotPackageError, buildShotPackage } from '../src/engine/packageExport';
import { serializeProject, parseProject } from '../src/engine/projectIO';
import { formatWarningSummary, getExportSelectionWarnings, getProjectWarnings, getShotWarnings, shouldShowMissingLandmarkPromptNote } from '../src/engine/warnings';
import { getLatestGrayboxPano, getPanoAsset } from '../src/domain/selectors';
import { setTwoPointCameraKeyframe } from '../src/engine/cameraKeyframes';
import { useContinuityStore } from '../src/state/useContinuityStore';
import { resolveStyledImportMode } from '../src/engine/multiOriginProjection';

describe('project workflow logic', () => {
  it('creates a valid default local-first project', () => {
    const project = createDefaultProject();
    expect(project.schemaVersion).toBe('0.1');
    expect(project.scene.objects.length).toBeGreaterThan(0);
    expect(project.scene.panoOrigin).toEqual([0, 1.65, 0]);
    expect(project.scene.objects.find((object) => object.name === 'Main Temple Gate')?.transform.position[2]).toBeGreaterThan(0);
    expect(project.scene.objects.find((object) => object.name === 'Man Facing Camera')?.transform.position[2]).toBeGreaterThan(0);
    expect(project.landmarks[0].promptCritical).toBe(true);
    expect(project.shots.length).toBe(1);
    expect(project.shots[0].name).toBe('Camera 001');
    expect(project.shots[0].camera.position).toEqual(project.scene.panoOrigin);
  });

  it('serializes and parses project JSON', () => {
    const project = createDefaultProject();
    const parsed = parseProject(serializeProject(project));
    expect(parsed.id).toBe(project.id);
    expect(parsed.scene.objects[0].name).toBe(project.scene.objects[0].name);
  });

  it('does not serialize unreferenced image, video, or model registry entries', () => {
    const project = createDefaultProject();
    const referenced = createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,REFERENCE',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Reference',
      assetId: referenced.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 2048,
      height: 1024,
      isCanonical: true,
    });
    project.assets.assets[referenced.id] = referenced;
    project.assets.assets.orphanImage = {
      id: 'orphanImage',
      type: 'image',
      name: 'old.png',
      uri: 'data:image/png;base64,OLD',
      createdAt: new Date(0).toISOString(),
    };
    project.assets.assets.orphanVideo = {
      id: 'orphanVideo',
      type: 'video',
      name: 'old.mp4',
      uri: 'data:video/mp4;base64,OLD',
      createdAt: new Date(0).toISOString(),
    };
    project.assets.assets.orphanModel = {
      id: 'orphanModel',
      type: 'model',
      name: 'old.glb',
      uri: 'data:model/gltf-binary;base64,OLD',
      createdAt: new Date(0).toISOString(),
    };
    project.panoRefs = [pano];

    const serialized = JSON.parse(serializeProject(project)) as typeof project;
    expect(Object.keys(serialized.assets.assets)).toEqual([referenced.id]);
  });

  it('rejects unsupported project JSON during import parsing', () => {
    const project = createDefaultProject();
    expect(() => parseProject(JSON.stringify({ ...project, schemaVersion: '9.9' })))
      .toThrow('Unsupported project schema version.');
  });

  it('migrates legacy in-app skinned frame fields to imported AI result fields', () => {
    const project = createDefaultProject();
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 0],
        target: [0, 1.6, 5],
        fovDegrees: 55,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    const legacyShot = {
      ...shot,
      exportSettings: {
        ...shot.exportSettings,
        includeContinuityControlView: true,
        includeAiResultFrame: undefined,
        includeSkinnedFrame: true,
      },
      assets: {
        ...shot.assets,
        skinnedFrameAssetId: 'asset_legacy_result',
      },
    };
    project.shots = [legacyShot as unknown as typeof shot];

    const parsed = parseProject(JSON.stringify(project));
    expect(parsed.shots[0].exportSettings.includeAiResultFrame).toBe(true);
    expect(parsed.shots[0].exportSettings).not.toHaveProperty('includeContinuityControlView');
    expect(parsed.shots[0].assets.aiResultFrameAssetId).toBe('asset_legacy_result');
  });

  it('normalizes legacy shots without camera keyframes or video export toggles', () => {
    const project = createDefaultProject();
    const legacyShot = {
      ...project.shots[0],
      cameraKeyframes: undefined,
      exportSettings: {
        ...project.shots[0].exportSettings,
        includeCameraMoveVideo: undefined,
        includeCameraMoveReferenceFrames: undefined,
      },
    };
    project.shots = [legacyShot as unknown as typeof project.shots[0]];

    const parsed = parseProject(JSON.stringify(project));
    expect(parsed.shots[0].cameraKeyframes).toEqual([]);
    expect(parsed.shots[0].exportSettings.includeCameraMoveVideo).toBe(true);
    expect(parsed.shots[0].exportSettings.includeCameraMoveReferenceFrames).toBe(true);
  });

  it('defaults legacy or invalid camera-keyframe easing to linear', () => {
    const project = createDefaultProject();
    project.shots[0].cameraKeyframes = [
      {
        id: 'keyframe_legacy',
        label: 'Start',
        timeSeconds: 0,
        camera: project.shots[0].camera,
      },
      {
        id: 'keyframe_invalid',
        label: 'End',
        timeSeconds: 3,
        camera: project.shots[0].camera,
        easing: 'spring' as never,
      },
    ];

    const parsed = parseProject(JSON.stringify(project));
    expect(parsed.shots[0].cameraKeyframes.map((keyframe) => keyframe.easing)).toEqual([
      'linear',
      'linear',
    ]);
  });

  it('normalizes legacy pano references without rotation', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'legacy_reference.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Legacy Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push({ ...pano, rotation: undefined } as unknown as typeof pano);

    const parsed = parseProject(JSON.stringify(project));
    expect(parsed.panoRefs[0].rotation).toEqual([0, 0, 0]);
  });

  it('defaults scene.panoRotation and multi-origin projectedStyle fields for pre-feature projects', () => {
    const project = createDefaultProject();
    // Simulate a project JSON saved before scene.panoRotation / blend modes existed.
    const raw = JSON.parse(serializeProject(project)) as Record<string, unknown>;
    const scene = { ...(raw.scene as Record<string, unknown>) };
    delete scene.panoRotation;
    raw.scene = scene;
    const settings = { ...(raw.settings as Record<string, unknown>) };
    // Legacy projectedStyle with only the original four knobs (no blend/secondary).
    settings.projectedStyle = {
      opacity: 0.8,
      exposure: 1.1,
      lightingContribution: 0.2,
      fallbackMode: 'neutral',
    };
    raw.settings = settings;

    const parsed = parseProject(JSON.stringify(raw));
    expect(parsed.scene.panoRotation).toEqual([0, 0, 0]);
    expect(Array.isArray(parsed.scene.panoOrigin)).toBe(true);
    expect(parsed.scene.panoOrigin).toHaveLength(3);
    expect(parsed.settings.projectedStyle.blendMode).toBe('primary_only');
    expect(parsed.settings.projectedStyle.secondaryPanoId).toBeUndefined();
    expect(parsed.settings.projectedStyle.panoId).toBeUndefined();
    expect(parsed.settings.projectedStyle.opacity).toBe(0.8);
    expect(parsed.settings.projectedStyle.fallbackMode).toBe('neutral');

    // Origin rotate path must be able to read Euler components without throwing.
    const [rx, ry, rz] = parsed.scene.panoRotation;
    expect([rx, ry, rz].every(Number.isFinite)).toBe(true);
  });

  it('drops legacy object-level projection stamps during parse', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'global_reference.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Canonical',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);
    project.scene.objects[0] = {
      ...project.scene.objects[0],
      projectionStamp: {
        id: 'stamp_floor',
        panoId: pano.id,
        panoYawDegrees: 0,
        yawDegrees: 12,
        pitchDegrees: -4,
        viewFovDegrees: 42,
        panoFovDegrees: 58,
        opacity: 0.8,
        aspectRatio: 16 / 9,
        createdAt: '2026-06-28T00:00:00.000Z',
      },
    } as typeof project.scene.objects[0];

    const parsed = parseProject(serializeProject(project));
    expect(parsed.scene.objects[0]).not.toHaveProperty('projectionStamp');
  });

  it('emits warnings until graybox and canonical panos exist', () => {
    const project = createDefaultProject();
    const warnings = getProjectWarnings(project).map((warning) => warning.id);
    expect(warnings).toContain('missing-graybox-pano');
    expect(warnings).toContain('missing-canonical-pano');
    expect(formatWarningSummary(getProjectWarnings(project))).toBe('Needs attention');
  });

  it('builds shot prompts with selected prompt-critical landmarks', () => {
    const project = createDefaultProject();
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 0],
        target: [0, 1.6, 5],
        fovDegrees: 55,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    shot.landmarkIds = [project.landmarks[0].id];
    const prompt = generateImagePrompt(project, shot);
    expect(prompt).toContain('Use viewport_clay.png as the strict camera, composition, perspective, scale, and layout reference.');
    expect(prompt).not.toContain('continuity_control_view.png');
    expect(prompt).not.toContain('projected style placement');
    expect(prompt).toContain(project.landmarks[0].displayName);
    expect(prompt).toContain('Do not move, redesign, remove, or replace');
  });

  it('creates a package manifest for expected shot export artifacts', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'global_graybox.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Graybox',
      assetId: asset.id,
      type: 'graybox_render',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);
    const shot = createShot({
      index: 1,
      linkedPanoId: pano.id,
      camera: {
        position: project.scene.panoOrigin,
        target: [0, 1.6, 5],
        fovDegrees: 55,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    project.shots.push(shot);

    const manifest = createShotPackageManifest(project, shot);
    const paths = manifest.files.map((file) => file.path);
    const root = manifest.rootFolder;
    expect(paths).toContain(`${root}/inputs/viewport_clay.png`);
    expect(paths).not.toContain(`${root}/inputs/continuity_control_view.png`);
    expect(paths).not.toContain(`${root}/outputs/skinned_reference_frame.png`);
    expect(paths).toContain(`${root}/inputs/global_graybox.png`);
    expect(paths).toContain(`${root}/prompts/image_gen_prompt.txt`);
  });

  it('includes pano crop in the manifest only when crop settings exist', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'global_reference.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Canonical',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);
    const shot = createShot({
      index: 1,
      linkedPanoId: pano.id,
      camera: {
        position: [0, 1.6, -2],
        target: [0, 1.6, 5],
        fovDegrees: 55,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    project.shots.push(shot);

    const root = createShotPackageManifest(project, shot).rootFolder;
    expect(createShotPackageManifest(project, shot).files.map((file) => file.path))
      .not.toContain(`${root}/inputs/pano_crop.png`);

    shot.panoCrop = {
      panoId: pano.id,
      yawDegrees: 0,
      pitchDegrees: 0,
      rollDegrees: 0,
      fovDegrees: 55,
      aspectRatio: 16 / 9,
      width: 1920,
      height: 1080,
    };
    expect(createShotPackageManifest(project, shot).files.map((file) => file.path))
      .toContain(`${root}/inputs/pano_crop.png`);
  });

  it('adds an imported AI result frame to the package manifest only after one exists', () => {
    const project = createDefaultProject();
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 0],
        target: [0, 1.6, 5],
        fovDegrees: 55,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    project.shots.push(shot);
    const root = createShotPackageManifest(project, shot).rootFolder;
    expect(createShotPackageManifest(project, shot).files.map((file) => file.path))
      .not.toContain(`${root}/outputs/ai_result_frame.png`);

    shot.assets.aiResultFrameAssetId = 'asset_ai_result';
    expect(createShotPackageManifest(project, shot).files.map((file) => file.path))
      .toContain(`${root}/outputs/ai_result_frame.png`);
  });

  it('keeps priority export output paths in capped preview lists', () => {
    const paths = [
      'shot_001/inputs/viewport_clay.png',
      'shot_001/inputs/global_reference.png',
      'shot_001/inputs/global_graybox.png',
      'shot_001/outputs/ai_result_frame.png',
      'shot_001/metadata/shot.json',
    ];

    expect(selectExportPathPreview(paths, 3)).toEqual([
      'shot_001/inputs/viewport_clay.png',
      'shot_001/inputs/global_reference.png',
      'shot_001/outputs/ai_result_frame.png',
    ]);
    expect(selectExportPathPreview(paths, 2)).toEqual([
      'shot_001/inputs/viewport_clay.png',
      'shot_001/outputs/ai_result_frame.png',
    ]);
  });

  it('adds exported camera move video and keyframe metadata to the package manifest', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [1, 1.8, -3],
      },
      durationSeconds: 3,
    });
    shot.assets.cameraMoveVideoAssetId = 'asset_camera_move';

    const manifest = createShotPackageManifest(project, shot);
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toContain('shot_001/inputs/viewport_clay_motion.mp4');
    expect(paths).toContain('shot_001/inputs/camera_move/clay_start.png');
    expect(paths).toContain('shot_001/inputs/camera_move/clay_mid.png');
    expect(paths).toContain('shot_001/inputs/camera_move/clay_end.png');
    expect(paths).toContain('shot_001/metadata/camera_keyframes.json');
    expect(paths).toContain('shot_001/metadata/camera_move_reference_frames.json');
  });

  it('lists camera move MP4 in the manifest from keyframes even without a pre-exported asset', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    shot.assets.cameraMoveVideoAssetId = undefined;
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [2, 1.7, -2],
      },
      durationSeconds: 2,
    });

    const manifest = createShotPackageManifest(project, shot);
    expect(manifest.files.map((file) => file.path)).toContain('shot_001/inputs/viewport_clay_motion.mp4');
  });

  it('adds cubemap references to the manifest when a camera move has a linked pano', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'global_reference.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Canonical',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);
    const shot = project.shots[0];
    shot.linkedPanoId = pano.id;
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [1, 1.8, -3],
      },
      durationSeconds: 3,
    });

    const paths = createShotPackageManifest(project, shot).files.map((file) => file.path);
    expect(paths).toContain('shot_001/inputs/cubemap/px.png');
    expect(paths).toContain('shot_001/inputs/cubemap/nx.png');
    expect(paths).toContain('shot_001/inputs/cubemap/py.png');
    expect(paths).toContain('shot_001/inputs/cubemap/ny.png');
    expect(paths).toContain('shot_001/inputs/cubemap/pz.png');
    expect(paths).toContain('shot_001/inputs/cubemap/nz.png');
    expect(paths).toContain('shot_001/inputs/cubemap/cubemap_stitched.png');
    expect(paths).toContain('shot_001/inputs/camera_move/clay_start.png');
    expect(paths).not.toContain('shot_001/metadata/camera_move_cubemap_visibility.json');
    expect(paths).not.toContain('shot_001/inputs/camera_move/cubemap_visible/start_stitched.png');
    expect(paths).not.toContain('shot_001/inputs/camera_move/pano_reference_start.png');
  });

  it('includes cubemap with full pano even without camera keyframes', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'global_reference.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Canonical',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);
    const shot = project.shots[0];
    shot.linkedPanoId = pano.id;
    shot.cameraKeyframes = [];
    shot.exportSettings.includeFullPano = true;

    const paths = createShotPackageManifest(project, shot).files.map((file) => file.path);
    expect(paths).toContain('shot_001/inputs/cubemap/pz.png');
    expect(paths).toContain('shot_001/inputs/cubemap/cubemap_stitched.png');
    expect(paths).not.toContain('shot_001/inputs/camera_move/clay_start.png');
  });

  it('never lists cubemap_visible paths in the package manifest', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'global_reference.png',
      uri: 'data:image/png;base64,AAAA',
      width: 2048,
      height: 1024,
    });
    const pano = createPanoReference({
      name: 'Canonical',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: asset.width ?? 2048,
      height: asset.height ?? 1024,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);
    const shot = project.shots[0];
    shot.linkedPanoId = pano.id;
    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [1, 1.8, -3],
      },
      durationSeconds: 3,
    });

    const paths = createShotPackageManifest(project, shot).files.map((file) => file.path);
    expect(paths.every((path) => !path.includes('cubemap_visible'))).toBe(true);
    expect(paths.every((path) => !path.includes('camera_move_cubemap_visibility'))).toBe(true);
  });

  it('fails gracefully when exporting without a selected shot', async () => {
    const project = createDefaultProject();
    await expect(buildShotPackage(project, undefined)).rejects.toThrow(ShotPackageError);
    await expect(buildShotPackage(project, undefined)).rejects.toThrow('Select a shot before exporting a package.');
  });

  it('selects the latest graybox pano asset for direct download controls', () => {
    const project = createDefaultProject();
    const firstAsset = createPanoAsset({
      name: 'global_graybox_old.png',
      uri: 'data:image/png;base64,OLD',
      width: 1024,
      height: 512,
    });
    const secondAsset = createPanoAsset({
      name: 'global_graybox.png',
      uri: 'data:image/png;base64,NEW',
      width: 2048,
      height: 1024,
    });
    const firstPano = createPanoReference({
      name: 'Old Graybox',
      assetId: firstAsset.id,
      type: 'graybox_render',
      origin: project.scene.panoOrigin,
      width: 1024,
      height: 512,
    });
    const secondPano = createPanoReference({
      name: 'Graybox 360',
      assetId: secondAsset.id,
      type: 'graybox_render',
      origin: project.scene.panoOrigin,
      width: 2048,
      height: 1024,
    });
    project.assets.assets[firstAsset.id] = firstAsset;
    project.assets.assets[secondAsset.id] = secondAsset;
    project.panoRefs.push(firstPano, secondPano);

    const latest = getLatestGrayboxPano(project);
    expect(latest?.id).toBe(secondPano.id);
    expect(getPanoAsset(project, latest)?.name).toBe('global_graybox.png');
  });

  it('does not treat missing landmarks or capture-origin distance as export failures', () => {
    const project = createDefaultProject();
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 20],
        target: [0, 1.6, 25],
        fovDegrees: 55,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    shot.exportSettings = {
      ...shot.exportSettings,
      includePanoCrop: false,
      includeFullPano: false,
      includeGrayboxPano: false,
      includeProjectedViewport: false,
      includeProjectedCameraMoveVideo: false,
      includeProjectedCameraMoveReferenceFrames: false,
      includePrompt: true,
    };
    project.shots.push(shot);

    const warnings = getShotWarnings(project, shot);
    expect(warnings.some((warning) => warning.id.endsWith('missing-landmarks'))).toBe(false);
    expect(warnings.some((warning) => warning.id.includes('pano-match') || warning.id.includes('pano-origin'))).toBe(false);
    expect(formatWarningSummary(warnings)).toBe('Ready');
    expect(shouldShowMissingLandmarkPromptNote(project, shot)).toBe(true);

    // Non-critical landmark alone still leaves the prompt note visible.
    const nonCritical = project.landmarks.find((landmark) => !landmark.promptCritical);
    if (nonCritical) {
      shot.landmarkIds = [nonCritical.id];
    } else {
      project.landmarks.push({
        ...project.landmarks[0],
        id: 'landmark-non-critical',
        promptCritical: false,
        displayName: 'Prop',
        name: 'Prop',
      });
      shot.landmarkIds = ['landmark-non-critical'];
    }
    expect(shouldShowMissingLandmarkPromptNote(project, shot)).toBe(true);

    shot.landmarkIds = [project.landmarks.find((landmark) => landmark.promptCritical)!.id];
    expect(shouldShowMissingLandmarkPromptNote(project, shot)).toBe(false);
  });

  it('scopes package readiness to selected shot export settings', () => {
    const project = createDefaultProject();
    const clayOnly = {
      ...project.shots[0],
      id: 'shot-clay-only',
      shotNumber: '010',
      exportSettings: {
        ...project.shots[0].exportSettings,
        includeGrayboxPano: false,
        includeFullPano: false,
        includePanoCrop: false,
        includeProjectedViewport: false,
        includeProjectedCameraMoveVideo: false,
        includeProjectedCameraMoveReferenceFrames: false,
      },
    };
    project.shots = [clayOnly];

    expect(getExportSelectionWarnings(project, [clayOnly])).toEqual([]);
    expect(getProjectWarnings(project).map((warning) => warning.id)).toEqual(
      expect.arrayContaining(['missing-graybox-pano', 'missing-canonical-pano']),
    );

    clayOnly.exportSettings = {
      ...clayOnly.exportSettings,
      includeGrayboxPano: true,
      includeProjectedViewport: true,
    };
    const selection = getExportSelectionWarnings(project, [clayOnly]).map((warning) => warning.id);
    expect(selection).toContain('selection-missing-graybox-pano');
    expect(selection).toContain('selection-missing-projector');
  });

  it('warns when multiple selected shots share a production ID', () => {
    const project = createDefaultProject();
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
      name: 'Courtyard reverse',
    };

    const warnings = getExportSelectionWarnings(project, [first, second]);
    expect(warnings.some((warning) => warning.id === 'duplicate-production-shot-id-42A')).toBe(true);
  });

  it('notes pano origin distance only when panorama crop export is enabled', () => {
    const project = createDefaultProject();
    const asset = createPanoAsset({
      name: 'styled.png',
      uri: 'data:image/png;base64,styled',
      width: 4,
      height: 2,
    });
    const pano = createPanoReference({
      name: 'Styled',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 4,
      height: 2,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs.push(pano);

    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 12],
        target: [0, 1.6, 17],
        fovDegrees: 55,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    shot.linkedPanoId = pano.id;
    shot.exportSettings = {
      ...shot.exportSettings,
      includePanoCrop: true,
      includeFullPano: false,
      includeGrayboxPano: false,
      includeProjectedViewport: false,
      includeProjectedCameraMoveVideo: false,
      includeProjectedCameraMoveReferenceFrames: false,
    };
    project.shots.push(shot);

    const warnings = getShotWarnings(project, shot);
    const distanceNote = warnings.find((warning) => warning.id.endsWith('pano-origin-distance'));
    expect(distanceNote?.severity).toBe('info');
    expect(distanceNote?.message).toContain('Reference origin distance');
    expect(formatWarningSummary(warnings)).toBe('Ready with notes');
  });

  it('resets session fly and busy flags when opening a project', () => {
    const incoming = createDefaultProject();
    incoming.name = 'Imported Audit Project';
    useContinuityStore.setState({
      shotCameraFlying: true,
      isRenderingGraybox: true,
      isExportingPackage: true,
      buildMode: 'place',
      activePrimitive: 'wall',
      gridSnap: false,
      panoView: { yawDegrees: 90, pitchDegrees: 12, fovDegrees: 40 },
    });

    useContinuityStore.getState().setProject(incoming);
    const state = useContinuityStore.getState();

    expect(state.project.name).toBe('Imported Audit Project');
    expect(state.shotCameraFlying).toBe(false);
    expect(state.isRenderingGraybox).toBe(false);
    expect(state.isExportingPackage).toBe(false);
    expect(state.buildMode).toBe('select');
    expect(state.activePrimitive).toBe('box');
    expect(state.gridSnap).toBe(true);
    expect(state.selectedShotId).toBe(incoming.shots[0]?.id);
  });

  it('confirms before leaving Export while a package export is running', () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    useContinuityStore.setState({
      workspace: 'export',
      isExportingPackage: true,
    });

    useContinuityStore.getState().setWorkspace('build');
    expect(confirmMock).toHaveBeenCalledWith('An export is currently running. Cancel it and leave?');
    expect(useContinuityStore.getState().workspace).toBe('export');
    expect(useContinuityStore.getState().isExportingPackage).toBe(true);

    confirmMock.mockReturnValue(true);
    useContinuityStore.getState().setWorkspace('shots');
    expect(useContinuityStore.getState().workspace).toBe('shots');
    expect(useContinuityStore.getState().isExportingPackage).toBe(false);
    vi.unstubAllGlobals();
  });

  it('removes an uploaded pano reference, frees its asset, and re-links shots', () => {
    const project = createDefaultProject();
    const grayboxAsset = createPanoAsset({
      name: 'global_graybox.png',
      uri: 'data:image/png;base64,gray',
      width: 4096,
      height: 2048,
    });
    const uploadedAsset = createPanoAsset({
      name: 'styled.png',
      uri: 'data:image/png;base64,styled',
      width: 4096,
      height: 2048,
    });
    const graybox = createPanoReference({
      name: 'Graybox 360',
      assetId: grayboxAsset.id,
      type: 'graybox_render',
      origin: project.scene.panoOrigin,
      width: 4096,
      height: 2048,
      isCanonical: false,
    });
    const uploaded = createPanoReference({
      name: 'Styled Upload',
      assetId: uploadedAsset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 4096,
      height: 2048,
      isCanonical: true,
      sourcePanoId: graybox.id,
    });
    project.assets.assets[grayboxAsset.id] = grayboxAsset;
    project.assets.assets[uploadedAsset.id] = uploadedAsset;
    project.panoRefs = [graybox, uploaded];
    project.workflow.referenceAlignmentAcceptedForPanoId = uploaded.id;
    project.shots[0] = {
      ...project.shots[0],
      linkedPanoId: uploaded.id,
    };

    useContinuityStore.setState({
      project,
      activePanoId: uploaded.id,
      seenAlignmentIntroForPanoId: uploaded.id,
    });

    useContinuityStore.getState().removePanoReference(uploaded.id);
    const state = useContinuityStore.getState();

    expect(state.project.panoRefs.map((pano) => pano.id)).toEqual([graybox.id]);
    expect(state.project.panoRefs[0]?.isCanonical).toBe(true);
    expect(state.project.assets.assets[uploadedAsset.id]).toBeUndefined();
    expect(state.project.assets.assets[grayboxAsset.id]).toBeTruthy();
    expect(state.project.workflow.referenceAlignmentAcceptedForPanoId).toBeUndefined();
    expect(state.activePanoId).toBe(graybox.id);
    expect(state.project.shots[0]?.linkedPanoId).toBe(graybox.id);
    expect(state.seenAlignmentIntroForPanoId).toBeUndefined();
  });

  it('imports a second styled pano as blend partner when capture origin moved', () => {
    const project = createDefaultProject();
    const firstAsset = createPanoAsset({
      name: 'first.png',
      uri: 'data:image/png;base64,FIRST',
      width: 4096,
      height: 2048,
    });
    const first = createPanoReference({
      name: 'First',
      assetId: firstAsset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 4096,
      height: 2048,
      isCanonical: true,
    });
    project.assets.assets[firstAsset.id] = firstAsset;
    project.panoRefs = [first];
    project.scene.panoOrigin = [0, 1.6, 0];
    project.workflow.referenceAlignmentAcceptedForPanoId = first.id;
    project.shots[0] = { ...project.shots[0], linkedPanoId: first.id };
    project.settings.projectedStyle = {
      ...project.settings.projectedStyle,
      panoId: first.id,
      blendMode: 'primary_only',
    };

    useContinuityStore.setState({ project, activePanoId: first.id });

    // Same origin → replace
    const replaceMode = useContinuityStore.getState().importStyledPano({
      name: 'replacement.png',
      dataUrl: 'data:image/png;base64,REPL',
      width: 4096,
      height: 2048,
    });
    expect(replaceMode).toBe('replace');
    let state = useContinuityStore.getState();
    const replacement = state.project.panoRefs.find((pano) => pano.isCanonical && pano.type === 'ai_global_reference');
    expect(replacement?.name).toBe('replacement');
    expect(state.project.workflow.referenceAlignmentAcceptedForPanoId).toBeUndefined();
    expect(state.project.shots[0]?.linkedPanoId).toBe(replacement?.id);

    // Re-seed a stable primary, then move origin and add secondary
    const primaryAsset = createPanoAsset({
      name: 'primary.png',
      uri: 'data:image/png;base64,PRIM',
      width: 4096,
      height: 2048,
    });
    const primary = createPanoReference({
      name: 'Primary',
      assetId: primaryAsset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 4096,
      height: 2048,
      isCanonical: true,
    });
    state.project.assets.assets[primaryAsset.id] = primaryAsset;
    state.project.panoRefs = [primary];
    state.project.scene.panoOrigin = [6, 1.6, 0];
    state.project.workflow.referenceAlignmentAcceptedForPanoId = primary.id;
    state.project.shots[0] = { ...state.project.shots[0], linkedPanoId: primary.id };
    state.project.settings.projectedStyle = {
      ...state.project.settings.projectedStyle,
      panoId: primary.id,
      blendMode: 'primary_only',
      secondaryPanoId: undefined,
    };
    useContinuityStore.setState({
      project: state.project,
      activePanoId: primary.id,
    });

    expect(resolveStyledImportMode(useContinuityStore.getState().project)).toBe('add_secondary');
    const addMode = useContinuityStore.getState().importStyledPano({
      name: 'second.png',
      dataUrl: 'data:image/png;base64,SEC',
      width: 4096,
      height: 2048,
    });
    expect(addMode).toBe('add_secondary');
    state = useContinuityStore.getState();
    expect(state.project.panoRefs.find((pano) => pano.id === primary.id)?.isCanonical).toBe(true);
    expect(state.project.workflow.referenceAlignmentAcceptedForPanoId).toBe(primary.id);
    expect(state.project.shots[0]?.linkedPanoId).toBe(primary.id);
    expect(state.project.settings.projectedStyle.secondaryPanoId).toBeTruthy();
    expect(state.project.settings.projectedStyle.blendMode).toBe('primary_dominant');
    expect(state.project.settings.projectedStyle.panoId).toBe(primary.id);
    expect(state.activePanoId).toBe(primary.id);
  });

  it('adds a secondary styled pano from a frozen pending plan even if capture origin was undone', () => {
    const project = createDefaultProject();
    const primaryAsset = createPanoAsset({
      name: 'primary.png',
      uri: 'data:image/png;base64,PRIM',
      width: 4096,
      height: 2048,
    });
    const primary = createPanoReference({
      name: 'Primary',
      assetId: primaryAsset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 4096,
      height: 2048,
      isCanonical: true,
    });
    project.assets.assets[primaryAsset.id] = primaryAsset;
    project.panoRefs = [primary];
    project.scene.panoOrigin = [0, 1.6, 0];
    project.scene.panoRotation = [0, 0.1, 0];
    project.workflow.referenceAlignmentAcceptedForPanoId = primary.id;
    project.shots[0] = { ...project.shots[0], linkedPanoId: primary.id };
    project.settings.projectedStyle = {
      ...project.settings.projectedStyle,
      panoId: primary.id,
      blendMode: 'primary_only',
      secondaryPanoId: undefined,
    };

    const frozenOrigin: [number, number, number] = [4.5, 1.6, 2.25];
    const frozenRotation: [number, number, number] = [0, 0.35, 0];
    useContinuityStore.setState({
      project,
      activePanoId: primary.id,
      pendingSecondCapturePlan: {
        primaryPanoId: primary.id,
        origin: frozenOrigin,
        rotation: frozenRotation,
        createdAt: new Date().toISOString(),
      },
    });

    expect(resolveStyledImportMode(useContinuityStore.getState().project, {
      pendingSecondCapturePlan: useContinuityStore.getState().pendingSecondCapturePlan,
    })).toBe('add_secondary');

    const addMode = useContinuityStore.getState().importStyledPano({
      name: 'second.png',
      dataUrl: 'data:image/png;base64,SEC',
      width: 4096,
      height: 2048,
    });
    expect(addMode).toBe('add_secondary');
    const state = useContinuityStore.getState();
    expect(state.project.panoRefs.find((pano) => pano.id === primary.id)?.isCanonical).toBe(true);
    expect(state.project.settings.projectedStyle.secondaryPanoId).toBeTruthy();
    expect(state.pendingSecondCapturePlan).toBeUndefined();
    expect(state.activePanoId).toBe(primary.id);
    const secondary = state.project.panoRefs.find(
      (pano) => pano.id === state.project.settings.projectedStyle.secondaryPanoId,
    );
    expect(secondary?.origin).toEqual(frozenOrigin);
    expect(secondary?.rotation).toEqual(frozenRotation);
    // Live Build origin was never moved to B — secondary still stamped from the plan.
    expect(state.project.scene.panoOrigin).toEqual([0, 1.6, 0]);
  });

  it('clears projectedStyle ids when removing a pano reference', () => {
    const project = createDefaultProject();
    const aAsset = createPanoAsset({
      name: 'a.png',
      uri: 'data:image/png;base64,AAAA',
      width: 4,
      height: 2,
    });
    const bAsset = createPanoAsset({
      name: 'b.png',
      uri: 'data:image/png;base64,BBBB',
      width: 4,
      height: 2,
    });
    const a = createPanoReference({
      name: 'A',
      assetId: aAsset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 4,
      height: 2,
      isCanonical: true,
    });
    const b = createPanoReference({
      name: 'B',
      assetId: bAsset.id,
      type: 'ai_global_reference',
      origin: [5, 1.6, 0],
      width: 4,
      height: 2,
    });
    project.assets.assets[aAsset.id] = aAsset;
    project.assets.assets[bAsset.id] = bAsset;
    project.panoRefs = [a, b];
    project.settings.projectedStyle = {
      ...project.settings.projectedStyle,
      panoId: a.id,
      secondaryPanoId: b.id,
      blendMode: 'primary_dominant',
    };
    useContinuityStore.setState({ project, activePanoId: a.id });
    useContinuityStore.getState().removePanoReference(b.id);
    const state = useContinuityStore.getState();
    expect(state.project.settings.projectedStyle.secondaryPanoId).toBeUndefined();
    expect(state.project.settings.projectedStyle.panoId).toBe(a.id);
  });

  it('replaces a shot viewport preview without retaining its superseded asset', () => {
    const project = createDefaultProject();
    useContinuityStore.setState({
      project,
      selectedShotId: project.shots[0]?.id,
    });

    const first = useContinuityStore.getState().attachViewportRenderToShot(project.shots[0].id, {
      name: 'first_viewport.png',
      dataUrl: 'data:image/png;base64,first',
      width: 1920,
      height: 1080,
    });
    const second = useContinuityStore.getState().attachViewportRenderToShot(project.shots[0].id, {
      name: 'second_viewport.png',
      dataUrl: 'data:image/png;base64,second',
      width: 1920,
      height: 1080,
    });
    const state = useContinuityStore.getState();

    expect(state.project.shots[0].assets.viewportRenderAssetId).toBe(second.id);
    expect(state.project.assets.assets[first.id]).toBeUndefined();
    expect(state.project.assets.assets[second.id]).toBeTruthy();
  });

  it('reclaims superseded and detached shot media assets', () => {
    const project = createDefaultProject();
    useContinuityStore.setState({
      project,
      selectedShotId: project.shots[0]?.id,
    });
    const shotId = project.shots[0].id;
    const firstVideo = useContinuityStore.getState().attachCameraMoveVideoToShot(shotId, {
      name: 'first.mp4', dataUrl: 'data:video/mp4;base64,FIRST', mimeType: 'video/mp4', width: 1920, height: 1080,
      durationSeconds: 2, frameRate: 24,
    });
    const secondVideo = useContinuityStore.getState().attachCameraMoveVideoToShot(shotId, {
      name: 'second.mp4', dataUrl: 'data:video/mp4;base64,SECOND', mimeType: 'video/mp4', width: 1920, height: 1080,
      durationSeconds: 2, frameRate: 24,
    });
    const firstAiResult = useContinuityStore.getState().attachAiResultFrameToShot(shotId, {
      name: 'first.png', dataUrl: 'data:image/png;base64,FIRST',
    });
    const secondAiResult = useContinuityStore.getState().attachAiResultFrameToShot(shotId, {
      name: 'second.png', dataUrl: 'data:image/png;base64,SECOND',
    });
    let state = useContinuityStore.getState();
    expect(state.project.assets.assets[firstVideo.id]).toBeUndefined();
    expect(state.project.assets.assets[firstAiResult.id]).toBeUndefined();
    expect(state.project.assets.assets[secondVideo.id]).toBeTruthy();
    expect(state.project.assets.assets[secondAiResult.id]).toBeTruthy();

    state.updateShot(shotId, {
      assets: { ...state.project.shots[0].assets, cameraMoveVideoAssetId: undefined },
    });
    expect(useContinuityStore.getState().project.assets.assets[secondVideo.id]).toBeUndefined();

    const detachedShot = useContinuityStore.getState().addCamera({ navigateToShots: false });
    const detachedAsset = useContinuityStore.getState().attachAiResultFrameToShot(detachedShot.id, {
      name: 'detached.png', dataUrl: 'data:image/png;base64,DETACHED',
    });
    useContinuityStore.getState().removeShot(detachedShot.id);
    expect(useContinuityStore.getState().project.assets.assets[detachedAsset.id]).toBeUndefined();
  });
});
