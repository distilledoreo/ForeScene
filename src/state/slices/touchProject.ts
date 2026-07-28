import type { LocationProject } from '../../domain/types';

/** Stamp project.updatedAt — shared by slices that mutate the document. */
export function touchProject<T extends { updatedAt: string }>(project: T): T {
  return { ...project, updatedAt: new Date().toISOString() };
}

export function touchLocationProject(project: LocationProject): LocationProject {
  return touchProject(project);
}
