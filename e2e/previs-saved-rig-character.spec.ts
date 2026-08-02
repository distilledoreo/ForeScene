/**
 * Live Chromium proof that a saved-rig manifest entry stages its source and
 * matching package together, survives resume, and leaves one poseable cast
 * object for shot compilation.
 *
 * @heavy — exercises read-only preflight, package persistence, cleanup-safe
 * import, resumable fingerprints, and clean-frame rendering.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openAgentBrowser } from '../scripts/agent/browser';
import { runPrevisCli } from '../scripts/agent/previs';
import { preservedRigGlb } from '../tests/fixtures/preservedRigGlb';
import { savedRigFsrig } from '../tests/fixtures/savedRigFsrig';

test.describe('@heavy autonomous previs saved-rig character', () => {
  test('imports the matching model/package pair and resumes without duplication', async ({ browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only Agent CLI orchestration');
    test.setTimeout(600_000);

    const outputDir = path.join(os.tmpdir(), `forescene-saved-rig-previs-e2e-${process.pid}-${Date.now()}`);
    const profileDir = path.join(outputDir, 'browser-profile');
    const sourcePath = path.join(outputDir, 'joseph.glb');
    const rigPath = path.join(outputDir, 'joseph.fsrig');
    const manifestPath = path.join(outputDir, 'manifest.json');
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(sourcePath, Buffer.from(preservedRigGlb()));
    await writeFile(rigPath, Buffer.from(await savedRigFsrig()));
    await writeFile(manifestPath, `${JSON.stringify({
      version: 1,
      project: { name: 'Saved-rig cast e2e', aspectRatio: '16:9' },
      locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
      cast: [{
        id: 'joseph',
        type: 'imported_character',
        source: './joseph.glb',
        rigMode: 'saved-rig',
        rigPackage: './joseph.fsrig',
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
      expect(result.ok, result.error ?? 'saved-rig previs run failed').toBe(true);
      expect(result.importedCharacters).toBe(1);

      const preflight = JSON.parse(await readFile(path.join(outputDir, 'logs', 'saved-rig-preflight.json'), 'utf8')) as {
        ok: boolean;
        entries: Array<{ id: string; ok: boolean }>;
      };
      expect(preflight).toMatchObject({ ok: true, entries: [{ id: 'joseph', ok: true }] });

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
      expect(resumed.ok, resumed.error ?? 'saved-rig resume failed').toBe(true);
      expect(resumed.importedCharacters).toBe(1);

      const runState = JSON.parse(await readFile(path.join(outputDir, 'run-state.json'), 'utf8')) as {
        entities: Record<string, {
          objectId?: string;
          importFingerprint?: string;
          appliedSavedRig?: boolean;
          topologyVerified?: boolean;
        }>;
      };
      expect(runState.entities['cast.joseph']).toMatchObject({
        objectId: expect.any(String),
        importFingerprint: expect.stringMatching(/^sha256:/),
        appliedSavedRig: true,
        topologyVerified: true,
      });

      const session = await openAgentBrowser({
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        profileDir,
      });
      try {
        const objects = await session.page.evaluate(() => window.foreScene!.listObjects({
          name: 'joseph',
          match: 'exact',
        }));
        expect(objects).toHaveLength(1);
        expect(objects[0]).toMatchObject({ name: 'joseph', isPoseable: true });
        expect(await session.page.evaluate(() => window.foreScene!.listShots())).toHaveLength(1);
      } finally {
        await session.close();
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
