import {
  authenticateRemoteAgentRequest,
  completeRemoteAgentJob,
  noStoreJson,
  unauthorizedResponse,
} from '../lib/remoteAgentStore.ts';

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  const auth = await authenticateRemoteAgentRequest(req);
  if (!auth) return unauthorizedResponse();
  const body = await req.json().catch(() => undefined) as {
    jobId?: string;
    ok?: boolean;
    result?: unknown;
    error?: { code?: string; message?: string };
  } | undefined;
  if (!body?.jobId || typeof body.ok !== 'boolean') {
    return noStoreJson({ ok: false, error: { code: 'invalid_request', message: 'jobId and ok are required.' } }, { status: 400 });
  }
  await completeRemoteAgentJob(
    auth.token,
    body.jobId,
    body.ok
      ? { ok: true, result: body.result }
      : {
          ok: false,
          error: {
            code: body.error?.code ?? 'browser_command_failed',
            message: body.error?.message ?? 'ForeScene browser command failed.',
          },
        },
  );
  return noStoreJson({ ok: true });
};

export const config = { path: '/api/agent/result' };
