import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export type RemoteAgentAccessMode = 'read-only' | 'read-write';

export interface RemoteAgentSession {
  version: 1;
  sessionId: string;
  accessMode: RemoteAgentAccessMode;
  createdAt: string;
  expiresAt: string;
  projectId?: string;
  projectName?: string;
}

export interface RemoteAgentJob {
  version: 1;
  jobId: string;
  sessionId: string;
  tool: string;
  arguments: unknown;
  createdAt: string;
  claimedAt?: string;
  claimCount: number;
}

export interface RemoteAgentJobResult {
  version: 1;
  jobId: string;
  sessionId: string;
  completedAt: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface CreatedRemoteAgentSession {
  token: string;
  tokenHash: string;
  session: RemoteAgentSession;
}

const STORE_NAME = 'forescene-agent-relay';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CLAIM_REDELIVERY_MS = 15_000;
const DEFAULT_JOB_TIMEOUT_MS = 45_000;

function store() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenHash(token: string): string {
  return sha256(token);
}

function sessionKey(hash: string): string {
  return `session/${hash}`;
}

function pendingKey(hash: string): string {
  return `pending/${hash}`;
}

function resultKey(hash: string, jobId: string): string {
  return `result/${hash}/${jobId}`;
}

function bearerToken(req: Request): string | undefined {
  const authorization = req.headers.get('authorization')?.trim();
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function expired(session: RemoteAgentSession): boolean {
  return Date.parse(session.expiresAt) <= Date.now();
}

export async function readRemoteAgentSessionByHash(hash: string): Promise<RemoteAgentSession | undefined> {
  const data = await store().get(sessionKey(hash), { type: 'json', consistency: 'strong' }) as RemoteAgentSession | null;
  if (!data) return undefined;
  if (expired(data)) {
    await Promise.allSettled([
      store().delete(sessionKey(hash)),
      store().delete(pendingKey(hash)),
    ]);
    return undefined;
  }
  return data;
}

async function readSessionByToken(token: string): Promise<RemoteAgentSession | undefined> {
  return readRemoteAgentSessionByHash(tokenHash(token));
}

export async function createRemoteAgentSession(input: {
  accessMode: RemoteAgentAccessMode;
  projectId?: string;
  projectName?: string;
}): Promise<CreatedRemoteAgentSession> {
  const token = `fs_mcp_${randomBytes(24).toString('base64url')}`;
  const hash = tokenHash(token);
  const now = new Date();
  const session: RemoteAgentSession = {
    version: 1,
    sessionId: randomUUID(),
    accessMode: input.accessMode,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.projectName ? { projectName: input.projectName } : {}),
  };
  await store().setJSON(sessionKey(hash), session, { onlyIfNew: true });
  return { token, tokenHash: hash, session };
}

export async function authenticateRemoteAgentRequest(
  req: Request,
): Promise<{ token: string; tokenHash: string; session: RemoteAgentSession } | undefined> {
  const token = bearerToken(req);
  if (!token) return undefined;
  const session = await readSessionByToken(token);
  if (!session) return undefined;
  return { token, tokenHash: tokenHash(token), session };
}

export async function disconnectRemoteAgentSession(token: string): Promise<void> {
  const hash = tokenHash(token);
  const pending = await store().get(pendingKey(hash), { type: 'json', consistency: 'strong' }) as RemoteAgentJob | null;
  const deletions: Promise<unknown>[] = [
    store().delete(sessionKey(hash)),
    store().delete(pendingKey(hash)),
  ];
  if (pending?.jobId) deletions.push(store().delete(resultKey(hash, pending.jobId)));
  await Promise.allSettled(deletions);
}

export async function pollRemoteAgentJob(token: string): Promise<RemoteAgentJob | null> {
  const session = await readSessionByToken(token);
  if (!session) throw new Error('Remote agent session is missing or expired.');
  const hash = tokenHash(token);
  const key = pendingKey(hash);
  const entry = await store().getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (!entry?.data) return null;
  const job = entry.data as RemoteAgentJob;
  if (job.sessionId !== session.sessionId) {
    await store().delete(key);
    return null;
  }

  const claimedAt = job.claimedAt ? Date.parse(job.claimedAt) : 0;
  if (claimedAt && Date.now() - claimedAt < CLAIM_REDELIVERY_MS) return null;

  const claimed: RemoteAgentJob = {
    ...job,
    claimedAt: new Date().toISOString(),
    claimCount: (job.claimCount ?? 0) + 1,
  };
  const updated = await store().setJSON(key, claimed, { onlyIfMatch: entry.etag });
  return updated.modified ? claimed : null;
}

export async function completeRemoteAgentJob(
  token: string,
  jobId: string,
  completion: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } },
): Promise<void> {
  const session = await readSessionByToken(token);
  if (!session) throw new Error('Remote agent session is missing or expired.');
  const hash = tokenHash(token);
  const pending = await store().get(pendingKey(hash), { type: 'json', consistency: 'strong' }) as RemoteAgentJob | null;
  if (!pending || pending.jobId !== jobId || pending.sessionId !== session.sessionId) {
    throw new Error('Remote agent job is no longer pending.');
  }
  const result: RemoteAgentJobResult = {
    version: 1,
    jobId,
    sessionId: session.sessionId,
    completedAt: new Date().toISOString(),
    ok: completion.ok,
    ...(completion.ok ? { result: completion.result } : { error: completion.error }),
  };
  await store().setJSON(resultKey(hash, jobId), result);
  await store().delete(pendingKey(hash));
}

export async function runRemoteBrowserCommandBySessionHash(
  sessionHash: string,
  tool: string,
  args: unknown,
  options: { timeoutMs?: number; requiresWrite?: boolean } = {},
): Promise<unknown> {
  const session = await readRemoteAgentSessionByHash(sessionHash);
  if (!session) throw new RemoteAgentRelayError('session_unavailable', 'ForeScene browser session is missing or expired.');
  if (options.requiresWrite && session.accessMode !== 'read-write') {
    throw new RemoteAgentRelayError('write_access_required', 'This remote session is read-only.');
  }

  const hash = sessionHash;
  const job: RemoteAgentJob = {
    version: 1,
    jobId: randomUUID(),
    sessionId: session.sessionId,
    tool,
    arguments: args,
    createdAt: new Date().toISOString(),
    claimCount: 0,
  };

  const pending = await store().setJSON(pendingKey(hash), job, { onlyIfNew: true });
  if (!pending.modified) {
    throw new RemoteAgentRelayError('session_busy', 'The ForeScene browser session is already processing another remote command.');
  }

  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS, 1_000), 50_000);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await store().get(resultKey(hash, job.jobId), { type: 'json', consistency: 'strong' }) as RemoteAgentJobResult | null;
      if (result) {
        await store().delete(resultKey(hash, job.jobId));
        if (result.ok) return result.result;
        throw new RemoteAgentRelayError(
          result.error?.code ?? 'browser_command_failed',
          result.error?.message ?? 'ForeScene browser command failed.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new RemoteAgentRelayError(
      'browser_timeout',
      'The open ForeScene tab did not answer before the remote command timed out. Keep Agent Connection enabled and the tab open.',
    );
  } finally {
    await store().delete(pendingKey(hash)).catch(() => undefined);
  }
}

export async function runRemoteBrowserCommand(
  token: string,
  tool: string,
  args: unknown,
  options: { timeoutMs?: number; requiresWrite?: boolean } = {},
): Promise<unknown> {
  return runRemoteBrowserCommandBySessionHash(tokenHash(token), tool, args, options);
}

export class RemoteAgentRelayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteAgentRelayError';
    this.code = code;
  }
}

export function unauthorizedResponse(): Response {
  return Response.json(
    { ok: false, error: { code: 'unauthorized', message: 'A valid ForeScene Agent bearer token is required.' } },
    {
      status: 401,
      headers: {
        'www-authenticate': 'Bearer realm="ForeScene Remote Agent"',
        'cache-control': 'no-store',
      },
    },
  );
}

export function noStoreJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(value, { ...init, headers });
}
