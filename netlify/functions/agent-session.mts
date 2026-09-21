import {
  authenticateRemoteAgentRequest,
  createRemoteAgentSession,
  disconnectRemoteAgentSession,
  noStoreJson,
  unauthorizedResponse,
} from '../lib/remoteAgentStore.ts';

export default async (req: Request) => {
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const accessMode = body.accessMode === 'read-write' ? 'read-write' : 'read-only';
    const created = await createRemoteAgentSession({
      accessMode,
      ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
      ...(typeof body.projectName === 'string' ? { projectName: body.projectName } : {}),
    });
    const origin = new URL(req.url).origin;
    return noStoreJson({
      ok: true,
      token: created.token,
      sessionId: created.session.sessionId,
      accessMode: created.session.accessMode,
      expiresAt: created.session.expiresAt,
      mcpUrl: `${origin}/mcp`,
    }, { status: 201 });
  }

  if (req.method === 'DELETE') {
    const auth = await authenticateRemoteAgentRequest(req);
    if (!auth) return unauthorizedResponse();
    await disconnectRemoteAgentSession(auth.token);
    return noStoreJson({ ok: true });
  }

  return new Response('Method not allowed', { status: 405, headers: { allow: 'POST, DELETE' } });
};

export const config = {
  path: '/api/agent/session',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
