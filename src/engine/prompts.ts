import { Landmark, LocationProject, Shot } from '../domain/types';
import { shotExpectsNoPanorama } from './previs/shotEnvironment';

const DEFAULT_GRAYBOX_CREATIVE_BRIEF = 'Describe the look you want: style, time of day, materials, and mood.';

const GRAYBOX_REFERENCE_FORMAT_INSTRUCTION = 'The output must be a 16:9 image containing a centered 2:1 equirectangular panorama band. The usable panorama is the central horizontal band only. The top and bottom padding exist only because the image generator cannot output 2:1 directly. Keep the actual scene content inside the central 2:1 panorama area so it can be cropped back into a true equirectangular 360 panorama afterward.';

export function generateGrayboxReferencePrompt(creativeBrief: string): string {
  const brief = creativeBrief.trim() || DEFAULT_GRAYBOX_CREATIVE_BRIEF;

  return [
    'Transform the provided graybox 360 equirectangular panorama into a finished final render.',
    '',
    'Important format instruction:',
    GRAYBOX_REFERENCE_FORMAT_INSTRUCTION,
    '',
    'Creative brief:',
    brief,
    '',
    'Geometry lock:',
    'Use the graybox panorama as the authoritative source for camera position, horizon line, perspective, scale, navigation space, foreground/midground/background relationships, and all major scene landmarks. Preserve the placement and silhouette of the main masses so the final render aligns with the graybox panorama after the center 2:1 band is cropped out.',
    '',
    'Allowed changes:',
    'Add materials, lighting, atmosphere, texture, surface detail, props, vegetation, weathering, set dressing, small secondary objects, color grading, and stylistic polish that fit the creative brief.',
    '',
    'Forbidden changes:',
    'Do not move, rotate, resize, delete, or redesign the major structures. Do not change the camera angle, horizon, scene geography, pathway layout, room/courtyard shape, gate/opening positions, wall positions, column positions, terrain profile, or 360 panorama orientation. Do not introduce large new architecture or objects that conflict with the graybox silhouette.',
    '',
    'Padding behavior:',
    'Do not treat the top and bottom padding as part of the scene composition. Do not place important subject matter, landmarks, horizon detail, text, faces, buildings, or key visual information in the padding. The final usable image will be cropped from the center 2:1 panorama band.',
    '',
    '360 requirements:',
    'Maintain seamless equirectangular continuity inside the central panorama band. The left and right edges of the panorama must connect naturally. Avoid duplicated landmarks, broken perspective, pole artifacts, bent verticals, mismatched seams, inconsistent scale, or visible discontinuities.',
    '',
    'Rendering goal:',
    'Make the central panorama band look like a fully realized final scene built on top of the graybox layout, not a new image loosely inspired by it.',
  ].join('\n');
}

export function getShotLandmarks(project: LocationProject, shot: Shot): Landmark[] {
  return project.landmarks.filter((landmark) => shot.landmarkIds.includes(landmark.id));
}

export function generateImagePrompt(project: LocationProject, shot: Shot): string {
  const landmarkNames = getShotLandmarks(project, shot)
    .filter((landmark) => landmark.promptCritical)
    .map((landmark) => landmark.displayName || landmark.name);

  const landmarkText = landmarkNames.length > 0
    ? landmarkNames.join(', ')
    : 'No prompt-critical landmarks selected.';

  const canonicalPano = project.panoRefs.find((pano) => pano.isCanonical);
  const grayboxPano = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  const omitPanoramaReferences = shotExpectsNoPanorama(project, shot);
  const hasGlobalReference = Boolean(!omitPanoramaReferences && shot.exportSettings.includeFullPano && canonicalPano);
  const hasGrayboxPano = Boolean(!omitPanoramaReferences && shot.exportSettings.includeGrayboxPano && grayboxPano);
  const hasPanoCrop = Boolean(!omitPanoramaReferences && shot.exportSettings.includePanoCrop && linkedPano && shot.panoCrop);
  const hasCameraMoveReferenceFrames = Boolean(
    shot.exportSettings.includeCameraMoveReferenceFrames
    && shot.cameraKeyframes.length >= 2,
  );
  const hasDepthStill = Boolean(
    shot.exportSettings.depth?.enabled
    && shot.exportSettings.depth.includeViewportStill !== false,
  );
  const hasDepthReferenceFrames = Boolean(
    shot.exportSettings.depth?.enabled
    && shot.exportSettings.depth.includeReferenceFrames !== false
    && shot.cameraKeyframes.length >= 2,
  );

  const referenceInstructions = [
    'Use viewport_clay.png as the strict camera, composition, perspective, scale, and layout reference.',
  ];
  if (hasDepthStill) {
    referenceInstructions.push(
      'Use the depth image only for spatial depth, occlusion, camera movement and relative subject placement.',
    );
    referenceInstructions.push(
      'Do not copy its grayscale appearance into the generated result.',
    );
  }
  if (hasDepthReferenceFrames) {
    referenceInstructions.push(
      'Use inputs/camera_move/depth_*.png as depth composition checkpoints along the camera move.',
    );
  }
  if (hasGlobalReference) {
    referenceInstructions.push('Use global_reference.png, when available, as the visual identity, lighting, material, and palette reference.');
    referenceInstructions.push('Use inputs/cubemap/ (face PNGs and cubemap_stitched.png), when available, as the undistorted environment / material reference.');
  }
  if (hasGrayboxPano) {
    referenceInstructions.push('Use global_graybox.png, when available, as the full-location spatial reference.');
  }
  if (hasPanoCrop) {
    referenceInstructions.push('Use pano_crop.png, when available, only as supporting local context.');
  }
  if (hasCameraMoveReferenceFrames) {
    referenceInstructions.push('Use inputs/camera_move/clay_*.png as graybox composition checkpoints along the camera move.');
    referenceInstructions.push('Do not reproduce equirectangular, panoramic, fisheye, 360, or wide-lens distortion from the source panorama. The output lens and perspective must follow viewport_clay.png and viewport_clay_motion.mp4.');
  }

  const continuityLines = hasGlobalReference
    ? [
      'Preserve the same layout, proportions, architecture, lighting direction, material language, and color palette from the global reference.',
      'Do not add new doors, windows, buildings, props, or modern objects unless explicitly requested.',
    ]
    : [
      'Preserve the graybox layout, proportions, architecture, and spatial relationships from viewport_clay.png.',
      'Do not add new doors, windows, buildings, props, or modern objects unless explicitly requested.',
    ];

  return [
    ...referenceInstructions,
    '',
    `Location: ${project.name}`,
    shot.productionShotId?.trim()
      ? `Production shot: ${shot.productionShotId.trim()}`
      : 'Production shot: (not set)',
    `Title: ${shot.name}`,
    `ForeScene order: ${shot.shotNumber}`,
    '',
    `Preserve these landmarks: ${landmarkText}`,
    '',
    ...continuityLines,
    'Do not move, redesign, remove, or replace the named landmarks.',
    '',
    'Render the viewport frame as a polished final base frame suitable for image-to-video generation.',
    '',
    `Shot-specific action/description: ${shot.description || 'Hold the planned composition and environment continuity.'}`,
    shot.promptOverrides.imagePrompt ? `\nAdditional image direction: ${shot.promptOverrides.imagePrompt}` : '',
  ].filter(Boolean).join('\n');
}

export function generateVideoPrompt(shot: Shot, project?: LocationProject): string {
  const hasCameraMove = shot.cameraKeyframes.length >= 2
    && (
      Boolean(shot.assets.cameraMoveVideoAssetId)
      || shot.exportSettings.includeCameraMoveVideo
    );
  const hasDepthMove = Boolean(
    shot.exportSettings.depth?.enabled
    && shot.exportSettings.depth.includeCameraMoveVideo !== false
    && shot.cameraKeyframes.length >= 2,
  );
  const hasCubemap = Boolean(
    shot.exportSettings.includeCubemap
    && (!project || !shotExpectsNoPanorama(project, shot)),
  );
  return [
    'Animate from the provided base frame while preserving the same environment, camera direction, landmarks, materials, lighting, and layout.',
    hasCameraMove
      ? 'Use viewport_clay_motion.mp4 as the camera-motion, parallax, composition, and timing guide.'
      : 'If no camera-motion clip is provided, keep camera motion subtle and composition-safe.',
    hasDepthMove
      ? 'Use the depth video only for spatial depth, occlusion, camera movement and relative subject placement.'
      : '',
    hasDepthMove
      ? 'Do not copy its grayscale appearance into the generated result.'
      : '',
    hasCubemap
      ? 'Use inputs/cubemap/ as the full aligned environment / texture reference. The video is the camera-control reference; the cubemap is not the camera lens.'
      : '',
    hasCubemap || hasCameraMove || hasDepthMove
      ? 'Avoid equirectangular, panoramic, fisheye, 360, or wide-lens distortion. The output lens and perspective must follow the input video or base frame.'
      : '',
    'Keep the background architecture stable.',
    'Do not redesign the set, move landmarks, or introduce new major objects.',
    '',
    `Shot motion: ${shot.promptOverrides.videoPrompt || shot.description || 'Subtle camera-safe motion only.'}`,
  ].filter(Boolean).join('\n');
}
