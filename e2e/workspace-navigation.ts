import { expect, type Page } from '@playwright/test';

export type WorkspaceLabel = 'Build' | 'Reference' | 'Shots' | 'Export';

export function workspaceTab(page: Page, label: WorkspaceLabel) {
  // Mobile + desktop both render stage navs; only the visible one is interactive.
  return page
    .locator('header nav button')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
    .locator('visible=true')
    .first();
}

/**
 * Workspace navigation is refused while a local save is in flight
 * ("Please wait for the current local save to finish before navigating away."),
 * so a single tab click can silently no-op and leave the previous workspace
 * mounted. Re-click until the tab reports aria-current="page", then wait for
 * the target workspace's ready marker before proceeding.
 */
export async function goToWorkspace(
  page: Page,
  label: WorkspaceLabel,
  readySelector: string,
) {
  const tab = workspaceTab(page, label);
  await expect(tab).toBeVisible();

  await expect.poll(
    async () => {
      if ((await tab.getAttribute('aria-current')) !== 'page') {
        await tab.click();
      }

      return (await tab.getAttribute('aria-current')) === 'page';
    },
    {
      timeout: 20_000,
      intervals: [250, 500, 1_000],
      message: `Expected navigation to ${label}`,
    },
  ).toBe(true);

  await expect(page.locator(readySelector).first()).toBeVisible({
    timeout: 20_000,
  });
}
