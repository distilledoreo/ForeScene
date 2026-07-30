/**
 * Playwright browser session for the ForeScene Agent CLI.
 * Persistent profile keeps the same local project across CLI invocations.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const AGENT_PROFILE_DIR = path.resolve(REPO_ROOT, '.forescene-agent/browser-profile');

export interface AgentBrowserOptions {
  url?: string;
  headless?: boolean;
  writeAccess?: boolean;
  viewport?: { width: number; height: number };
}

export interface AgentBrowserSession {
  context: BrowserContext;
  page: Page;
  url: string;
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
    return Boolean(status?.ready && status.projectLoaded);
  }, { timeout: timeoutMs });
}

export async function openAgentBrowser(
  options: AgentBrowserOptions = {},
): Promise<AgentBrowserSession> {
  const url = await resolveForeSceneUrl(options.url);
  const headless = options.headless ?? false;
  const viewport = options.viewport ?? { width: 1600, height: 1000 };

  await mkdir(AGENT_PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(AGENT_PROFILE_DIR, {
    headless,
    viewport,
  });

  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('forescene-splash-seen', '1');
    } catch {
      // ignore
    }
  });

  if (options.writeAccess) {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('forescene-agent-control', 'read-write');
      } catch {
        // ignore
      }
    });
  }

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(page);
  await waitForAgentReady(page);

  return {
    context,
    page,
    url,
    close: async () => {
      await context.close();
    },
  };
}
