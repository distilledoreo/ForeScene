/**
 * Run-scoped Agent session: one explicit profile and one live browser for a
 * production/benchmark run. Does not replace process-exit persist goldens.
 */

import { requireExplicitAgentProfile } from './agentProfile';
import { openAgentBrowser, type AgentBrowserSession } from './browser';
import { createCliInvocationIdentity, publishCliInvocationIdentity } from './cliIdentity';
import { inspectViaBrowser } from './inspect';

export interface AgentRunIdentity {
  projectId?: string;
  revisionId?: string;
}

export interface AgentRunRecord {
  runId: string;
  profileDir: string;
  url?: string;
  chromiumLaunches: number;
  projectId?: string;
  revisionId?: string;
}

export interface AgentRunSession extends AgentRunRecord {
  browser: AgentBrowserSession;
  refreshIdentity(): Promise<AgentRunIdentity>;
  inspect(): Promise<unknown>;
  close(): Promise<void>;
}

let attached: AgentRunSession | undefined;

export function createAgentRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createAgentRunRecord(input: {
  profileDir: string;
  url?: string;
  runId?: string;
  repoRoot?: string;
}): AgentRunRecord {
  const profileDir = requireExplicitAgentProfile(input.profileDir, input.repoRoot);
  return {
    runId: input.runId ?? createAgentRunId(),
    profileDir,
    url: input.url,
    chromiumLaunches: 0,
  };
}

export function claimBrowserLaunch(record: AgentRunRecord): number {
  record.chromiumLaunches += 1;
  return record.chromiumLaunches;
}

export function bindProjectIdentity(record: AgentRunRecord, identity: AgentRunIdentity): AgentRunRecord {
  if (identity.projectId) record.projectId = identity.projectId;
  if (identity.revisionId) record.revisionId = identity.revisionId;
  return record;
}

export function sessionOwnershipSnapshot(record: AgentRunRecord) {
  return {
    runId: record.runId,
    profileDir: record.profileDir,
    chromiumLaunches: record.chromiumLaunches,
    projectId: record.projectId,
    revisionId: record.revisionId,
  };
}

export function attachAgentRunSession(session: AgentRunSession): void {
  attached = session;
}

export function detachAgentRunSession(): void {
  attached = undefined;
}

export function activeAgentRunSession(): AgentRunSession | undefined {
  return attached;
}

function identityFromInspect(payload: unknown): AgentRunIdentity {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const status = root.status && typeof root.status === 'object' ? root.status as Record<string, unknown> : {};
  const project = root.project && typeof root.project === 'object' ? root.project as Record<string, unknown> : {};
  const projectId = typeof status.projectId === 'string'
    ? status.projectId
    : typeof project.id === 'string' ? project.id : undefined;
  const revisionId = typeof status.revisionId === 'string' ? status.revisionId : undefined;
  return { projectId, revisionId };
}

export async function startAgentRunSession(input: {
  profileDir: string;
  url?: string;
  headless?: boolean;
  writeAccess?: boolean;
  persistWrite?: boolean;
  runId?: string;
  command?: string;
}): Promise<AgentRunSession> {
  const record = createAgentRunRecord({
    profileDir: input.profileDir,
    url: input.url,
    runId: input.runId,
  });
  claimBrowserLaunch(record);
  const browser = await openAgentBrowser({
    url: input.url,
    headless: input.headless,
    writeAccess: input.writeAccess,
    persistWrite: input.persistWrite,
    profileDir: record.profileDir,
  });
  await publishCliInvocationIdentity(browser.page, createCliInvocationIdentity({
    command: input.command ?? 'session',
    profile: record.profileDir,
  }));

  const session: AgentRunSession = {
    ...record,
    browser,
    async refreshIdentity() {
      const payload = await inspectViaBrowser(browser.page);
      bindProjectIdentity(record, identityFromInspect(payload));
      session.projectId = record.projectId;
      session.revisionId = record.revisionId;
      return { projectId: record.projectId, revisionId: record.revisionId };
    },
    async inspect() {
      const payload = await inspectViaBrowser(browser.page);
      bindProjectIdentity(record, identityFromInspect(payload));
      session.projectId = record.projectId;
      session.revisionId = record.revisionId;
      return payload;
    },
    async close() {
      if (attached === session) attached = undefined;
      await browser.close();
    },
  };
  session.chromiumLaunches = record.chromiumLaunches;
  return session;
}

export async function runSequentialSessionOperations(
  session: AgentRunSession,
  operations: Array<() => Promise<unknown>>,
): Promise<{ snapshots: ReturnType<typeof sessionOwnershipSnapshot>[]; chromiumLaunches: number }> {
  const snapshots: ReturnType<typeof sessionOwnershipSnapshot>[] = [];
  for (const operation of operations) {
    await operation();
    snapshots.push(sessionOwnershipSnapshot(session));
  }
  return { snapshots, chromiumLaunches: session.chromiumLaunches };
}
