/**
 * Live saved-rig import soak. Default is 20 consecutive fresh profiles.
 *
 *   npm run agent:soak-saved-rig -- --url http://127.0.0.1:3000 --write
 *
 * Optional `--with-inspect` runs 10 more imports interleaved with inspect.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAgentCliArgs } from './cliArgs';
import { openAgentBrowser } from './browser';
import { recoverChromiumProfileLocks } from './browserProfile';
import { wrapAgentCliStdout, type CliStdoutContext } from './cliResult';
import { savedRigFsrig } from '../../tests/fixtures/savedRigFsrig';
import { unriggedHumanoidGlb } from '../../tests/fixtures/unriggedHumanoidGlb';

function printJson(context: CliStdoutContext, value: unknown): void {
  process.stdout.write(`${JSON.stringify(wrapAgentCliStdout(context, value), null, 2)}\n`);
}

async function importOnce(input: {
  url?: string;
  profileDir: string;
  sourcePath: string;
  rigPath: string;
  name: string;
}) {
  const session = await openAgentBrowser({
    url: input.url,
    headless: true,
    writeAccess: true,
    persistWrite: false,
    profileDir: input.profileDir,
  });
  try {
    await session.page.locator('[data-agent-character-import-input]').setInputFiles(input.sourcePath);
    await session.page.locator('[data-agent-character-rig-package-input]').setInputFiles(input.rigPath);
    const imported = await session.page.evaluate(async (characterName) => {
      const sourceInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
      const rigInput = document.querySelector('[data-agent-character-rig-package-input]') as HTMLInputElement | null;
      const sourceFile = sourceInput?.files?.[0];
      const rigPackageFile = rigInput?.files?.[0];
      if (!sourceFile || !rigPackageFile) throw new Error('Saved-rig files were not staged.');
      return window.foreScene!.importSavedRigCharacter({
        sourceFile,
        rigPackageFile,
        name: characterName,
      });
    }, input.name);
    const lockAfterClosePlan = await recoverChromiumProfileLocks(input.profileDir);
    return { imported, profileRecovery: session.profileRecovery, lockAfterClosePlan };
  } finally {
    await session.close();
  }
}

async function main() {
  const args = parseAgentCliArgs(['soak-saved-rig', ...process.argv.slice(2)]);
  const iterations = Math.max(1, Number(process.env.FORESCENE_SAVED_RIG_SOAK_ITERATIONS ?? 20));
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
      const result = await importOnce({
        url: args.url,
        profileDir,
        sourcePath,
        rigPath,
        name: `Joseph soak ${index + 1}`,
      });
      if (!result.imported.ok) {
        printJson(context, {
          ok: false,
          completed: index,
          failedAt: index + 1,
          error: result.imported.diagnostics?.[0]?.message ?? 'Saved-rig import failed.',
          runs,
          last: result,
        });
        process.exitCode = 1;
        return;
      }
      await sessionClosedLockGone(profileDir);
      runs.push({
        iteration: index + 1,
        objectId: result.imported.objectId,
        importFingerprint: result.imported.importFingerprint,
        poseable: result.imported.poseable,
        appliedSavedRig: result.imported.appliedSavedRig,
        recoveredLock: result.profileRecovery.recovered,
      });
    }
    printJson(context, {
      ok: true,
      iterations,
      uniqueFingerprints: new Set(runs.map((run) => run.importFingerprint)).size,
      runs,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sessionClosedLockGone(profileDir: string): Promise<void> {
  const recovery = await recoverChromiumProfileLocks(profileDir);
  if (recovery.status === 'active') {
    throw new Error(`Orphan Chromium still holds ${profileDir}: ${recovery.message}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
