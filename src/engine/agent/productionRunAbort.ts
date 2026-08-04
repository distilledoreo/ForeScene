/** Shared abort signals for production lifecycle ↔ canary coordination. */

const controllers = new Map<string, AbortController>();
const cancelledRunIds = new Set<string>();

export function setProductionRunAbortController(runId: string, controller: AbortController | undefined): void {
  if (controller) controllers.set(runId, controller);
  else controllers.delete(runId);
}

export function markProductionRunCancelled(runId: string): void {
  cancelledRunIds.add(runId);
  controllers.get(runId)?.abort();
}

export function clearProductionRunCancellation(runId: string): void {
  cancelledRunIds.delete(runId);
}

export function isProductionRunAborted(runId: string): boolean {
  return cancelledRunIds.has(runId) || (controllers.get(runId)?.signal.aborted ?? false);
}

export function resetProductionRunAbortControllersForTests(): void {
  controllers.clear();
  cancelledRunIds.clear();
}
