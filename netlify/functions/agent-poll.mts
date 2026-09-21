import {
  authenticateRemoteAgentRequest,
  noStoreJson,
  pollRemoteAgentJob,
  unauthorizedResponse,
} from '../lib/remoteAgentStore.ts';

export default async (req: Request) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
  const auth = await authenticateRemoteAgentRequest(req);
  if (!auth) return unauthorizedResponse();
  const command = await pollRemoteAgentJob(auth.token);
  return noStoreJson({ ok: true, command });
};

export const config = { path: '/api/agent/poll' };
