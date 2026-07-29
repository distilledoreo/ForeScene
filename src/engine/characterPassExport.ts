import {
  DEFAULT_CHARACTER_PASS_BACKGROUND,
  normalizeCharacterPassExportSettings,
} from '../domain/defaults';
import type {
  CharacterMotionExportFormat,
  CharacterPassExportSettings,
  LocationProject,
  SceneObject,
  Shot,
} from '../domain/types';
import {
  getCameraMoveDurationSeconds,
  getSortedCameraKeyframes,
  hasRenderableCameraMove,
} from './cameraKeyframes';
import {
  getSceneObjectStagingRole,
  resolveSceneObjectsForShot,
} from './shotSceneState';
import {
  computeCameraMoveFrameCount,
  DEFAULT_VIDEO_FRAME_RATE,
  DEFAULT_VIDEO_HEIGHT,
  DEFAULT_VIDEO_WIDTH,
} from './videoPresets';

export { DEFAULT_CHARACTER_PASS_BACKGROUND };

/** ~300 frames at 1080p — warn before transparent sequence can balloon memory. */
export const CHARACTER_PNG_SEQUENCE_PIXEL_BUDGET = 1920 * 1080 * 300;

export function characterPassIncludesGreenMp4(
  format: CharacterMotionExportFormat,
): boolean {
  return format === 'green_mp4' || format === 'both';
}

export function characterPassIncludesPngSequence(
  format: CharacterMotionExportFormat,
): boolean {
  return format === 'transparent_png_sequence' || format === 'both';
}

/** 1-based frame file name: frame_000001.png */
export function characterSequenceFrameFileName(frameNumber: number): string {
  return `frame_${String(Math.max(1, Math.floor(frameNumber))).padStart(6, '0')}.png`;
}

export function characterSequenceDirPath(
  rootFolder: string,
  appearance: 'clay' | 'projected' = 'clay',
): string {
  return `${rootFolder}/inputs/characters/viewport_${appearance}_characters_sequence`;
}

export function characterStillPath(
  rootFolder: string,
  appearance: 'clay' | 'projected' = 'clay',
): string {
  return `${rootFolder}/inputs/characters/viewport_${appearance}_characters.png`;
}

export function characterMotionMp4Path(
  rootFolder: string,
  appearance: 'clay' | 'projected' = 'clay',
): string {
  return `${rootFolder}/inputs/characters/viewport_${appearance}_characters_motion.mp4`;
}

export function characterPassMetadataPath(rootFolder: string): string {
  return `${rootFolder}/metadata/character_pass.json`;
}

export function shouldWarnCharacterPngSequenceSize(
  width: number,
  height: number,
  frameCount: number,
): boolean {
  return width * height * frameCount > CHARACTER_PNG_SEQUENCE_PIXEL_BUDGET;
}

export interface CharacterPassSequenceMeta {
  format: 'transparent_png_sequence';
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  durationSeconds: number;
  alpha: true;
  firstFrameNumber: 1;
  filePattern: 'frame_%06d.png';
}

export function buildCharacterSequenceMeta(params: {
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  durationSeconds: number;
}): CharacterPassSequenceMeta {
  return {
    format: 'transparent_png_sequence',
    width: params.width,
    height: params.height,
    frameRate: params.frameRate,
    frameCount: params.frameCount,
    durationSeconds: params.durationSeconds,
    alpha: true,
    firstFrameNumber: 1,
    filePattern: 'frame_%06d.png',
  };
}

export interface CharacterPassPackageMeta {
  contentMode: 'characters_only';
  includedCharacterIds: string[];
  includedAttachmentIds: string[];
  excludedObjectCount: number;
  backgroundColor: string;
  motionFormat: CharacterMotionExportFormat;
  alphaSequenceIncluded: boolean;
}

export function listCharacterPassObjects(
  project: Pick<LocationProject, 'scene'>,
  shot: Pick<Shot, 'objectOverrides'>,
  settings: CharacterPassExportSettings,
): {
  characters: SceneObject[];
  attachments: SceneObject[];
  excludedObjectCount: number;
} {
  const resolved = resolveSceneObjectsForShot(project, shot, {
    contentMode: 'characters_only',
    includeCharacterAttachments: settings.includeAttachedProps,
  });
  const characters: SceneObject[] = [];
  const attachments: SceneObject[] = [];
  let excludedObjectCount = 0;
  for (const object of resolved) {
    if (!object.visible) {
      excludedObjectCount += 1;
      continue;
    }
    if (getSceneObjectStagingRole(object) === 'person') {
      characters.push(object);
    } else {
      attachments.push(object);
    }
  }
  return { characters, attachments, excludedObjectCount };
}

export function shotHasVisibleCharactersForPass(
  project: Pick<LocationProject, 'scene'>,
  shot: Pick<Shot, 'objectOverrides'>,
  settings?: Partial<CharacterPassExportSettings> | null,
): boolean {
  const normalized = normalizeCharacterPassExportSettings(settings);
  return listCharacterPassObjects(project, shot, normalized).characters.length > 0;
}

export function buildCharacterPassMetadata(
  project: Pick<LocationProject, 'scene'>,
  shot: Pick<Shot, 'objectOverrides' | 'cameraKeyframes' | 'exportSettings'>,
  settings: CharacterPassExportSettings,
): CharacterPassPackageMeta {
  const listed = listCharacterPassObjects(project, shot, settings);
  return {
    contentMode: 'characters_only',
    includedCharacterIds: listed.characters.map((object) => object.id),
    includedAttachmentIds: listed.attachments.map((object) => object.id),
    excludedObjectCount: listed.excludedObjectCount,
    backgroundColor: settings.backgroundColor,
    motionFormat: settings.motionFormat,
    alphaSequenceIncluded: Boolean(
      settings.includeMotion
      && characterPassIncludesPngSequence(settings.motionFormat)
      && hasRenderableCameraMove(shot.cameraKeyframes),
    ),
  };
}

export function resolveCharacterMotionTiming(
  shot: Pick<Shot, 'cameraKeyframes' | 'exportSettings'>,
  frameRate = DEFAULT_VIDEO_FRAME_RATE,
): {
  frameRate: number;
  durationSeconds: number;
  frameCount: number;
  width: number;
  height: number;
} {
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes);
  const durationSeconds = hasRenderableCameraMove(keyframes)
    ? getCameraMoveDurationSeconds(keyframes)
    : 0;
  const width = shot.exportSettings.width || DEFAULT_VIDEO_WIDTH;
  const height = shot.exportSettings.height || DEFAULT_VIDEO_HEIGHT;
  const fps = Math.max(1, frameRate);
  return {
    frameRate: fps,
    durationSeconds,
    frameCount: durationSeconds > 0
      ? computeCameraMoveFrameCount(durationSeconds, fps)
      : 0,
    width,
    height,
  };
}
