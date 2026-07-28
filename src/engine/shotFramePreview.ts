/**
 * Gate for the automatic still-preview effect in Shots.
 * Staging must not start a full-scene renderShotFrame; thumbnails belong after
 * capture, an intentional camera land, or an explicit refresh.
 */
export function shouldStartAutomaticShotFrameRender(options: {
  shotCameraFlying: boolean;
  stagingMode: boolean;
  framePreviewKey: string;
  activeFrameRenderKey: string | undefined;
}): boolean {
  if (options.shotCameraFlying || options.stagingMode || !options.framePreviewKey) {
    return false;
  }
  if (options.activeFrameRenderKey === options.framePreviewKey) {
    return false;
  }
  return true;
}
