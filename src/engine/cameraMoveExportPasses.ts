import type { PeopleRenderVariant } from './peopleExport';
import { peopleVariantLabel } from './peopleExport';
import type { SceneRenderPass } from './depthRender';

export interface CameraMoveExportPass {
  appearance: SceneRenderPass;
  peopleVariant: PeopleRenderVariant;
}

export interface CompletedCameraMoveExportPass<T> {
  pass: CameraMoveExportPass;
  index: number;
  value: T;
}

export interface FailedCameraMoveExportPass {
  pass: CameraMoveExportPass;
  index: number;
  error: unknown;
}

export interface CameraMoveExportPassResults<T> {
  completed: CompletedCameraMoveExportPass<T>[];
  failures: FailedCameraMoveExportPass[];
  cancelled: boolean;
}

/** Build the download order used by the shot camera-move exporter. */
export function createCameraMoveExportPasses(
  peopleVariants: readonly PeopleRenderVariant[],
  includeProjected: boolean,
  includeDepth = false,
): CameraMoveExportPass[] {
  return peopleVariants.flatMap((peopleVariant) => [
    { appearance: 'clay' as const, peopleVariant },
    ...(includeProjected ? [{ appearance: 'projected' as const, peopleVariant }] : []),
    ...(includeDepth ? [{ appearance: 'depth' as const, peopleVariant }] : []),
  ]);
}

/**
 * Render video outputs one at a time. A companion failure must not discard
 * outputs that already completed or prevent the remaining requested passes.
 */
export async function runCameraMoveExportPasses<T>(
  passes: readonly CameraMoveExportPass[],
  runPass: (pass: CameraMoveExportPass, index: number) => Promise<T>,
  isCancelled: () => boolean,
): Promise<CameraMoveExportPassResults<T>> {
  const completed: CompletedCameraMoveExportPass<T>[] = [];
  const failures: FailedCameraMoveExportPass[] = [];

  for (let index = 0; index < passes.length; index += 1) {
    if (isCancelled()) return { completed, failures, cancelled: true };
    const pass = passes[index];
    try {
      const value = await runPass(pass, index);
      if (isCancelled()) return { completed, failures, cancelled: true };
      completed.push({ pass, index, value });
    } catch (error) {
      if (isCancelled()) return { completed, failures, cancelled: true };
      failures.push({ pass, index, error });
    }
  }

  return { completed, failures, cancelled: false };
}

export function cameraMoveExportPassLabel(pass: CameraMoveExportPass): string {
  const appearance = pass.appearance === 'projected'
    ? 'Projected'
    : pass.appearance === 'depth'
      ? 'Depth'
      : 'Clay';
  return `${appearance} ${peopleVariantLabel(pass.peopleVariant)}`;
}

export function getCameraMoveExportCompletionMessage(
  completedCount: number,
  totalCount: number,
  failures: readonly Pick<FailedCameraMoveExportPass, 'pass'>[],
): string {
  const summary = `Completed ${completedCount} of ${totalCount} outputs.`;
  if (failures.length === 0) return summary;
  return `${summary} ${failures.map(({ pass }) => `${cameraMoveExportPassLabel(pass)} failed.`).join(' ')}`;
}
