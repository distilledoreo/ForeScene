import { CameraKeyframe, LocationProject, ProjectAsset, Shot } from './types';

export type ShotMediaSource =
  | 'camera_move'
  | 'captured_still'
  | 'ai_result'
  | 'final_frame'
  | 'pano_crop';

export interface ShotMediaItem {
  id: string;
  asset: ProjectAsset;
  kind: 'image' | 'video';
  label: string;
  source: ShotMediaSource;
}

/** One keyed preview still for filmstrip / roll animation (never index-aligned to all keyframes). */
export interface KeyframePreviewFrame {
  keyframeId: string;
  uri: string;
  timeSeconds: number;
}

const shotMediaPriority: Array<{
  key: keyof Shot['assets'];
  source: ShotMediaSource;
  label: string;
  kind: 'image' | 'video';
}> = [
  { key: 'cameraMoveVideoAssetId', source: 'camera_move', label: 'Camera move', kind: 'video' },
  { key: 'viewportRenderAssetId', source: 'captured_still', label: 'Captured still', kind: 'image' },
  { key: 'aiResultFrameAssetId', source: 'ai_result', label: 'AI result', kind: 'image' },
  { key: 'finalBaseFrameAssetId', source: 'final_frame', label: 'Final frame', kind: 'image' },
  { key: 'panoCropAssetId', source: 'pano_crop', label: 'Pano crop', kind: 'image' },
];

function resolveAsset(
  project: LocationProject,
  assetId?: string,
): ProjectAsset | undefined {
  if (!assetId) return undefined;
  return project.assets.assets[assetId];
}

/**
 * Strict camera-roll media list — only assets actually captured or attached to the shot.
 * Linked/canonical panoramas are intentionally excluded.
 */
export function resolveShotMedia(project: LocationProject, shot: Shot): ShotMediaItem[] {
  const items: ShotMediaItem[] = [];

  for (const candidate of shotMediaPriority) {
    const asset = resolveAsset(project, shot.assets[candidate.key]);
    if (!asset) continue;
    const kind = asset.type === 'video' ? 'video' : candidate.kind;
    items.push({
      id: `${shot.id}:${candidate.source}`,
      asset,
      kind,
      label: candidate.label,
      source: candidate.source,
    });
  }

  return items;
}

const posterMediaPriority: ShotMediaSource[] = [
  'captured_still',
  'ai_result',
  'final_frame',
  'pano_crop',
  'camera_move',
];

/** Image-first poster for reel thumbnails; modal playback order stays in resolveShotMedia(). */
export function resolveShotMediaPoster(
  project: LocationProject,
  shot: Shot,
): ShotMediaItem | undefined {
  const items = resolveShotMedia(project, shot);
  for (const source of posterMediaPriority) {
    const item = items.find((candidate) => candidate.source === source);
    if (item) return item;
  }
  return undefined;
}

export function shotHasCameraMoveVideo(project: LocationProject, shot: Shot): boolean {
  return resolveShotMedia(project, shot).some((item) => item.source === 'camera_move');
}

/** True when the shot has a multi-pose camera path (exported video not required). */
export function shotHasCameraKeyframeMove(shot: Pick<Shot, 'cameraKeyframes'>): boolean {
  return (shot.cameraKeyframes?.length ?? 0) >= 2;
}

/**
 * Preview stills for a GIF-like camera-roll animation of keyframes.
 * Sorted by time; only includes frames that have a stored previewUri.
 * Consumers must select/animate by keyframeId — never by parallel index into all keyframes.
 */
export function resolveCameraKeyframePreviewFrames(
  shot: Pick<Shot, 'cameraKeyframes'>,
): KeyframePreviewFrame[] {
  const sorted = [...(shot.cameraKeyframes ?? [])].sort(
    (a, b) => a.timeSeconds - b.timeSeconds,
  );
  const frames: KeyframePreviewFrame[] = [];
  for (const keyframe of sorted) {
    if (!keyframe.previewUri) continue;
    frames.push({
      keyframeId: keyframe.id,
      uri: keyframe.previewUri,
      timeSeconds: keyframe.timeSeconds,
    });
  }
  return frames;
}

/** Stable signature for memo deps without joining full base64 data URLs. */
export function keyframePreviewFramesSignature(
  frames: readonly KeyframePreviewFrame[],
): string {
  if (frames.length === 0) return '';
  let signature = String(frames.length);
  for (const frame of frames) {
    signature += `|${frame.keyframeId}:${frame.timeSeconds}:${frame.uri.length}`;
  }
  return signature;
}

/**
 * @deprecated Prefer resolveCameraKeyframePreviewFrames — URI-only lists drop keyframe identity.
 */
export function resolveCameraKeyframePreviewUris(
  shot: Pick<Shot, 'cameraKeyframes'>,
): string[] {
  return resolveCameraKeyframePreviewFrames(shot).map((frame) => frame.uri);
}

/** Lookup helper for display labels next to a preview frame. */
export function findCameraKeyframeById(
  keyframes: readonly CameraKeyframe[] | undefined,
  keyframeId: string,
): CameraKeyframe | undefined {
  return keyframes?.find((keyframe) => keyframe.id === keyframeId);
}

export function getShotMediaCount(project: LocationProject, shot: Shot): number {
  return resolveShotMedia(project, shot).length;
}

export function hasShotCapture(project: LocationProject, shot: Shot): boolean {
  return getShotMediaCount(project, shot) > 0 || shotHasCameraKeyframeMove(shot);
}
