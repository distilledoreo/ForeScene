import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARACTER_PASS_BACKGROUND,
  defaultCharacterPassExportSettings,
  normalizeCharacterPassExportSettings,
  normalizeHexBackgroundColor,
} from '../src/domain/defaults';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { createShotPackageManifest } from '../src/engine/exportManifest';
import {
  characterSequenceFrameFileName,
  characterStillPath,
  shotHasVisibleCharactersForPass,
} from '../src/engine/characterPassExport';
import {
  isObjectVisibleForContentMode,
  resolveProjectForAnimatedCameraMove,
  resolveProjectForShot,
} from '../src/engine/shotSceneState';

describe('characters-only content mode', () => {
  function buildScene() {
    const project = createDefaultProject();
    const character = createSceneObject('human_dummy', 1);
    const attached = createSceneObject('box', 1);
    attached.stagingRole = 'prop';
    attached.metadata = { characterOwnerId: character.id };
    const unattached = createSceneObject('box', 2);
    unattached.stagingRole = 'prop';
    const floor = createSceneObject('floor', 1);
    const wall = createSceneObject('wall', 1);
    project.scene.objects.push(character, attached, unattached, floor, wall);
    return { project, character, attached, unattached, floor, wall };
  }

  it('keeps all ordinarily visible objects in full scene', () => {
    const { project, character, attached, unattached, floor } = buildScene();
    const resolved = resolveProjectForShot(project, project.shots[0], { contentMode: 'full_scene' });
    const byId = new Map(resolved.scene.objects.map((object) => [object.id, object]));
    expect(byId.get(character.id)?.visible).toBe(true);
    expect(byId.get(attached.id)?.visible).toBe(true);
    expect(byId.get(unattached.id)?.visible).toBe(true);
    expect(byId.get(floor.id)?.visible).toBe(true);
  });

  it('hides characters on clean plate and keeps props', () => {
    const { project, character, attached, unattached } = buildScene();
    const resolved = resolveProjectForShot(project, project.shots[0], { contentMode: 'clean_plate' });
    const byId = new Map(resolved.scene.objects.map((object) => [object.id, object]));
    expect(byId.get(character.id)?.visible).toBe(false);
    expect(byId.get(attached.id)?.visible).toBe(true);
    expect(byId.get(unattached.id)?.visible).toBe(true);
  });

  it('hides set and ordinary props in characters-only mode', () => {
    const { project, character, attached, unattached, floor, wall } = buildScene();
    const resolved = resolveProjectForShot(project, project.shots[0], {
      contentMode: 'characters_only',
    });
    const byId = new Map(resolved.scene.objects.map((object) => [object.id, object]));
    expect(byId.get(character.id)?.visible).toBe(true);
    expect(byId.get(attached.id)?.visible).toBe(true);
    expect(byId.get(unattached.id)?.visible).toBe(false);
    expect(byId.get(floor.id)?.visible).toBe(false);
    expect(byId.get(wall.id)?.visible).toBe(false);
  });

  it('keeps already-hidden characters hidden', () => {
    const { project, character } = buildScene();
    const shot = project.shots[0];
    shot.objectOverrides = { [character.id]: { visible: false } };
    const resolved = resolveProjectForShot(project, shot, { contentMode: 'characters_only' });
    expect(resolved.scene.objects.find((object) => object.id === character.id)?.visible).toBe(false);
  });

  it('includes character-linked props and excludes unattached props', () => {
    const { project, attached, unattached } = buildScene();
    expect(isObjectVisibleForContentMode(attached, true, {
      contentMode: 'characters_only',
      includeCharacterAttachments: true,
    })).toBe(true);
    expect(isObjectVisibleForContentMode(unattached, true, {
      contentMode: 'characters_only',
      includeCharacterAttachments: true,
    })).toBe(false);
    expect(isObjectVisibleForContentMode(attached, true, {
      contentMode: 'characters_only',
      includeCharacterAttachments: false,
    })).toBe(false);
    expect(shotHasVisibleCharactersForPass(project, project.shots[0])).toBe(true);
  });

  it('prevents keyframes from turning set objects back on during characters-only', () => {
    const { project, character, floor } = buildScene();
    const shot = project.shots[0];
    shot.cameraKeyframes = [
      {
        id: 'kf1',
        label: 'Start',
        timeSeconds: 0,
        camera: shot.camera,
        easing: 'linear',
        objectOverrides: {
          [character.id]: { visible: true },
          [floor.id]: { visible: false },
        },
      },
      {
        id: 'kf2',
        label: 'End',
        timeSeconds: 2,
        camera: {
          ...shot.camera,
          position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
        },
        easing: 'linear',
        objectOverrides: {
          [character.id]: { visible: true },
          [floor.id]: { visible: true },
        },
      },
    ];
    const resolved = resolveProjectForAnimatedCameraMove(project, shot, {
      contentMode: 'characters_only',
    });
    const byId = new Map(resolved.scene.objects.map((object) => [object.id, object]));
    expect(byId.get(character.id)?.visible).toBe(true);
    expect(byId.get(floor.id)?.visible).toBe(false);
    expect(isObjectVisibleForContentMode(floor, true, { contentMode: 'characters_only' })).toBe(false);
  });

  it('prevents keyframes from turning characters back on during clean-plate', () => {
    const { project, character } = buildScene();
    const shot = project.shots[0];
    shot.cameraKeyframes = [
      {
        id: 'kf1',
        label: 'Start',
        timeSeconds: 0,
        camera: shot.camera,
        easing: 'linear',
        objectOverrides: { [character.id]: { visible: false } },
      },
      {
        id: 'kf2',
        label: 'End',
        timeSeconds: 2,
        camera: {
          ...shot.camera,
          position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
        },
        easing: 'linear',
        objectOverrides: { [character.id]: { visible: true } },
      },
    ];
    const resolved = resolveProjectForAnimatedCameraMove(project, shot, {
      contentMode: 'clean_plate',
    });
    expect(resolved.scene.objects.find((object) => object.id === character.id)?.visible).toBe(false);
    expect(isObjectVisibleForContentMode(character, true, { contentMode: 'clean_plate' })).toBe(false);
  });
});

describe('character pass settings normalization', () => {
  it('defaults old projects to character pass disabled', () => {
    const normalized = normalizeCharacterPassExportSettings(undefined);
    expect(normalized.enabled).toBe(false);
    expect(normalized).toMatchObject({
      includeStill: true,
      includeMotion: true,
      motionFormat: 'green_mp4',
      backgroundColor: DEFAULT_CHARACTER_PASS_BACKGROUND,
      includeAttachedProps: true,
    });
    expect(defaultCharacterPassExportSettings.enabled).toBe(false);
  });

  it('falls back safely for invalid colors and unknown formats', () => {
    expect(normalizeHexBackgroundColor('green')).toBe(DEFAULT_CHARACTER_PASS_BACKGROUND);
    expect(normalizeHexBackgroundColor('#0f0')).toBe(DEFAULT_CHARACTER_PASS_BACKGROUND);
    expect(normalizeHexBackgroundColor('#00ff00')).toBe('#00FF00');
    expect(normalizeCharacterPassExportSettings({
      enabled: true,
      motionFormat: 'webm' as never,
      backgroundColor: 'not-a-color',
    })).toMatchObject({
      enabled: true,
      motionFormat: 'green_mp4',
      backgroundColor: DEFAULT_CHARACTER_PASS_BACKGROUND,
    });
  });

  it('uses deterministic zero-padded frame numbering', () => {
    expect(characterSequenceFrameFileName(1)).toBe('frame_000001.png');
    expect(characterSequenceFrameFileName(121)).toBe('frame_000121.png');
  });

  it('lists character still paths in the package manifest when enabled', () => {
    const project = createDefaultProject();
    const character = createSceneObject('human_dummy', 1);
    project.scene.objects.push(character);
    const shot = project.shots[0];
    shot.exportSettings.characterPass = {
      ...defaultCharacterPassExportSettings,
      enabled: true,
      includeMotion: false,
    };
    shot.exportSettings.includeProjectedViewport = false;
    const paths = createShotPackageManifest(project, shot).files.map((file) => file.path);
    expect(paths).toContain(characterStillPath(paths[0]!.split('/')[0]!, 'clay'));
    expect(paths.some((path) => path.endsWith('/inputs/characters/viewport_clay_characters.png'))).toBe(true);
    expect(paths.some((path) => path.endsWith('/metadata/character_pass.json'))).toBe(true);
  });
});
