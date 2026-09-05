import type { SceneObjectType } from '../domain/types';
import type { SceneVisualTheme } from './sceneObjects';

/**
 * Scene options shared by still and video final exports.
 * Separates production renders from the interactive Build/Shots viewport
 * (fog, grid, helpers, landmarks, shot frustums).
 */
export const FINAL_RENDER_HIDDEN_OBJECT_TYPES: SceneObjectType[] = ['sun_marker'];

export const FINAL_RENDER_NEAR_METERS = 0.05;
export const FINAL_RENDER_NEAR_SAFE_METERS = 0.1;
export const FINAL_RENDER_FAR_SAFETY_MARGIN_METERS = 2;

export interface FinalRenderSceneOptions {
  theme: SceneVisualTheme;
  showHelpers: false;
  showSceneGuides: false;
  showPanoOrigin: false;
  showGrid: false;
  hideShotFrustums: true;
  fog: false;
  hiddenObjectTypes: SceneObjectType[];
  showMissingPlaceholders: false;
}

/** Clay / projected still + video exports share this clean scene profile. */
export function createFinalRenderSceneOptions(
  extras: { hiddenObjectTypes?: SceneObjectType[] } = {},
): FinalRenderSceneOptions {
  const hidden = new Set<SceneObjectType>([
    ...FINAL_RENDER_HIDDEN_OBJECT_TYPES,
    ...(extras.hiddenObjectTypes ?? []),
  ]);
  return {
    // Neutral dark clay keeps no-panorama environment geometry readable while
    // retaining authored asset colors and the explicit absence of a styled pano.
    theme: 'dark',
    showHelpers: false,
    showSceneGuides: false,
    showPanoOrigin: false,
    showGrid: false,
    hideShotFrustums: true,
    fog: false,
    hiddenObjectTypes: [...hidden],
    showMissingPlaceholders: false,
  };
}
