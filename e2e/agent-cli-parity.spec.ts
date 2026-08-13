/**
 * CLI-only end-to-end parity.
 *
 * Uses documented `npm run agent:*` commands exclusively. This file must not
 * import ForeScene source modules or spawn custom glue scripts.
 */

import { expect, test } from '@playwright/test';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertSuccessfulEnvelope,
  runDocumentedAgentCommand,
} from '../scripts/agent/runDocumentedCli';
import { resolveForeSceneRepoRoot } from '../scripts/agent/repoRoot';

function firstShotNumber(envelope: { result?: unknown }): string {
  const result = envelope.result && typeof envelope.result === 'object'
    ? envelope.result as Record<string, unknown>
    : {};
  const shots = Array.isArray(result.shots) ? result.shots : [];
  const first = shots[0] as { shotNumber?: string; id?: string } | undefined;
  const value = first?.shotNumber ?? first?.id;
  if (!value) throw new Error('inspect did not return a shot number.');
  return value;
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
    const shot = firstShotNumber(inspectFresh);
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
      args: ['--shot', shot, '--mode', 'clay', '--write', '--output', videoPath],
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

    assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'open',
      args: ['--file', savedPath, '--write'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));

    const inspectFinal = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 120_000,
    }));
    if (projectId && inspectFinal.projectId) {
      expect(inspectFinal.projectId).toBe(projectId);
    }

    const verified = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'verify',
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    expect(verified.ok).toBe(true);
  });
});
