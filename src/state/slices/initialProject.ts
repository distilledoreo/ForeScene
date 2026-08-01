import { createBlankGrayboxProject } from '../../engine/previs/blankProject';

/**
 * Single default project instance for store composition.
 * Project + selection slices must share the same IDs on first paint.
 *
 * Fresh installs start effectively blank so the first-project launcher can
 * guide new users instead of dropping them into unexplained starter geometry.
 */
export const initialContinuityProject = createBlankGrayboxProject({
  name: 'Untitled Production',
  description: '',
  aspectRatio: '16:9',
});
