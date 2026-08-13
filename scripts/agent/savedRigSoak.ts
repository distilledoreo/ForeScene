/**
 * Live saved-rig import soak. Default is 20 consecutive documented CLI imports
 * of the synthetic humanoid fixture.
 *
 *   npm run agent:soak-saved-rig -- --url http://127.0.0.1:4173 --write
 *
 * Optional real-asset soak (caller-supplied paths only — no production names
 * in this script):
 *
 *   npm run agent:soak-saved-rig -- --url http://127.0.0.1:4173 --write \
 *     --source /path/to/character.glb --rig-package /path/to/character.fsrig
 *
 * Each iteration uses `npm run agent:import-character` with a fresh profile.
 * Failures stop immediately. Retries are not reliability.
 */

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAgentCliArgs } from './cliArgs';
import { beginCliOperation } from './cliOperation';
import { AGENT_CLI_EXIT, wrapAgentCliStdout, type CliStdoutContext } from './cliResult';
import { assertSuccessfulEnvelope, runDocumentedAgentCommand } from './runDocumentedCli';
import { resolveForeSceneRepoRoot } from './repoRoot';
import { savedRigFsrig } from '../../tests/fixtures/savedRigFsrig';
import { unriggedHumanoidGlb } from '../../tests/fixtures/unriggedHumanoidGlb';

function printJson(context: CliStdoutContext, value: unknown): void {
  process.stdout.write(`${JSON.stringify(wrapAgentCliStdout(context, value), null, 2)}\n`);
}

async function assertReadable(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} is not readable: ${filePath}`);
  }
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
  const sourceArg = args.file ?? process.env.FORESCENE_SAVED_RIG_SOURCE;
  const rigArg = args.rigPackage ?? process.env.FORESCENE_SAVED_RIG_PACKAGE;
  if (Boolean(sourceArg) !== Boolean(rigArg)) {
    process.stderr.write('agent:soak-saved-rig real-asset mode requires both --source/--file and --rig-package.\n');
    process.exitCode = AGENT_CLI_EXIT.usage;
    return;
  }
  const realAsset = Boolean(sourceArg && rigArg);
  const root = await mkdtemp(path.join(os.tmpdir(), 'forescene-saved-rig-soak-'));
  let sourcePath: string;
  let rigPath: string;
  if (realAsset) {
    sourcePath = path.resolve(sourceArg!);
    rigPath = path.resolve(rigArg!);
    await assertReadable(sourcePath, 'Saved-rig source');
    await assertReadable(rigPath, 'Saved-rig package');
  } else {
    sourcePath = path.join(root, 'humanoid.glb');
    rigPath = path.join(root, 'humanoid.fsrig');
    await writeFile(sourcePath, Buffer.from(unriggedHumanoidGlb()));
    await writeFile(rigPath, Buffer.from(await savedRigFsrig()));
  }

  const operation = beginCliOperation({
    type: 'character.importSavedRig.soak',
  });
  context.operationId = operation.record.operationId;
  const runs: Array<Record<string, unknown>> = [];
  await operation.start(`Saved-rig soak 0/${iterations}`);
  try {
    for (let index = 0; index < iterations; index += 1) {
      if (await operation.isCancelRequested()) {
        await operation.cancel('Saved-rig soak was cancelled.');
        printJson(context, { ok: false, completed: index, retries: 0, cancelled: true, runs });
        process.exitCode = AGENT_CLI_EXIT.failure;
        return;
      }
      const profileDir = path.join(root, `profile-${index + 1}`);
      await mkdir(profileDir, { recursive: true });
      await operation.progress({
        progress: index / iterations,
        message: `Saved-rig import ${index + 1}/${iterations}`,
      });
      const invocation = await runDocumentedAgentCommand({
        command: 'import-character',
        args: [
          '--file', sourcePath,
          '--rig-package', rigPath,
          '--rig-mode', 'saved-rig',
          '--name', `Saved-rig soak ${index + 1}`,
          '--write',
          ...(realAsset ? ['--allow-heavy-character-imports'] : []),
        ],
        url: args.url,
        profile: profileDir,
        cwd: root,
        repoRoot,
        timeoutMs: realAsset ? 10 * 60_000 : 180_000,
      });
      if (invocation.code !== 0 || invocation.envelope?.ok !== true) {
        await operation.fail(invocation.envelope?.error?.message ?? 'Saved-rig import failed.');
        printJson(context, {
          ok: false,
          completed: index,
          failedAt: index + 1,
          retries: 0,
          realAsset,
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
    await operation.complete(`Saved-rig soak ${iterations}/${iterations}`);
    printJson(context, {
      ok: true,
      iterations,
      retries: 0,
      realAsset,
      soakHeartbeatCount: operation.record.heartbeatCount,
      uniqueFingerprints: new Set(runs.map((run) => String(run.importFingerprint ?? ''))).size,
      runs,
    });
  } finally {
    operation.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = AGENT_CLI_EXIT.failure;
});
