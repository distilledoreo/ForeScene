/**
 * Run optional background work one item at a time while preserving the
 * best-effort behavior of the caller. This avoids turning one user action
 * into a burst of competing GPU renders.
 */
export async function runSettledSequentially(jobs: readonly (() => Promise<void>)[]): Promise<void> {
  for (const job of jobs) {
    try {
      await job();
    } catch {
      // Companion work is optional; the primary result has already succeeded.
    }
  }
}
