/**
 * Playwright browser session for the ForeScene Agent CLI.
 * Persistent profile keeps the same local project across CLI invocations.
 */

import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import {
  isChromiumProfileLockError,
  recoverChromiumProfileLocks,
  terminateChromiumProfileOwner,
  type BrowserProfileRecovery,
} from './browserProfile';
import { defaultAgentProfilePath, isDefaultAgentProfilePath, resolveAgentProfilePath } from './agentProfile';
import { resolveForeSceneRepoRoot } from './repoRoot';
import { resolveAgentBrowserProxy } from './browserProxy';

export const REPO_ROOT = resolveForeSceneRepoRoot();
export const AGENT_PROFILE_DIR = defaultAgentProfilePath(REPO_ROOT);
export const BROWSER_LAUNCH_TIMEOUT_MS = 45_000;

export interface AgentBrowserOptions {
  url?: string;
  headless?: boolean;
  /** Session-only write seed (`sessionStorage`). Requires explicit CLI `--write`. */
  writeAccess?: boolean;
  /** Persist write seed in profile localStorage (`--persist-write`). */
  persistWrite?: boolean;
  /** Optional dedicated persistent profile directory (absolute or repo-relative). */
  profileDir?: string;
  viewport?: { width: number; height: number };
}

export interface AgentBrowserSession {
  context: BrowserContext;
  page: Page;
  url: string;
  profileDir: string;
  profileRecovery: BrowserProfileRecovery;
  close: () => Promise<void>;
}

export class BrowserLaunchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Chromium did not establish an agent browser context within ${timeoutMs}ms.`);
    this.name = 'BrowserLaunchTimeoutError';
  }
}

export async function withBrowserLaunchDeadline<T>(
  launch: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeoutError = new BrowserLaunchTimeoutError(timeoutMs);
  const launchPromise = launch();
  const guardedLaunch = launchPromise.then((value) => {
    if (timedOut) throw timeoutError;
    return value;
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      void onTimeout()
        .catch(() => undefined)
        .finally(() => reject(timeoutError));
    }, timeoutMs);
  });
  try {
    return await Promise.race([guardedLaunch, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    // A timed-out Playwright promise may reject after its browser is terminated.
    void launchPromise.catch(() => undefined);
  }
}

function isRecoverableBrowserLaunchError(error: unknown): boolean {
  if (error instanceof BrowserLaunchTimeoutError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /browser.*(closed|crash)|target.*closed|process.*(exited|closed)|connection.*closed/i.test(message);
}

export async function resolveForeSceneUrl(explicit?: string): Promise<string> {
  const configured = explicit
    ?? process.env.FORESCENE_URL
    ?? process.env.CONTINUITY_STAGE_URL;
  if (configured) return configured;

  const ports = Array.from({ length: 11 }, (_, index) => 3000 + index);
  for (const port of ports) {
    const candidate = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const html = await response.text();
      if (html.includes('ForeScene') || html.includes('root')) return candidate;
    } catch {
      // Try next port.
    }
  }

  throw new Error(
    'No ForeScene dev server found on ports 3000-3010. '
    + 'Start one with `npm run dev`, or set FORESCENE_URL.',
  );
}

async function dismissOnboarding(page: Page): Promise<void> {
  const modeChooser = page.locator('[data-mode-chooser]');
  const studio = page.getByRole('button', { name: /Open ForeScene/i });
  if (await modeChooser.isVisible().catch(() => false)) {
    await studio.click();
  } else {
    try {
      await modeChooser.waitFor({ state: 'visible', timeout: 3000 });
      await studio.click();
    } catch {
      // Already in studio from a previous persistent session.
    }
  }

  const splash = page.getByRole('dialog', { name: 'ForeScene splash' });
  if (await splash.isVisible().catch(() => false)) {
    await splash.click({ force: true });
  }
}

export async function waitForAgentReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(() => {
    const status = window.foreScene?.getStatus();
    return Boolean(
      status?.ready
      && status.projectLoaded
      && status.persistence?.ready,
    );
  }, undefined, { timeout: timeoutMs });
}

/** Ready + persistence / graybox / package export idle. */
export async function waitForAgentIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  await waitForAgentReady(page, timeoutMs);
  await page.evaluate(async (timeout) => {
    await window.foreScene!.waitForIdle({ timeoutMs: timeout });
  }, timeoutMs);
}

export async function openAgentBrowser(
  options: AgentBrowserOptions = {},
): Promise<AgentBrowserSession> {
  const url = await resolveForeSceneUrl(options.url);
  const headless = options.headless ?? false;
  const proxy = resolveAgentBrowserProxy(url);
  const viewport = options.viewport ?? { width: 1600, height: 1000 };
  const persistWrite = options.persistWrite === true;
  const writeAccess = options.writeAccess === true || persistWrite;
  const profileDir = resolveAgentProfilePath(options.profileDir, REPO_ROOT);
  if (!profileDir) {
    throw new Error(
      'Stateful Agent CLI operations require an explicit --profile. '
      + `The default ${AGENT_PROFILE_DIR} path is refused.`,
    );
  }
  if (isDefaultAgentProfilePath(profileDir, REPO_ROOT)) {
    throw new Error(`Refusing default Agent CLI profile: ${profileDir}`);
  }

  await mkdir(profileDir, { recursive: true });
  let profileRecovery = await recoverChromiumProfileLocks(profileDir);
  if (profileRecovery.blocked) {
    throw new Error(profileRecovery.message);
  }
  if (profileRecovery.recovered) {
    process.stderr.write(`[agent] ${profileRecovery.message}\n`);
  }

  const launch = () => withBrowserLaunchDeadline(
    () => chromium.launchPersistentContext(profileDir, {
      headless,
      viewport,
      ...(proxy ? { proxy } : {}),
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
    }),
    BROWSER_LAUNCH_TIMEOUT_MS,
    async () => {
      const cleanup = await terminateChromiumProfileOwner(profileDir);
      process.stderr.write(
        `[agent] chromium-launch-timeout profile=${profileDir} owner=${cleanup.ownerPid ?? 'unknown'} terminated=${cleanup.terminated ? '1' : '0'}\n`,
      );
    },
  );

  let context: BrowserContext;
  try {
    context = await launch();
  } catch (error) {
    if (!isChromiumProfileLockError(error) && !isRecoverableBrowserLaunchError(error)) throw error;
    const cleanup = await terminateChromiumProfileOwner(profileDir);
    profileRecovery = cleanup.recovery;
    if (profileRecovery.blocked) throw new Error(profileRecovery.message);
    process.stderr.write(
      `[agent] chromium-launch-retry profile=${profileDir} reason=${error instanceof Error ? error.name : 'unknown'} owner=${cleanup.ownerPid ?? 'unknown'}\n`,
    );
    context = await launch();
  }

  process.stderr.write(
    `[agent] chromium-launch profile=${profileDir} recovered=${profileRecovery.recovered ? '1' : '0'}\n`,
  );

  let page: Page;
  try {
    await context.addInitScript(
      ({ splash, write, persist }) => {
        try {
          window.localStorage.setItem('forescene-splash-seen', splash);
        } catch {
          // ignore
        }
        try {
          // Always clear stale persisted write unless this launch opts into --persist-write.
          if (persist) {
            window.localStorage.setItem('forescene-agent-control', 'read-write');
          } else {
            window.localStorage.removeItem('forescene-agent-control');
          }
        } catch {
          // ignore
        }
        try {
          if (write && !persist) {
            window.sessionStorage.setItem('forescene-agent-control-session', 'read-write');
          } else {
            window.sessionStorage.removeItem('forescene-agent-control-session');
          }
        } catch {
          // ignore
        }
      },
      {
        splash: '1',
        write: writeAccess,
        persist: persistWrite,
      },
    );

    page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissOnboarding(page);
    await waitForAgentIdle(page);
  } catch (error) {
    // Initialization owns this context until a session is returned. If navigation
    // or readiness fails, callers cannot close a session they never received.
    await context.close().catch(() => undefined);
    throw error;
  }

  return {
    context,
    page,
    url,
    profileDir,
    profileRecovery,
    close: async () => {
      await context.close();
    },
  };
}
