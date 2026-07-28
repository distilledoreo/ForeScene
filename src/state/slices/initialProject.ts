import { createDefaultProject } from '../../domain/defaults';

/**
 * Single default project instance for store composition.
 * Project + selection slices must share the same IDs on first paint.
 */
export const initialContinuityProject = createDefaultProject();
