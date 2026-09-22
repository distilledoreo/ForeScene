import {
  clearOAuthPairingCookie,
  createOAuthPairing,
  oauthPairingCookie,
} from '../lib/oauthStore.ts';
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
    const pairing = await createOAuthPairing(
      created.tokenHash,
      created.session.expiresAt,
    );
    return noStoreJson({
      ok: true,
      token: created.token,
      sessionId: created.session.sessionId,
      accessMode: created.session.accessMode,
      expiresAt: created.session.expiresAt,
      mcpUrl: `${origin}/mcp`,
      oauthEnabled: true,
    }, {
      status: 201,
      headers: {
        'set-cookie': oauthPairingCookie(pairing.token, pairing.expiresAt),
      },
    });
  }

  if (req.method === 'DELETE') {
    const auth = await authenticateRemoteAgentRequest(req);
    if (!auth) return unauthorizedResponse();
    await disconnectRemoteAgentSession(auth.token);
    return noStoreJson(
      { ok: true },
      { headers: { 'set-cookie': clearOAuthPairingCookie() } },
    );
  }

  return new Response('Method not allowed', { status: 405, headers: { allow: 'POST, DELETE' } });
};

export const config = {
  path: '/api/agent/session',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
