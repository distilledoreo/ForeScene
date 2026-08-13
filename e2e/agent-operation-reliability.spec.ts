/**
 * Live Agent CLI operation reliability.
 *
 * Uses documented `npm run agent:*` commands only. Cancel sends SIGINT to the
 * CLI process; this spec must not kill Chromium or delete profile locks.
 */

import { expect, test } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertSuccessfulEnvelope,
  runDocumentedAgentCommand,
  startDocumentedAgentCommand,
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

async function inspectShot(input: {
  url?: string;
  profile: string;
  workDir: string;
  repoRoot: string;
}) {
  const inspect = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
    command: 'inspect',
    args: ['--document'],
    url: input.url,
    profile: input.profile,
    cwd: input.workDir,
    repoRoot: input.repoRoot,
    timeoutMs: 120_000,
  }));
  return { inspect, shot: firstShotSelector(inspect) };
}

async function applyLongTimeline(input: {
  url?: string;
  profile: string;
  workDir: string;
  repoRoot: string;
  shot: string;
  durationSeconds: number;
}) {
  const inspect = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
    command: 'inspect',
    args: ['--document'],
    url: input.url,
    profile: input.profile,
    cwd: input.workDir,
    repoRoot: input.repoRoot,
    timeoutMs: 120_000,
  }));
  const openedShot = ((inspect.result as { shots?: Array<{
    id?: string;
    cameraPosition?: number[];
    cameraTarget?: number[];
  }> })?.shots ?? []).find((item) => item.id === input.shot)
    ?? { cameraPosition: [0, 1.6, 0], cameraTarget: [0, 1.6, 10] };
  const planPath = path.join(input.workDir, `timeline-${input.durationSeconds}.json`);
  await writeFile(planPath, `${JSON.stringify({
    version: 1,
    commands: [
      {
        op: 'shot.timeline.replace',
        shot: { id: input.shot },
        durationSeconds: input.durationSeconds,
        keyframes: [
          {
            timeSeconds: 0,
            camera: {
              position: openedShot.cameraPosition ?? [0, 1.6, 0],
              target: openedShot.cameraTarget ?? [0, 1.6, 10],
            },
          },
          {
            timeSeconds: input.durationSeconds,
            camera: {
              position: [
                (openedShot.cameraPosition?.[0] ?? 0) + 0.5,
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
    url: input.url,
    profile: input.profile,
    cwd: input.workDir,
    repoRoot: input.repoRoot,
    timeoutMs: 120_000,
  }));
}

test.describe('Agent CLI operation reliability @heavy @agent-ops', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chromium',
      'Agent CLI drives its own Chromium persistent profile.',
    );
  });

  test('live saved-rig import is 20/20 with zero retries', async ({ baseURL }) => {
    test.setTimeout(40 * 60_000);
    const url = process.env.FORESCENE_URL ?? baseURL;
    expect(url).toBeTruthy();
    const repoRoot = resolveForeSceneRepoRoot();
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-saved-rig-live-'));
    const soak = await runDocumentedAgentCommand({
      command: 'soak-saved-rig',
      args: ['--write'],
      url,
      cwd: workDir,
      repoRoot,
      timeoutMs: 39 * 60_000,
      env: {
        FORESCENE_SAVED_RIG_SOAK_ITERATIONS: '20',
      },
    });
    const envelope = assertSuccessfulEnvelope(soak);
    const result = envelope.result as {
      ok?: boolean;
      iterations?: number;
      retries?: number;
      runs?: unknown[];
    };
    expect(result.iterations).toBe(20);
    expect(result.retries).toBe(0);
    expect(result.runs).toHaveLength(20);
    expect(soak.envelope?.ok).toBe(true);
  });

  test('heartbeats distinguish a live >60s operation from a hang, then cancel recovers', async ({ baseURL }) => {
    test.setTimeout(8 * 60_000);
    const url = process.env.FORESCENE_URL ?? baseURL;
    expect(url).toBeTruthy();
    const repoRoot = resolveForeSceneRepoRoot();
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-ops-live-'));
    const profileDir = path.join(workDir, 'profile');
    const { shot } = await inspectShot({ url, profile: profileDir, workDir, repoRoot });
    await applyLongTimeline({
      url,
      profile: profileDir,
      workDir,
      repoRoot,
      shot,
      durationSeconds: 30,
    });

    const video = startDocumentedAgentCommand({
      command: 'video',
      args: ['--shot', shot, '--mode', 'clay', '--write', '--no-attach', '--output', path.join(workDir, 'long.mp4')],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 7 * 60_000,
    });

    const deadline = Date.now() + 4 * 60_000;
    let alive = false;
    while (Date.now() < deadline) {
      const beats = video.heartbeats();
      if (beats.length >= 3) {
        const first = beats[0]!;
        const last = beats[beats.length - 1]!;
        const advancing = last.elapsedMs - first.elapsedMs >= 60_000
          && last.heartbeatCount > first.heartbeatCount
          && last.operationId === first.operationId;
        if (advancing) {
          alive = true;
          const cancelled = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
            command: 'cancel',
            args: ['--operation', last.operationId],
            url,
            cwd: workDir,
            repoRoot,
            timeoutMs: 30_000,
          }));
          expect(cancelled.ok).toBe(true);
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(alive, `heartbeats did not advance past 60s: ${JSON.stringify(video.heartbeats().slice(-3))}`).toBe(true);

    const finished = await video.wait();
    expect(finished.code).not.toBe(0);
    expect(video.heartbeats().every((beat) => beat.event === 'heartbeat')).toBe(true);

    const after = assertSuccessfulEnvelope(await runDocumentedAgentCommand({
      command: 'inspect',
      args: ['--document'],
      url,
      profile: profileDir,
      cwd: workDir,
      repoRoot,
      timeoutMs: 180_000,
    }));
    expect(after.ok).toBe(true);
    expect(firstShotSelector(after)).toBe(shot);
  });
});
