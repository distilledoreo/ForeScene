import { LocationProject, PanoReference, Shot } from '../domain/types';
import { getShotPackageBaseName } from './exportNaming';
import { getCameraMoveReferenceFrames, hasRenderableCameraMove } from './cameraKeyframes';
import { CAMERA_MOVE_CUBEMAP_FACES } from './cameraMoveCubemap';
import { shouldExportViewportDepth } from './depthRender';
import { canUseProjectedAppearance } from './projectedStyle';
import { generateImagePrompt, generateVideoPrompt } from './prompts';
import { getPeopleRenderVariants, getPeopleVariantPath } from './peopleExport';

export interface ShotPackageManifest {
  rootFolder: string;
  files: Array<{
    path: string;
    kind: 'image' | 'video' | 'json' | 'text';
    required: boolean;
  }>;
}

export const PRIORITY_EXPORT_PATH_MARKERS = ['/outputs/ai_result_frame.png'] as const;

export function selectExportPathPreview(paths: readonly string[], limit: number): string[] {
  if (paths.length <= limit) return [...paths];

  const isPriority = (path: string) => PRIORITY_EXPORT_PATH_MARKERS.some((marker) => path.includes(marker));
  const selected = new Set<string>();

  for (const path of paths) {
    if (isPriority(path)) selected.add(path);
  }
  for (const path of paths) {
    if (selected.size >= limit) break;
    if (!selected.has(path)) selected.add(path);
  }

  return paths.filter((path) => selected.has(path));
}

export function createShotPackageManifest(
  project: LocationProject,
  shot: Shot,
  rootFolder = getShotPackageBaseName(shot),
): ShotPackageManifest {
  const canonical = project.panoRefs.find((pano) => pano.isCanonical);
  const graybox = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  const aiResultAssetId = shot.assets.aiResultFrameAssetId ?? shot.assets.finalBaseFrameAssetId;
  const cameraMoveReferenceFrames = shot.exportSettings.includeCameraMoveReferenceFrames
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  const hasCubemapSource = Boolean(
    shot.exportSettings.includeFullPano && (canonical || linkedPano),
  );
  const files: ShotPackageManifest['files'] = [];
  const peopleMode = shot.exportSettings.peopleExportMode;
  const peopleVariants = getPeopleRenderVariants(peopleMode);

  if (shot.exportSettings.includeViewport) {
    for (const variant of peopleVariants) {
      files.push({
        path: getPeopleVariantPath(`${rootFolder}/inputs/viewport_clay.png`, variant, peopleMode),
        kind: 'image',
        required: true,
      });
    }
  }
  if (shouldExportViewportDepth(shot.exportSettings.depth)) {
    for (const variant of peopleVariants) {
      files.push({
        path: getPeopleVariantPath(`${rootFolder}/inputs/viewport_depth.png`, variant, peopleMode),
        kind: 'image',
        required: true,
      });
    }
  }
  // Only list projected files when packaging will actually write them.
  if (shot.exportSettings.includeProjectedViewport && canUseProjectedAppearance(project)) {
    for (const variant of peopleVariants) {
      files.push({
        path: getPeopleVariantPath(`${rootFolder}/inputs/viewport_projected.png`, variant, peopleMode),
        kind: 'image',
        required: false,
      });
    }
  }
  if (shot.exportSettings.includePanoCrop && linkedPano && shot.panoCrop) {
    files.push({ path: `${rootFolder}/inputs/pano_crop.png`, kind: 'image', required: true });
  }
  if (shot.exportSettings.includeFullPano && canonical) {
    files.push({ path: `${rootFolder}/inputs/global_reference.png`, kind: 'image', required: true });
  }
  if (hasCubemapSource) {
    for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
      files.push({ path: `${rootFolder}/inputs/cubemap/${face}.png`, kind: 'image', required: false });
    }
    files.push({ path: `${rootFolder}/inputs/cubemap/cubemap_stitched.png`, kind: 'image', required: false });
  }
  if (shot.exportSettings.includeGrayboxPano && graybox) {
    files.push({ path: `${rootFolder}/inputs/global_graybox.png`, kind: 'image', required: false });
  }
  if (shot.exportSettings.includeAiResultFrame && aiResultAssetId) {
    files.push({ path: `${rootFolder}/outputs/ai_result_frame.png`, kind: 'image', required: false });
  }
  // List the motion MP4 whenever packaging will include it: attached asset or keyframes.
  if (
    shot.exportSettings.includeCameraMoveVideo
    && (shot.assets.cameraMoveVideoAssetId || hasRenderableCameraMove(shot.cameraKeyframes))
  ) {
    for (const variant of peopleVariants) {
      if (variant === 'clean_plate' && !hasRenderableCameraMove(shot.cameraKeyframes)) continue;
      files.push({
        path: getPeopleVariantPath(`${rootFolder}/inputs/viewport_clay_motion.mp4`, variant, peopleMode),
        kind: 'video',
        required: false,
      });
    }
  }
  if (
    shot.exportSettings.includeProjectedCameraMoveVideo
    && canUseProjectedAppearance(project)
    && hasRenderableCameraMove(shot.cameraKeyframes)
  ) {
    for (const variant of peopleVariants) {
      files.push({
        path: getPeopleVariantPath(`${rootFolder}/inputs/viewport_projected_motion.mp4`, variant, peopleMode),
        kind: 'video',
        required: false,
      });
    }
  }
  for (const frame of cameraMoveReferenceFrames) {
    for (const variant of peopleVariants) {
      files.push({
        path: getPeopleVariantPath(`${rootFolder}/inputs/camera_move/clay_${frame.id}.png`, variant, peopleMode),
        kind: 'image',
        required: false,
      });
    }
  }
  const projectedMoveFrames = (
    shot.exportSettings.includeProjectedCameraMoveReferenceFrames
    && canUseProjectedAppearance(project)
  )
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  for (const frame of projectedMoveFrames) {
    for (const variant of peopleVariants) {
      files.push({
        path: getPeopleVariantPath(`${rootFolder}/inputs/camera_move/projected_${frame.id}.png`, variant, peopleMode),
        kind: 'image',
        required: false,
      });
    }
  }
  if (shot.exportSettings.includeMetadata) {
    files.push({ path: `${rootFolder}/metadata/shot.json`, kind: 'json', required: true });
    files.push({ path: `${rootFolder}/metadata/camera.json`, kind: 'json', required: true });
    if (shot.cameraKeyframes.length > 0) {
      files.push({ path: `${rootFolder}/metadata/camera_keyframes.json`, kind: 'json', required: false });
    }
    if (cameraMoveReferenceFrames.length > 0) {
      files.push({ path: `${rootFolder}/metadata/camera_move_reference_frames.json`, kind: 'json', required: false });
    }
    if (shouldExportViewportDepth(shot.exportSettings.depth)) {
      files.push({ path: `${rootFolder}/metadata/depth.json`, kind: 'json', required: false });
    }
    files.push({ path: `${rootFolder}/metadata/landmarks.json`, kind: 'json', required: true });
    files.push({ path: `${rootFolder}/metadata/location.json`, kind: 'json', required: true });
  }
  if (shot.exportSettings.includePrompt) {
    files.push({ path: `${rootFolder}/prompts/image_gen_prompt.txt`, kind: 'text', required: true });
    files.push({ path: `${rootFolder}/prompts/video_gen_prompt.txt`, kind: 'text', required: true });
    files.push({ path: `${rootFolder}/prompts/negative_prompt.txt`, kind: 'text', required: false });
  }

  return { rootFolder, files };
}

export function buildShotMetadata(project: LocationProject, shot: Shot, linkedPano?: PanoReference) {
  return {
    project: {
      id: project.id,
      name: project.name,
      schemaVersion: project.schemaVersion,
      units: project.units,
    },
    shot,
    linkedPano,
    landmarks: project.landmarks.filter((landmark) => shot.landmarkIds.includes(landmark.id)),
    prompts: {
      image: generateImagePrompt(project, shot),
      video: generateVideoPrompt(shot),
      negative: shot.promptOverrides.negativePrompt || '',
    },
  };
}
