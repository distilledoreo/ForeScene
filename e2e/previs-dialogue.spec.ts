/**
 * Live Chromium E2E for autonomous previs (Agent CLI ↔ hosted ForeScene).
 *
 * Proves the integration boundaries static unit tests cannot:
 * blank profile → reset → locations/cast/shots → distinct PNGs →
 * contact sheet → package → resume → --update-manifest upsert/delete.
 *
 * @heavy — long WebGL + package path (main/nightly / explicit run)
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openAgentBrowser, waitForAgentIdle } from '../scripts/agent/browser';
import { runPrevisCli } from '../scripts/agent/previs';
import type { PrevisProductionManifestV1 } from '../src/engine/previs';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function listLiveShots(params: {
  url: string;
  profileDir: string;
}): Promise<Array<{ id: string; shotNumber: string; name: string }>> {
  const session = await openAgentBrowser({
    url: params.url,
    headless: true,
    writeAccess: true,
    persistWrite: false,
    profileDir: params.profileDir,
  });
  try {
    await waitForAgentIdle(session.page);
    return session.page.evaluate(() => window.foreScene!.listShots().map((shot) => ({
      id: shot.id,
      shotNumber: shot.shotNumber,
      name: shot.name,
    })));
  } finally {
    await session.close();
  }
}

test.describe('@heavy autonomous previs dialogue fixture', () => {
  test('four-shot dialogue: reset → frames → package → update-manifest upsert/delete', async ({
    browserName,
    baseURL,
  }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only Agent CLI orchestration');
    test.setTimeout(600_000);

    const outputDir = path.join(os.tmpdir(), `forescene-previs-e2e-${process.pid}-${Date.now()}`);
    const profileDir = path.join(outputDir, 'browser-profile');
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });

    const baseManifestPath = path.resolve('examples/previs/minimal-dialogue.json');
    const url = baseURL ?? 'http://127.0.0.1:4173';

    try {
      const first = await runPrevisCli({
        manifestPath: baseManifestPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: true,
        outputDir,
        profileDir,
      });

      expect(first.ok, first.error ?? 'first previs run failed').toBe(true);
      expect(first.shotsRequested).toBe(4);
      expect(first.shotsCreated).toBe(4);
      expect(first.framesRendered).toBe(4);
      expect(first.failed ?? 0).toBe(0);
      expect(first.package).toBeTruthy();
      expect(first.contactSheet).toBeTruthy();

      const shotNumbers = ['010', '020', '030', '040'];
      const hashes = new Map<string, string>();
      for (const shotNumber of shotNumbers) {
        const framePath = path.join(outputDir, 'shots', `${shotNumber}.png`);
        expect(await pathExists(framePath), `missing frame ${shotNumber}`).toBe(true);
        const info = await stat(framePath);
        expect(info.size, `empty frame ${shotNumber}`).toBeGreaterThan(512);
        hashes.set(shotNumber, await fileSha256(framePath));
      }
      expect(new Set(hashes.values()).size, 'frames must be distinct PNGs').toBe(4);

      expect(await pathExists(path.join(outputDir, 'contact-sheet.html'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'contact-sheet.png'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'validation.json'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'package.zip'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'run-state.json'))).toBe(true);

      const liveAfterFirst = await listLiveShots({ url, profileDir });
      expect(liveAfterFirst.map((shot) => shot.shotNumber).sort()).toEqual(shotNumbers);
      expect(liveAfterFirst).toHaveLength(4);
      const idsAfterFirst = Object.fromEntries(
        liveAfterFirst.map((shot) => [shot.shotNumber, shot.id]),
      );

      // Ordinary resume — unchanged manifest must not duplicate.
      const second = await runPrevisCli({
        manifestPath: baseManifestPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: false,
        outputDir,
        profileDir,
      });
      expect(second.ok, second.error ?? 'resume previs run failed').toBe(true);
      expect(second.framesRendered).toBe(4);
      const liveAfterResume = await listLiveShots({ url, profileDir });
      expect(liveAfterResume).toHaveLength(4);
      expect(Object.fromEntries(liveAfterResume.map((shot) => [shot.shotNumber, shot.id])))
        .toEqual(idsAfterFirst);

      // Correction loop: change shot 030 camera and upsert in place.
      const originalManifest = JSON.parse(
        await readFile(baseManifestPath, 'utf8'),
      ) as PrevisProductionManifestV1;
      const editedManifest = structuredClone(originalManifest);
      const shot030 = editedManifest.shots.find((shot) => shot.shotNumber === '030')!;
      shot030.camera.angle = 'profile';
      shot030.description = 'Revised OTS — profile angle';
      const editedPath = path.join(outputDir, 'manifest-edit-030.json');
      await writeFile(editedPath, `${JSON.stringify(editedManifest, null, 2)}\n`, 'utf8');

      const updated = await runPrevisCli({
        manifestPath: editedPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: false,
        updateManifest: true,
        outputDir,
        profileDir,
      });
      expect(updated.ok, updated.error ?? 'update-manifest run failed').toBe(true);

      const liveAfterUpdate = await listLiveShots({ url, profileDir });
      expect(liveAfterUpdate).toHaveLength(4);
      expect(liveAfterUpdate.map((shot) => shot.shotNumber).sort()).toEqual(shotNumbers);
      const idsAfterUpdate = Object.fromEntries(
        liveAfterUpdate.map((shot) => [shot.shotNumber, shot.id]),
      );
      expect(idsAfterUpdate['010']).toBe(idsAfterFirst['010']);
      expect(idsAfterUpdate['020']).toBe(idsAfterFirst['020']);
      expect(idsAfterUpdate['030']).toBe(idsAfterFirst['030']);
      expect(idsAfterUpdate['040']).toBe(idsAfterFirst['040']);

      expect(await fileSha256(path.join(outputDir, 'shots', '010.png'))).toBe(hashes.get('010'));
      expect(await fileSha256(path.join(outputDir, 'shots', '020.png'))).toBe(hashes.get('020'));
      expect(await fileSha256(path.join(outputDir, 'shots', '040.png'))).toBe(hashes.get('040'));
      expect(await fileSha256(path.join(outputDir, 'shots', '030.png'))).not.toBe(hashes.get('030'));

      // Remove shot 040 and assert only three live shots remain.
      const trimmedManifest = structuredClone(editedManifest);
      trimmedManifest.shots = trimmedManifest.shots.filter((shot) => shot.shotNumber !== '040');
      const trimmedPath = path.join(outputDir, 'manifest-remove-040.json');
      await writeFile(trimmedPath, `${JSON.stringify(trimmedManifest, null, 2)}\n`, 'utf8');

      const removed = await runPrevisCli({
        manifestPath: trimmedPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: false,
        updateManifest: true,
        outputDir,
        profileDir,
      });
      expect(removed.ok, removed.error ?? 'remove-shot update failed').toBe(true);

      const liveAfterRemove = await listLiveShots({ url, profileDir });
      expect(liveAfterRemove).toHaveLength(3);
      expect(liveAfterRemove.map((shot) => shot.shotNumber).sort()).toEqual(['010', '020', '030']);
      expect(liveAfterRemove.find((shot) => shot.shotNumber === '010')?.id).toBe(idsAfterFirst['010']);
      expect(liveAfterRemove.find((shot) => shot.shotNumber === '030')?.id).toBe(idsAfterFirst['030']);

      const runState = JSON.parse(
        await readFile(path.join(outputDir, 'run-state.json'), 'utf8'),
      ) as { shots: Record<string, unknown> };
      expect(runState.shots['040']).toBeUndefined();
      expect(Object.keys(runState.shots).sort()).toEqual(['010', '020', '030']);
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
