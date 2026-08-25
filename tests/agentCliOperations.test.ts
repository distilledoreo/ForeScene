import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPidAlive,
  parseChromiumLockTarget,
  recoverChromiumProfileLocks,
  writeChromiumSingletonLock,
} from '../scripts/agent/browserProfile';
import {
  AGENT_OPERATIONS_DIR,
  beginCliOperation,
  characterImportPhaseProgress,
  readCliOperationRecord,
  requestCliOperationCancel,
} from '../scripts/agent/cliOperation';
import { createCliAbortScope } from '../scripts/agent/cliAbort';

describe('Chromium profile lock recovery', () => {
  it('parses hostname-pid lock targets', () => {
    expect(parseChromiumLockTarget('testhost-4321')).toEqual({ hostname: 'testhost', pid: 4321 });
    expect(parseChromiumLockTarget('4321')).toEqual({ pid: 4321 });
  });

  it('does not remove a lock owned by a live process', async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-lock-live-'));
    try {
      await writeChromiumSingletonLock(profileDir, { hostname: 'testhost', pid: process.pid });
      const recovery = await recoverChromiumProfileLocks(profileDir);
      expect(recovery.blocked).toBe(true);
      expect(recovery.recovered).toBe(false);
      expect(recovery.status).toBe('active');
      await expect(lstat(path.join(profileDir, 'SingletonLock'))).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
      expect(recovery.message).toMatch(/agent:cancel/i);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  it('cleans stale locks for dead owners 20 times without leftover files', async () => {
    const deadPid = 2_147_483_646;
    expect(isPidAlive(deadPid)).toBe(false);
    for (let index = 0; index < 20; index += 1) {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), `forescene-lock-stale-${index}-`));
      try {
        await writeChromiumSingletonLock(profileDir, { hostname: 'testhost', pid: deadPid });
        const recovery = await recoverChromiumProfileLocks(profileDir);
        expect(recovery.recovered, `iteration ${index}`).toBe(true);
        expect(recovery.blocked).toBe(false);
        expect(recovery.status).toBe('stale');
        await expect(lstat(path.join(profileDir, 'SingletonLock'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    }
  });
});

describe('CLI operation lifecycle', () => {
  afterEach(async () => {
    await rm(AGENT_OPERATIONS_DIR, { recursive: true, force: true });
  });

  it('emits heartbeats and records progress while the operation is alive', async () => {
    const operation = beginCliOperation({
      type: 'character.importSavedRig',
      heartbeatMs: 80,
    });
    await mkdir(AGENT_OPERATIONS_DIR, { recursive: true });
    await operation.start('Applying saved rig');
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(operation.record.heartbeatCount).toBeGreaterThanOrEqual(2);
    expect(['running', 'progress']).toContain(operation.record.state);
    expect(operation.record.operationId).toMatch(/^op_/);
    await operation.progress({ progress: 0.63, message: 'Applying saved rig' });
    expect(operation.record.progress).toBe(0.63);
    await operation.complete();
    expect(operation.record.state).toBe('completed');
  });

  it('cancels by operation id without requiring a Chromium pid', async () => {
    const operation = beginCliOperation({
      type: 'character.import',
      heartbeatMs: 10_000,
    });
    await operation.start();
    const result = await requestCliOperationCancel(operation.record.operationId);
    expect(result.ok).toBe(true);
    expect(result.signaled).toBe(false);
    expect(await operation.isCancelRequested()).toBe(true);
    operation.dispose();
  });

  it('does not overwrite a completed operation with a late cleanup cancellation', async () => {
    const operation = beginCliOperation({
      type: 'project.inspect',
      heartbeatMs: 10_000,
    });
    await operation.start();
    await operation.complete('Inspect completed.');
    await operation.cancel('Late cancellation from cleanup.');

    expect(operation.record).toMatchObject({
      state: 'completed',
      progress: 1,
      message: 'Inspect completed.',
      cancelRequested: false,
    });
    await expect(readCliOperationRecord(operation.record.operationId)).resolves.toMatchObject({
      state: 'completed',
      message: 'Inspect completed.',
      cancelRequested: false,
    });
  });

  it('separates listener cleanup from explicit abort notification', () => {
    let cleanupNotifications = 0;
    const cleanupScope = createCliAbortScope({
      onAbort: () => { cleanupNotifications += 1; },
    });
    cleanupScope.dispose();
    expect(cleanupScope.signal.aborted).toBe(false);
    expect(cleanupNotifications).toBe(0);

    let abortNotifications = 0;
    const abortScope = createCliAbortScope({
      onAbort: () => { abortNotifications += 1; },
    });
    abortScope.abort();
    expect(abortScope.signal.aborted).toBe(true);
    expect(abortNotifications).toBe(1);
    abortScope.dispose();
  });

  it('maps saved-rig import phases onto a 0-1 progress value', () => {
    expect(characterImportPhaseProgress('reading')).toBeGreaterThan(0);
    expect(characterImportPhaseProgress('saving')).toBeGreaterThan(characterImportPhaseProgress('mapping'));
    expect(characterImportPhaseProgress('complete')).toBe(1);
  });
});
