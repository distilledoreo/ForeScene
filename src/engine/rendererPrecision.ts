import type { WebGLRendererParameters } from 'three';

/**
 * Source sets can contain millimetre-separated surfaces hundreds of metres away.
 * Perspective depth loses that separation with ForeScene's close near plane.
 * Use the same logarithmic depth convention in the editor and final renders;
 * this improves depth testing without moving vertices or offsetting materials.
 * Packed metric-depth output still uses clip-space Z/W, not gl_FragDepth.
 */
export const SCENE_DEPTH_PRECISION: Pick<WebGLRendererParameters, 'logarithmicDepthBuffer'> = {
  logarithmicDepthBuffer: true,
};
