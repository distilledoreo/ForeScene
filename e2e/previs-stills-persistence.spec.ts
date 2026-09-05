import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { runPrevisCli } from '../scripts/agent/previs';
import { openAgentBrowser } from '../scripts/agent/browser';

test('dense stills-only previs preserves all batches after closing its browser', async ({ baseURL, browserName }) => {
  test.skip(browserName !== 'chromium');
  test.setTimeout(180_000);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'previs-stills-persistence-'));
  const profileDir = path.join(dir, 'profile');
  try {
    const manifest = JSON.parse(await readFile('examples/previs/minimal-dialogue.json', 'utf8'));
    manifest.shots = Array.from({ length: 7 }, (_, i) => ({
      ...manifest.shots[0], id: `dense${i}`, shotNumber: String(i + 1),
    }));
    manifest.props = Array.from({ length: 40 }, (_, i) => ({
      id: `hidden${i}`, name: `Hidden prop ${i}`, primitive: 'box',
    }));
    const manifestPath = path.join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await runPrevisCli({ manifestPath, outputDir: dir, profileDir,
      url: baseURL, headless: true, writeAccess: true, persistWrite: false,
      resetProject: true, skipPackage: true, autoRepair: false });
    expect(result.shotsCreated).toBe(7);
    expect(result.framesRendered).toBe(7);
    const state = JSON.parse(await readFile(path.join(dir, 'run-state.json'), 'utf8'));
    const persisted = JSON.parse(await readFile(path.join(dir, 'logs/final-persistence.json'), 'utf8'));
    expect(persisted.revisionId).toBeTruthy();
    const reopened = await openAgentBrowser({ url: baseURL, profileDir, headless: true });
    try {
      const shots = await reopened.page.evaluate(() => window.foreScene!.listShots());
      expect(shots.map(s => s.shotNumber)).toEqual(manifest.shots.map((s: { shotNumber: string }) => s.shotNumber));
      for (const shot of shots) expect(shot.id).toBe(state.shots[shot.shotNumber].shotId);
    } finally { await reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
