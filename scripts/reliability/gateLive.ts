import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDocumentedAgentCommand } from '../agent/runDocumentedCli';
import { buildAgentCliCapabilityMap } from '../agent/cliCapabilities';
import { invokeAgentCli } from '../benchmark/agentCli';
import { repoRoot } from '../benchmark/layout';
import { SOAK_GATE_NAMES, type SoakGateResult } from './types';

function skipped(id: 'B' | 'C', message: string, started: number): SoakGateResult {
  return {
    id,
    name: SOAK_GATE_NAMES[id],
    status: 'skipped',
    requiredLive: true,
    message,
    durationMs: Date.now() - started,
    retries: 0,
  };
}

export async function runGateB(input: {
  url?: string;
  iterations?: number;
}): Promise<SoakGateResult> {
  const started = Date.now();
  if (!input.url) {
    return skipped('B', 'Live 20/20 saved-rig soak requires --url. Skipped is not reliability evidence.', started);
  }
  const iterations = input.iterations ?? 20;
  const soak = await runDocumentedAgentCommand({
    command: 'soak-saved-rig',
    args: ['--write'],
    url: input.url,
    timeoutMs: 40 * 60_000,
    env: {
      FORESCENE_SAVED_RIG_SOAK_ITERATIONS: String(iterations),
    },
  });
  if (soak.code !== 0 || soak.envelope?.ok !== true) {
    return {
      id: 'B',
      name: SOAK_GATE_NAMES.B,
      status: 'failed',
      requiredLive: true,
      message: soak.envelope?.error?.message || soak.stderr.slice(-600) || `Saved-rig soak exited ${soak.code}.`,
      durationMs: Date.now() - started,
      retries: 0,
    };
  }
  return {
    id: 'B',
    name: SOAK_GATE_NAMES.B,
    status: 'passed',
    requiredLive: true,
    message: `Saved-rig soak completed ${iterations} consecutive documented CLI imports with zero retries.`,
    durationMs: Date.now() - started,
    retries: 0,
  };
}

function firstShotId(payload: unknown): string | undefined {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
  const result = record?.result && typeof record.result === 'object' ? record.result as Record<string, unknown> : record;
  const shots = result?.shots;
  if (!Array.isArray(shots) || shots.length === 0) return undefined;
  const first = shots[0] as unknown;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const row = first as Record<string, unknown>;
    if (typeof row.id === 'string') return row.id;
    if (typeof row.shotId === 'string') return row.shotId;
  }
  return undefined;
}

export async function runGateC(input: {
  url?: string;
  profileDir?: string;
  iterations?: number;
}): Promise<SoakGateResult> {
  const started = Date.now();
  if (!input.url || !input.profileDir) {
    return skipped('C', 'Live clay+projected (+depth/video) render soak requires --url. Skipped is not reliability evidence.', started);
  }
  const root = repoRoot();
  const capabilities = buildAgentCliCapabilityMap();
  const inspect = await invokeAgentCli({
    repoRoot: root,
    args: ['inspect', '--document'],
    url: input.url,
    profile: input.profileDir,
  });
  const shotId = firstShotId(inspect.envelope);
  if (!shotId) {
    return {
      id: 'C',
      name: SOAK_GATE_NAMES.C,
      status: 'failed',
      requiredLive: true,
      message: 'Inspect returned no shot id to render.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }

  const panoFile = path.join(root, 'tests/fixtures/cli-parity-pano.png');
  const importedPano = await runDocumentedAgentCommand({
    command: 'import-panorama',
    args: ['--file', panoFile, '--write', '--name', 'soak-pano'],
    url: input.url,
    profile: input.profileDir,
    timeoutMs: 180_000,
  });
  if (importedPano.code !== 0 || importedPano.envelope?.ok !== true) {
    return {
      id: 'C',
      name: SOAK_GATE_NAMES.C,
      status: 'failed',
      requiredLive: true,
      message: importedPano.envelope?.error?.message ?? 'import-panorama failed before projected renders.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }
  const panoPayload = importedPano.envelope?.result && typeof importedPano.envelope.result === 'object'
    ? importedPano.envelope.result as { panoId?: string }
    : {};
  const panoId = importedPano.envelope?.affectedObjectIds?.[0] ?? panoPayload.panoId;
  const inspectShot = ((inspect.envelope?.result as { shots?: Array<{
    id?: string;
    cameraPosition?: number[];
    cameraTarget?: number[];
  }> })?.shots ?? []).find((item) => item.id === shotId);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-soak-render-'));
  const planPath = path.join(workDir, 'timeline.json');
  await writeFile(planPath, `${JSON.stringify({
    version: 1,
    commands: [
      { op: 'shot.setPanorama', shot: { id: shotId }, pano: { id: panoId } },
      {
        op: 'shot.timeline.replace',
        shot: { id: shotId },
        durationSeconds: 2,
        keyframes: [
          {
            timeSeconds: 0,
            camera: {
              position: inspectShot?.cameraPosition ?? [0, 1.6, 0],
              target: inspectShot?.cameraTarget ?? [0, 1.6, 10],
            },
          },
          {
            timeSeconds: 2,
            camera: {
              position: [
                (inspectShot?.cameraPosition?.[0] ?? 0) + 0.3,
                inspectShot?.cameraPosition?.[1] ?? 1.6,
                inspectShot?.cameraPosition?.[2] ?? 0,
              ],
              target: inspectShot?.cameraTarget ?? [0, 1.6, 10],
            },
          },
        ],
      },
    ],
  }, null, 2)}\n`);
  const applied = await runDocumentedAgentCommand({
    command: 'apply',
    args: ['--plan', planPath, '--write'],
    url: input.url,
    profile: input.profileDir,
    timeoutMs: 120_000,
  });
  if (applied.code !== 0 || applied.envelope?.ok !== true) {
    return {
      id: 'C',
      name: SOAK_GATE_NAMES.C,
      status: 'failed',
      requiredLive: true,
      message: applied.envelope?.error?.message ?? 'Could not attach panorama/timeline for projected and video renders.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }

  const stillIterations = input.iterations ?? 3;
  const modes: Array<'clay' | 'projected' | 'depth'> = ['clay', 'projected'];
  if (capabilities['render.frame.depth'] === true) modes.push('depth');
  const artifacts: string[] = [];

  async function renderStill(mode: 'clay' | 'projected' | 'depth', index: number): Promise<SoakGateResult | undefined> {
    const output = path.join(workDir, `${mode}-${index + 1}.png`);
    const frame = await runDocumentedAgentCommand({
      command: 'frame',
      args: ['--shot', shotId, '--mode', mode, '--output', output],
      url: input.url,
      profile: input.profileDir,
      timeoutMs: 180_000,
    });
    if (frame.code !== 0 || frame.envelope?.ok !== true) {
      return {
        id: 'C',
        name: SOAK_GATE_NAMES.C,
        status: 'failed',
        requiredLive: true,
        message: frame.envelope?.error?.message ?? `${mode} frame ${index + 1} failed.`,
        durationMs: Date.now() - started,
        retries: 0,
      };
    }
    const size = (await stat(output)).size;
    if (size <= 32) {
      return {
        id: 'C',
        name: SOAK_GATE_NAMES.C,
        status: 'failed',
        requiredLive: true,
        message: `${mode} frame ${index + 1} wrote ${size} bytes.`,
        durationMs: Date.now() - started,
        retries: 0,
      };
    }
    artifacts.push(output);
    return undefined;
  }

  for (const mode of modes) {
    const repeats = mode === 'depth' ? 1 : stillIterations;
    for (let index = 0; index < repeats; index += 1) {
      const failed = await renderStill(mode, index);
      if (failed) return failed;
    }
  }

  for (let index = 0; index < 2; index += 1) {
    const output = path.join(workDir, `video-${index + 1}.mp4`);
    const video = await runDocumentedAgentCommand({
      command: 'video',
      args: ['--shot', shotId, '--mode', 'clay', '--write', '--no-attach', '--output', output],
      url: input.url,
      profile: input.profileDir,
      timeoutMs: 240_000,
    });
    if (video.code !== 0 || video.envelope?.ok !== true) {
      return {
        id: 'C',
        name: SOAK_GATE_NAMES.C,
        status: 'failed',
        requiredLive: true,
        message: video.envelope?.error?.message ?? `Clay video ${index + 1} failed.`,
        durationMs: Date.now() - started,
        retries: 0,
      };
    }
    const size = (await stat(output)).size;
    if (size <= 32) {
      return {
        id: 'C',
        name: SOAK_GATE_NAMES.C,
        status: 'failed',
        requiredLive: true,
        message: `Clay video ${index + 1} wrote ${size} bytes.`,
        durationMs: Date.now() - started,
        retries: 0,
      };
    }
    artifacts.push(output);
  }

  return {
    id: 'C',
    name: SOAK_GATE_NAMES.C,
    status: 'passed',
    requiredLive: true,
    message: `Rendered repeated clay+projected${modes.includes('depth') ? '+depth' : ''} frames and two clay videos for shot ${shotId} with artifact bytes verified.`,
    durationMs: Date.now() - started,
    retries: 0,
    details: { shotId, modes, artifacts: artifacts.length },
  };
}
