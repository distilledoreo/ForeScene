import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bindProjectIdentity,
  claimBrowserLaunch,
  createAgentRunRecord,
  runSequentialSessionOperations,
  sessionOwnershipSnapshot,
  startAgentRunSession,
} from '../scripts/agent/agentSession';
import { isDefaultAgentProfilePath } from '../scripts/agent/agentProfile';

describe('run-scoped Agent session ownership', () => {
  it('reuses one explicit profile and project identity across sequential operations', () => {
    const profileDir = path.join(os.tmpdir(), `forescene-session-profile-${Date.now()}`);
    const record = createAgentRunRecord({ profileDir });
    expect(isDefaultAgentProfilePath(record.profileDir)).toBe(false);
    expect(record.chromiumLaunches).toBe(0);

    expect(claimBrowserLaunch(record)).toBe(1);
    bindProjectIdentity(record, { projectId: 'proj_live', revisionId: 'rev_1' });
    const first = sessionOwnershipSnapshot(record);

    bindProjectIdentity(record, { projectId: 'proj_live', revisionId: 'rev_1' });
    const second = sessionOwnershipSnapshot(record);

    expect(second.chromiumLaunches).toBe(1);
    expect(second.profileDir).toBe(first.profileDir);
    expect(second.projectId).toBe(first.projectId);
    expect(second.revisionId).toBe(first.revisionId);
    expect(second.runId).toBe(first.runId);
  });

  it('does not claim a second implicit default-profile launch', () => {
    const profileDir = path.join(os.tmpdir(), `forescene-session-profile-${Date.now()}-b`);
    const record = createAgentRunRecord({ profileDir });
    claimBrowserLaunch(record);
    expect(() => createAgentRunRecord({
      profileDir: '.forescene-agent/browser-profile',
    })).toThrow(/Refusing default|require --profile/);
    expect(record.chromiumLaunches).toBe(1);
  });

  it('runs two inspect operations on one live session when a ForeScene URL is available', async () => {
    const url = process.env.FORESCENE_URL;
    if (!url) {
      expect(typeof startAgentRunSession).toBe('function');
      expect(typeof runSequentialSessionOperations).toBe('function');
      return;
    }
    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-session-live-'));
    const session = await startAgentRunSession({
      profileDir,
      url,
      headless: true,
    });
    try {
      const result = await runSequentialSessionOperations(session, [
        () => session.inspect(),
        () => session.inspect(),
      ]);
      expect(result.chromiumLaunches).toBe(1);
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0]?.profileDir).toBe(session.profileDir);
      expect(result.snapshots[1]?.projectId).toBe(result.snapshots[0]?.projectId);
      expect(isDefaultAgentProfilePath(session.profileDir)).toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);
});
