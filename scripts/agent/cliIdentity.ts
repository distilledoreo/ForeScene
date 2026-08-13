/**
 * Per-invocation CLI identity published into the browser session.
 * Source/build fields are included only when the host actually provides them.
 */

import type { Page } from '@playwright/test';

export interface CliInvocationIdentity {
  runId: string;
  command?: string;
  harness: string;
  profile?: string;
  sourceCommit?: string;
  buildId?: string;
}

function readDiscoverableIdentity(): { sourceCommit?: string; buildId?: string } {
  const sourceCommit = process.env.FORESCENE_SOURCE_COMMIT
    || process.env.VITE_GIT_COMMIT
    || process.env.GITHUB_SHA;
  const buildId = process.env.FORESCENE_BUILD_ID || process.env.VITE_BUILD_ID;
  return {
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(buildId ? { buildId } : {}),
  };
}

export function createCliInvocationIdentity(input: {
  command?: string;
  profile?: string;
  harness?: string;
} = {}): CliInvocationIdentity {
  const discovered = readDiscoverableIdentity();
  return {
    runId: `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    harness: input.harness ?? 'forescene-agent-cli',
    ...(input.command ? { command: input.command } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...discovered,
  };
}

export async function publishCliInvocationIdentity(
  page: Page,
  identity: CliInvocationIdentity,
): Promise<CliInvocationIdentity> {
  await page.evaluate((next) => {
    (window as unknown as { __foreSceneCliIdentity?: typeof next }).__foreSceneCliIdentity = next;
    window.foreScene?.beginRunSession?.(next);
  }, identity);
  return identity;
}
