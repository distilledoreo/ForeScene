/**
 * Playwright browser session for the ForeScene Agent CLI.
 * Persistent profile keeps the same local project across CLI invocations.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import {
  isChromiumProfileLockError,
  recoverChromiumProfileLocks,
  type BrowserProfileRecovery,
} from './browserProfile';
import { resolveForeSceneRepoRoot } from './repoRoot';

export const REPO_ROOT = resolveForeSceneRepoRoot();
export const AGENT_PROFILE_DIR = path.resolve(REPO_ROOT, '.forescene-agent/browser-profile');

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
  }, { timeout: timeoutMs });
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
  const viewport = options.viewport ?? { width: 1600, height: 1000 };
  const persistWrite = options.persistWrite === true;
  const writeAccess = options.writeAccess === true || persistWrite;
  const profileDir = options.profileDir
    ? (path.isAbsolute(options.profileDir)
      ? options.profileDir
      : path.resolve(REPO_ROOT, options.profileDir))
    : AGENT_PROFILE_DIR;

  await mkdir(profileDir, { recursive: true });
  let profileRecovery = await recoverChromiumProfileLocks(profileDir);
  if (profileRecovery.blocked) {
    throw new Error(profileRecovery.message);
  }
  if (profileRecovery.recovered) {
    process.stderr.write(`[agent] ${profileRecovery.message}\n`);
  }

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport,
    });
  } catch (error) {
    if (!isChromiumProfileLockError(error)) throw error;
    profileRecovery = await recoverChromiumProfileLocks(profileDir);
    if (profileRecovery.blocked) {
      throw new Error(profileRecovery.message);
    }
    if (profileRecovery.recovered) {
      process.stderr.write(`[agent] ${profileRecovery.message}\n`);
    }
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport,
    });
  }

  process.stderr.write(
    `[agent] chromium-launch profile=${profileDir} recovered=${profileRecovery.recovered ? '1' : '0'}\n`,
  );

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

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(page);
  await waitForAgentIdle(page);

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
