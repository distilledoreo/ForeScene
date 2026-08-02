/**
 * Live Chromium proof that an imported-character manifest cast is resolved
 * before shot compilation, without a separate Agent import command.
 *
 * @heavy — exercises browser file staging, rig analysis, persistence, and
 * clean-frame rendering.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openAgentBrowser, waitForAgentIdle } from '../scripts/agent/browser';
import { runPrevisCli } from '../scripts/agent/previs';
import { preservedRigGlb } from '../tests/fixtures/preservedRigGlb';

test.describe('@heavy autonomous previs imported character', () => {
  test('resolves imported cast and compiles shots in one operation', async ({ browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only Agent CLI orchestration');
    test.setTimeout(600_000);

    const outputDir = path.join(os.tmpdir(), `forescene-imported-previs-e2e-${process.pid}-${Date.now()}`);
    const profileDir = path.join(outputDir, 'browser-profile');
    const sourcePath = path.join(outputDir, 'joseph.glb');
    const manifestPath = path.join(outputDir, 'manifest.json');
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(sourcePath, Buffer.from(preservedRigGlb()));
    await writeFile(manifestPath, `${JSON.stringify({
      version: 1,
      project: { name: 'Imported cast e2e', aspectRatio: '16:9' },
      locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
      cast: [{
        id: 'joseph',
        type: 'imported_character',
        source: './joseph.glb',
        rigMode: 'preserve-existing',
      }],
      shots: [{
        id: 'joseph-medium',
        shotNumber: '010',
        name: 'Joseph medium',
        description: 'Joseph holds a guarded stance.',
        locationId: 'room',
        subjects: ['joseph'],
        camera: { template: 'medium', subjects: ['joseph'] },
      }],
    }, null, 2)}\n`, 'utf8');

    const url = baseURL ?? 'http://127.0.0.1:4173';
    try {
      const result = await runPrevisCli({
        manifestPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: true,
        skipPackage: true,
        outputDir,
        profileDir,
      });

      expect(result.ok, result.error ?? 'imported-character previs run failed').toBe(true);
      expect(result.importedCharacters).toBe(1);

      const resumed = await runPrevisCli({
        manifestPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: false,
        skipPackage: true,
        outputDir,
        profileDir,
      });
      expect(resumed.ok, resumed.error ?? 'imported-character resume failed').toBe(true);
      expect(resumed.importedCharacters).toBe(1);

      const runState = JSON.parse(await readFile(path.join(outputDir, 'run-state.json'), 'utf8')) as {
        entities: Record<string, { objectId?: string }>;
      };
      expect(runState.entities['cast.joseph']?.objectId).toBeTruthy();

      const session = await openAgentBrowser({
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        profileDir,
      });
      try {
        await waitForAgentIdle(session.page);
        const objects = await session.page.evaluate(() => window.foreScene!.listObjects({
          name: 'joseph',
          match: 'exact',
        }));
        expect(objects).toHaveLength(1);
        expect(objects[0]).toMatchObject({
          name: 'joseph',
          isPoseable: true,
        });
        expect(await session.page.evaluate(() => window.foreScene!.listShots())).toHaveLength(1);
      } finally {
        await session.close();
      }

      const castLog = JSON.parse(await readFile(path.join(outputDir, 'logs', 'scene-cast.json'), 'utf8')) as {
        importedCharacters: Array<{ id: string; ok: boolean; objectId?: string }>;
      };
      expect(castLog.importedCharacters).toEqual([
        expect.objectContaining({ id: 'joseph', ok: true, objectId: runState.entities['cast.joseph']?.objectId }),
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
