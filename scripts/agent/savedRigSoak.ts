/**
 * Live saved-rig import soak. Default is 20 consecutive documented CLI imports.
 *
 *   npm run agent:soak-saved-rig -- --url http://127.0.0.1:4173 --write
 *
 * Each iteration uses `npm run agent:import-character` with a fresh profile.
 * Failures stop immediately. Retries are not reliability.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAgentCliArgs } from './cliArgs';
import { AGENT_CLI_EXIT, wrapAgentCliStdout, type CliStdoutContext } from './cliResult';
import { assertSuccessfulEnvelope, runDocumentedAgentCommand } from './runDocumentedCli';
import { resolveForeSceneRepoRoot } from './repoRoot';
import { savedRigFsrig } from '../../tests/fixtures/savedRigFsrig';
import { unriggedHumanoidGlb } from '../../tests/fixtures/unriggedHumanoidGlb';

function printJson(context: CliStdoutContext, value: unknown): void {
  process.stdout.write(`${JSON.stringify(wrapAgentCliStdout(context, value), null, 2)}\n`);
}

async function main() {
  const args = parseAgentCliArgs(['soak-saved-rig', ...process.argv.slice(2)]);
  if (!args.writeAccess) {
    process.stderr.write('agent:soak-saved-rig requires --write.\n');
    process.exitCode = AGENT_CLI_EXIT.usage;
    return;
  }
  const iterations = Math.max(1, Number(process.env.FORESCENE_SAVED_RIG_SOAK_ITERATIONS ?? 20));
  const repoRoot = resolveForeSceneRepoRoot();
  const context: CliStdoutContext = {
    operation: 'character.importSavedRig.soak',
    startedAt: Date.now(),
  };
  const root = await mkdtemp(path.join(os.tmpdir(), 'forescene-saved-rig-soak-'));
  const sourcePath = path.join(root, 'joseph.glb');
  const rigPath = path.join(root, 'joseph.fsrig');
  await writeFile(sourcePath, Buffer.from(unriggedHumanoidGlb()));
  await writeFile(rigPath, Buffer.from(await savedRigFsrig()));

  const runs: Array<Record<string, unknown>> = [];
  try {
    for (let index = 0; index < iterations; index += 1) {
      const profileDir = path.join(root, `profile-${index + 1}`);
      await mkdir(profileDir, { recursive: true });
      const invocation = await runDocumentedAgentCommand({
        command: 'import-character',
        args: [
          '--file', sourcePath,
          '--rig-package', rigPath,
          '--rig-mode', 'saved-rig',
          '--name', `Joseph soak ${index + 1}`,
          '--write',
        ],
        url: args.url,
        profile: profileDir,
        cwd: root,
        repoRoot,
        timeoutMs: 180_000,
      });
      if (invocation.code !== 0 || invocation.envelope?.ok !== true) {
        printJson(context, {
          ok: false,
          completed: index,
          failedAt: index + 1,
          retries: 0,
          error: invocation.envelope?.error?.message ?? invocation.stderr.slice(-400),
          runs,
        });
        process.exitCode = AGENT_CLI_EXIT.failure;
        return;
      }
      const envelope = assertSuccessfulEnvelope(invocation);
      const result = envelope.result && typeof envelope.result === 'object'
        ? envelope.result as Record<string, unknown>
        : {};
      runs.push({
        iteration: index + 1,
        objectId: result.objectId ?? envelope.affectedObjectIds?.[0],
        importFingerprint: result.importFingerprint,
        poseable: result.poseable,
        appliedSavedRig: result.appliedSavedRig,
        durationMs: envelope.durationMs,
        heartbeats: invocation.heartbeats.length,
        retries: 0,
      });
    }
    printJson(context, {
      ok: true,
      iterations,
      retries: 0,
      uniqueFingerprints: new Set(runs.map((run) => String(run.importFingerprint ?? ''))).size,
      runs,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = AGENT_CLI_EXIT.failure;
});
