import { beforeEach, describe, expect, it, vi } from 'vitest';
import mcp from '../netlify/functions/mcp.mts';
import {
  authenticateOAuthMcpRequest,
  FORESCENE_READ_SCOPE,
  FORESCENE_WRITE_SCOPE,
} from '../netlify/lib/oauthStore';
import { runRemoteBrowserCommandBySessionHash } from '../netlify/lib/remoteAgentStore';
import { createDefaultProject } from '../src/domain/defaults';

vi.mock('../netlify/lib/oauthStore.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../netlify/lib/oauthStore')>(),
  authenticateOAuthMcpRequest: vi.fn(),
}));

vi.mock('../netlify/lib/remoteAgentStore.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../netlify/lib/remoteAgentStore')>(),
  runRemoteBrowserCommandBySessionHash: vi.fn(),
}));

const origin = 'https://forescene.example';
const readScopes = [FORESCENE_READ_SCOPE];
const writeScopes = [FORESCENE_READ_SCOPE, FORESCENE_WRITE_SCOPE];

function authenticate(
  accessMode: 'read-only' | 'read-write' = 'read-write',
  scopes: Array<typeof FORESCENE_READ_SCOPE | typeof FORESCENE_WRITE_SCOPE> = readScopes,
) {
  vi.mocked(authenticateOAuthMcpRequest).mockResolvedValue({
    clientId: 'test-client',
    sessionHash: 'test-session-hash',
    resource: `${origin}/mcp`,
    scopes: new Set(scopes),
    session: {
      version: 1,
      sessionId: 'test-session',
      projectName: 'Test project',
      accessMode,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
}

function request(method: string, params: Record<string, unknown> = {}) {
  return mcp(new Request(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'auth-test', method, params }),
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  authenticate();
});

describe('MCP OAuth scope discovery and step-up', () => {
  it('declares minimal per-tool OAuth scopes, including discoverable write step-up', async () => {
    const response = await request('tools/list');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.some((tool: { name: string }) => tool.name === 'project_apply')).toBe(true);
    for (const tool of body.result.tools) {
      const securitySchemes = [{ type: 'oauth2', scopes: tool.name === 'project_apply' ? writeScopes : readScopes }];
      expect(tool.securitySchemes).toEqual(securitySchemes);
      expect(tool._meta.securitySchemes).toEqual(securitySchemes);
    }
    expect(runRemoteBrowserCommandBySessionHash).not.toHaveBeenCalled();
  });

  it('still hides project_apply when the paired browser session is read-only', async () => {
    authenticate('read-only', writeScopes);
    const response = await request('tools/list');
    const body = await response.json();
    expect(body.result.tools.some((tool: { name: string }) => tool.name === 'project_apply')).toBe(false);
    expect(runRemoteBrowserCommandBySessionHash).not.toHaveBeenCalled();
  });

  it('returns HTTP 403 and matching tool-level OAuth metadata without dispatching an apply', async () => {
    const response = await request('tools/call', {
      name: 'project_apply',
      arguments: { plan: { version: 1, commands: [] } },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const challenge = response.headers.get('www-authenticate');
    expect(challenge).toContain('Bearer error="insufficient_scope"');
    expect(challenge).toContain('error_description=');
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
    expect(challenge).toContain('scope="forescene:read forescene:write"');
    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 'auth-test',
      result: {
        isError: true,
        structuredContent: { ok: false, error: { code: 'insufficient_scope' } },
        _meta: { 'mcp/www_authenticate': [challenge] },
      },
    });
    expect(body.error).toBeUndefined();
    expect(body.result.content[0]).toMatchObject({ type: 'text' });
    expect(body.result.content[0].text).toContain('forescene:write');
    expect(runRemoteBrowserCommandBySessionHash).not.toHaveBeenCalled();
  });

  it('retains HTTP 401 read-only bootstrap for an invalid or missing token', async () => {
    vi.mocked(authenticateOAuthMcpRequest).mockResolvedValue(undefined);
    const response = await request('tools/call', { name: 'project_apply' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('scope="forescene:read"');
    expect(await response.json()).toMatchObject({ error: 'invalid_token' });
    expect(runRemoteBrowserCommandBySessionHash).not.toHaveBeenCalled();
  });

  it('does not bypass the existing read-scope gate with a write-only token', async () => {
    authenticate('read-write', [FORESCENE_WRITE_SCOPE]);
    const response = await request('tools/list');
    expect(response.status).toBe(401);
    expect(runRemoteBrowserCommandBySessionHash).not.toHaveBeenCalled();
  });

  it('does not let a write-scoped token bypass a read-only browser session', async () => {
    authenticate('read-only', writeScopes);
    const response = await request('tools/call', {
      name: 'project_apply', arguments: { plan: { version: 1, commands: [] } },
    });
    const body = await response.json();
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'write_access_required' } },
    });
    expect(runRemoteBrowserCommandBySessionHash).not.toHaveBeenCalled();
  });

  it('dispatches only after both OAuth and browser write gates pass, preserving revision checks', async () => {
    authenticate('read-write', writeScopes);
    const project = createDefaultProject();
    const plan = { version: 1, commands: [{ op: 'shot.select', shot: { id: project.shots[0]!.id } }] };
    vi.mocked(runRemoteBrowserCommandBySessionHash)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce({ ok: true });

    const response = await request('tools/call', {
      name: 'project_apply', arguments: { plan, expectedRevisionId: 'verified-revision' },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent).toEqual({ ok: true });
    expect(runRemoteBrowserCommandBySessionHash).toHaveBeenCalledTimes(2);
    expect(runRemoteBrowserCommandBySessionHash).toHaveBeenLastCalledWith(
      'test-session-hash', 'project.apply_plan', { plan, expectedRevisionId: 'verified-revision' },
      { timeoutMs: 45_000, requiresWrite: true },
    );
  });

  it('keeps read tools usable without requesting write permission', async () => {
    const response = await request('tools/call', { name: 'agent_reference' });
    expect(response.status).toBe(200);
    expect(response.headers.get('www-authenticate')).toBeNull();
    const body = await response.json();
    expect(body.result.isError).not.toBe(true);
    expect(body.result._meta?.['mcp/www_authenticate']).toBeUndefined();
  });
});
