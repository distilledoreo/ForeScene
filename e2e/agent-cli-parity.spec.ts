/**
 * CLI-only end-to-end parity.
 *
 * Uses documented `npm run agent:*` commands exclusively. This file must not
 * import ForeScene source modules or spawn custom glue scripts.
 */

import { expect, test } from '@playwright/test';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertSuccessfulEnvelope,
  runDocumentedAgentCommand,
} from '../scripts/agent/runDocumentedCli';
import { resolveForeSceneRepoRoot } from '../scripts/agent/repoRoot';

function firstShotSelector(envelope: { result?: unknown }): string {
  const result = envelope.result && typeof envelope.result === 'object'
    ? envelope.result as Record<string, unknown>
    : {};
  const nested = result.result && typeof result.result === 'object'
    ? result.result as Record<string, unknown>
    : {};
  const shots = Array.isArray(result.shots) ? result.shots
    : Array.isArray(nested.shots) ? nested.shots
    : [];
  const first = shots[0] as { shotNumber?: string; id?: string } | undefined;
  if (typeof first?.id === 'string' && first.id.length > 0) return first.id;
  if (typeof first?.shotNumber === 'string' && first.shotNumber.length > 0) return first.shotNumber;
  throw new Error(`inspect did not return a shot id. shots=${JSON.stringify(shots).slice(0, 400)}`);
}

test.describe('Agent CLI documented parity @heavy @agent-cli', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chromium',
      'Agent CLI drives its own Chromium persistent profile.',
    );
  });

  test('open → inspect → projected frame → video → save → reopen → verify', async ({ baseURL }) => {
    test.setTimeout(8 * 60_000);
    const url = process.env.FORESCENE_URL ?? baseURL;
    expect(url, 'Playwright webServer or FORESCENE_URL is required').toBeTruthy();
    const repoRoot = resolveForeSceneRepoRoot();
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-cli-parity-'));
    const profileDir = path.join(workDir, 'profile');
    const packagePath = path.join(workDir, 'project.fsp');
    const savedPath = path.join(workDir, 'project-saved.fsp');
    const framePath = path.join(workDir, '001.projected.png');
    const videoPath = path.join(workDir, '001.mp4');

    const usage = await runDocumentedAgentCommand({
      command: 'open',
      args: ['--write'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
    });
    expect(usage.code, usage.stderr).toBe(2);
    expect(usage.envelope?.ok).toBe(false);
    expect(usage.envelope?.error?.code).toBe('usage_error');

    const inspectFresh = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 120_000,
    }));
    const shot = firstShotSelector(inspectFresh);
    const projectId = inspectFresh.projectId;

    const saved = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'save',
      args: ['--output', packagePath, '--write'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    expect(saved.ok).toBe(true);
    expect((await stat(packagePath)).size).toBeGreaterThan(32);

    const opened = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'open',
      args: ['--file', packagePath, '--write'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    expect(opened.ok).toBe(true);

    const inspectOpened = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 120_000,
    }));
    if (projectId && inspectOpened.projectId) {
      expect(inspectOpened.projectId).toBe(projectId);
    }
    const openedShot = ((inspectOpened.result as { shots?: Array<{
      id?: string;
      cameraPosition?: number[];
      cameraTarget?: number[];
    }> })?.shots ?? []).find((item) => item.id === shot)
      ?? { cameraPosition: [0, 1.6, 0], cameraTarget: [0, 1.6, 10] };

    const panoFile = path.join(repoRoot, 'tests/fixtures/cli-parity-pano.png');
    const importedPano = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'import-panorama',
      args: ['--file', panoFile, '--write', '--name', 'parity-pano'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    const panoPayload = importedPano.result && typeof importedPano.result === 'object'
      ? importedPano.result as { panoId?: string }
      : {};
    const panoId = importedPano.affectedObjectIds?.[0] ?? panoPayload.panoId;
    expect(panoId, 'import-panorama must return a panorama id').toBeTruthy();

    const planPath = path.join(workDir, 'link-pano.json');
    await writeFile(planPath, `${JSON.stringify({
      version: 1,
      commands: [
        { op: 'shot.setPanorama', shot: { id: shot }, pano: { id: panoId } },
        {
          op: 'shot.timeline.replace',
          shot: { id: shot },
          durationSeconds: 2,
          keyframes: [
            {
              timeSeconds: 0,
              camera: {
                position: openedShot.cameraPosition ?? [0, 1.6, 0],
                target: openedShot.cameraTarget ?? [0, 1.6, 10],
              },
            },
            {
              timeSeconds: 2,
              camera: {
                position: [
                  (openedShot.cameraPosition?.[0] ?? 0) + 0.4,
                  openedShot.cameraPosition?.[1] ?? 1.6,
                  openedShot.cameraPosition?.[2] ?? 0,
                ],
                target: openedShot.cameraTarget ?? [0, 1.6, 10],
              },
            },
          ],
        },
      ],
    }, null, 2)}\n`);
    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'apply',
      args: ['--plan', planPath, '--write'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 120_000,
    }));

    const frame = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'frame',
      args: ['--shot', shot, '--mode', 'projected', '--output', framePath],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    expect(frame.operation).toMatch(/render\.frame\.projected/);
    expect((await stat(framePath)).size).toBeGreaterThan(32);

    const video = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'video',
      args: ['--shot', shot, '--mode', 'clay', '--write', '--no-attach', '--output', videoPath],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 240_000,
    }));
    expect(video.operation).toMatch(/render\.video/);
    expect((await stat(videoPath)).size).toBeGreaterThan(32);

    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'save',
      args: ['--output', savedPath, '--write'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    expect((await stat(savedPath)).size).toBeGreaterThan(32);

    const reopenProfile = path.join(workDir, 'profile-reopen');
    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'open',
      args: ['--file', savedPath, '--write'],
      url,
      profile: reopenProfile,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));

    const inspectFinal = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      url,
      profile: reopenProfile,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    expect(inspectFinal.ok).toBe(true);
    if (projectId && inspectFinal.projectId) {
      expect(inspectFinal.projectId).toBe(projectId);
    }
    const finalShotIds = ((inspectFinal.result as { shots?: Array<{ id?: string }> })?.shots ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string');
    expect(finalShotIds).toContain(shot);

    const verified = await runDocumentedAgentCommand({
      command: 'verify',
      args: ['--shot', shot],
      url,
      profile: reopenProfile,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    });
    expect(verified.envelope, verified.stderr.slice(-800)).toBeTruthy();
    expect(typeof verified.envelope?.durationMs).toBe('number');
    expect(Array.isArray(verified.envelope?.warnings)).toBe(true);
    expect(verified.envelope?.operation).toMatch(/verify/);
    expect(verified.code).toBe(verified.envelope?.ok ? 0 : 1);
    expect([0, 1]).toContain(verified.code);
  });
});
