/**
 * Two-boundary persistence golden.
 *
 * 1. Persist → process exit → same explicit profile inspect (no --file)
 * 2. Backup .fsp (outside both profiles) → static zip inspect → empty-profile open
 *
 * Shot A stays linked; shot B stays explicit null across both deaths.
 * Does not import ForeScene source.
 */

import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  assertSuccessfulEnvelope,
  runDocumentedAgentCommand,
} from '../scripts/agent/runDocumentedCli';
import { resolveForeSceneRepoRoot } from '../scripts/agent/repoRoot';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function documentOf(envelope: { result?: unknown }): Record<string, unknown> {
  const result = asRecord(envelope.result);
  const document = asRecord(result.document);
  if (Object.keys(document).length > 0) return document;
  return asRecord(result);
}

function shotsOf(document: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(document.shots)
    ? document.shots.filter((shot): shot is Record<string, unknown> => Boolean(shot) && typeof shot === 'object')
    : [];
}

function objectsOf(document: Record<string, unknown>): Array<Record<string, unknown>> {
  const scene = asRecord(document.scene);
  return Array.isArray(scene.objects)
    ? scene.objects.filter((object): object is Record<string, unknown> => Boolean(object) && typeof object === 'object')
    : [];
}

function assertAuthoredState(
  document: Record<string, unknown>,
  ids: { shotA: string; shotB: string; panoId: string },
) {
  const shots = shotsOf(document);
  const shotA = shots.find((shot) => shot.id === ids.shotA || shot.shotNumber === ids.shotA);
  const shotB = shots.find((shot) => shot.id === ids.shotB || shot.shotNumber === ids.shotB);
  expect(shotA, 'shot A missing').toBeTruthy();
  expect(shotB, 'shot B missing').toBeTruthy();
  expect(shotA!.linkedPanoId).toBe(ids.panoId);
  expect(Object.prototype.hasOwnProperty.call(shotB!, 'linkedPanoId')).toBe(true);
  expect(shotB!.linkedPanoId).toBeNull();
  const imported = objectsOf(document).filter((object) => object.type === 'imported_model');
  expect(imported.length, 'expected an imported_model').toBeGreaterThan(0);
  expect(imported.every((object) => object.type === 'imported_model')).toBe(true);
}

test.describe('Agent CLI persistence golden @heavy @agent-cli', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chromium',
      'Agent CLI drives its own Chromium persistent profile.',
    );
  });

  test('same-profile persist and fresh-profile .fsp keep B null and imported_model binary', async ({ baseURL }) => {
    test.setTimeout(8 * 60_000);
    const url = process.env.FORESCENE_URL ?? baseURL;
    expect(url, 'Playwright webServer or FORESCENE_URL is required').toBeTruthy();
    const repoRoot = resolveForeSceneRepoRoot();
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-persist-golden-'));
    const profileDir = path.join(workDir, 'profile-authoring');
    const freshProfileDir = path.join(workDir, 'profile-fresh');
    const packagesDir = path.join(workDir, 'packages');
    await mkdir(packagesDir, { recursive: true });
    const backupPath = path.join(packagesDir, 'authored.fsp');
    const panoFile = path.join(repoRoot, 'tests/fixtures/cli-parity-pano.png');
    const glbFile = path.join(repoRoot, 'tests/fixtures/ordinary-cube.glb');
    expect((await stat(glbFile)).size).toBeGreaterThan(32);

    const common = { url, cwd: workDir, repoRoot, timeoutMs: 180_000 as const };

    const inspectFresh = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      profile: profileDir,
      ...common,
    }));
    expect(inspectFresh.profile).toBeTruthy();
    expect(String(inspectFresh.profile)).not.toMatch(/[\\/]\.forescene-agent[\\/]browser-profile$/);

    const createPlan = path.join(workDir, 'create-shot-b.json');
    await writeFile(createPlan, `${JSON.stringify({
      version: 1,
      commands: [{
        op: 'shot.create',
        shot: { name: 'Unlinked B', shotNumber: '02' },
      }],
    }, null, 2)}\n`);
    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'apply',
      args: ['--plan', createPlan, '--write'],
      profile: profileDir,
      ...common,
    }));

    const afterCreate = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      profile: profileDir,
      ...common,
    }));
    const createdDoc = documentOf(afterCreate);
    const createdShots = shotsOf(createdDoc);
    expect(createdShots.length).toBeGreaterThanOrEqual(2);
    const shotA = createdShots[0]!;
    const shotB = createdShots.find((shot) => shot !== shotA && (shot.shotNumber === '02' || shot.name === 'Unlinked B'))
      ?? createdShots[1]!;
    const shotAId = String(shotA.id);
    const shotBId = String(shotB.id);

    const importedPano = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'import-panorama',
      args: ['--file', panoFile, '--write', '--name', 'golden-pano'],
      profile: profileDir,
      ...common,
    }));
    const panoPayload = asRecord(importedPano.result);
    const panoId = importedPano.affectedObjectIds?.[0] ?? (typeof panoPayload.panoId === 'string' ? panoPayload.panoId : undefined);
    expect(panoId, 'import-panorama must return a panorama id').toBeTruthy();

    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'import-model',
      args: ['--file', glbFile, '--write'],
      profile: profileDir,
      ...common,
      timeoutMs: 240_000,
    }));

    const linkPlan = path.join(workDir, 'link-and-null.json');
    await writeFile(linkPlan, `${JSON.stringify({
      version: 1,
      commands: [
        { op: 'shot.setPanorama', shot: { id: shotAId }, pano: { id: panoId } },
        { op: 'shot.setPanorama', shot: { id: shotBId }, pano: null },
      ],
    }, null, 2)}\n`);
    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'apply',
      args: ['--plan', linkPlan, '--write'],
      profile: profileDir,
      ...common,
    }));

    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'save',
      args: ['--output', backupPath, '--write'],
      profile: profileDir,
      ...common,
    }));
    expect((await stat(backupPath)).size).toBeGreaterThan(32);
    expect(backupPath.startsWith(profileDir)).toBe(false);
    expect(backupPath.startsWith(freshProfileDir)).toBe(false);

    const sameProfile = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      profile: profileDir,
      ...common,
    }));
    assertAuthoredState(documentOf(sameProfile), { shotA: shotAId, shotB: shotBId, panoId: panoId! });

    const zip = await JSZip.loadAsync(await readFile(backupPath));
    const manifestEntry = zip.file('project.json');
    expect(manifestEntry, 'backup must contain project.json').toBeTruthy();
    const rawProject = JSON.parse(await manifestEntry!.async('text')) as Record<string, unknown>;
    const rawShots = shotsOf(rawProject);
    const rawB = rawShots.find((shot) => shot.id === shotBId);
    expect(rawB).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(rawB!, 'linkedPanoId')).toBe(true);
    expect(rawB!.linkedPanoId).toBeNull();
    const rawA = rawShots.find((shot) => shot.id === shotAId);
    expect(rawA?.linkedPanoId).toBe(panoId);
    const rawObjects = objectsOf(rawProject);
    expect(rawObjects.some((object) => object.type === 'imported_model')).toBe(true);
    const modelEntries = Object.keys(zip.files).filter((name) => name.startsWith('model-assets/') && !zip.files[name]?.dir);
    expect(modelEntries.length).toBeGreaterThan(0);
    const modelBytes = await zip.file(modelEntries[0]!)!.async('uint8array');
    expect(modelBytes.byteLength).toBeGreaterThan(0);

    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'open',
      args: ['--file', backupPath, '--write'],
      profile: freshProfileDir,
      ...common,
    }));
    const freshInspect = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      profile: freshProfileDir,
      ...common,
    }));
    assertAuthoredState(documentOf(freshInspect), { shotA: shotAId, shotB: shotBId, panoId: panoId! });
    expect(freshInspect.profile).not.toBe(sameProfile.profile);
  });
});
