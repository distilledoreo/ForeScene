import { beforeEach, describe, expect, it, vi } from 'vitest';
import authorize from '../netlify/functions/oauth-authorize.mts';
import { issueOAuthAuthorizationCode, readOAuthClient, resolveOAuthPairing } from '../netlify/lib/oauthStore';

vi.mock('../netlify/lib/oauthStore.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../netlify/lib/oauthStore')>(),
  readOAuthClient: vi.fn(),
  resolveOAuthPairing: vi.fn(),
  issueOAuthAuthorizationCode: vi.fn(),
}));

const origin = 'https://forescene.example';
const redirectUri = 'https://chatgpt.com/connector_platform/oauth/callback';
const params = new URLSearchParams({
  response_type: 'code',
  client_id: 'test-client',
  redirect_uri: redirectUri,
  code_challenge: 'a'.repeat(43),
  code_challenge_method: 'S256',
  state: 'test-state',
  resource: `${origin}/mcp`,
});

function request(changes: Record<string, string> = {}, method = 'GET') {
  const body = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) body.set(key, value);
  return method === 'GET'
    ? new Request(`${origin}/oauth/authorize?${body}`)
    : new Request(`${origin}/oauth/authorize`, {
      method,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
}

function register(uri: string) {
  vi.mocked(readOAuthClient).mockResolvedValue({
    version: 1,
    clientId: 'test-client',
    clientName: 'Test MCP client',
    redirectUris: [uri, 'https://other-client.example/callback'],
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  register(redirectUri);
  vi.mocked(resolveOAuthPairing).mockResolvedValue({
    sessionHash: 'test-session-hash',
    session: {
      version: 1,
      sessionId: 'test-session',
      projectName: 'Test project',
      accessMode: 'read-only',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  vi.mocked(issueOAuthAuthorizationCode).mockResolvedValue('test-code');
});

describe('OAuth consent navigation', () => {
  it('permits the selected registered callback origin while preserving other CSP protections', async () => {
    const response = await authorize(request());
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy')!;
    expect(policy.split('; ').find((directive) => directive.startsWith('form-action')))
      .toBe("form-action 'self' https://chatgpt.com");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toContain('other-client.example');
    expect(await response.text()).toContain('action="/oauth/authorize"');
  });

  it.each([
    ['http://127.0.0.1:43210/callback', 'http://127.0.0.1:43210'],
    ['https://client.example/callback?next=;script-src%20*', 'https://client.example'],
  ])('supports callback ports and excludes URL paths and queries: %s', async (uri, expectedOrigin) => {
    register(uri);
    const response = await authorize(request({ redirect_uri: uri }));
    expect(response.headers.get('content-security-policy')!.split('; ').find((v) => v.startsWith('form-action')))
      .toBe(`form-action 'self' ${expectedOrigin}`);
  });

  it('does not let a malformed registered hostname inject CSP directives', async () => {
    const uri = 'https://example.com;script-src/callback';
    register(uri);
    const response = await authorize(request({ redirect_uri: uri }));
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self';");
    expect(response.headers.get('content-security-policy')).not.toContain('script-src');
  });

  it('rejects unregistered callbacks without adding their origin to the error policy', async () => {
    const response = await authorize(request({ redirect_uri: 'https://unregistered.example/callback' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self';");
    expect(response.headers.get('content-security-policy')).not.toContain('unregistered.example');
    expect(issueOAuthAuthorizationCode).not.toHaveBeenCalled();
  });

  it('requires a paired browser session before showing consent', async () => {
    vi.mocked(resolveOAuthPairing).mockResolvedValue(undefined);
    const response = await authorize(request());
    expect(response.status).toBe(401);
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self';");
    expect(issueOAuthAuthorizationCode).not.toHaveBeenCalled();
  });

  it('returns a code and the original state only after Allow', async () => {
    const response = await authorize(request({ decision: 'allow' }, 'POST'));
    const callback = new URL(response.headers.get('location')!);
    expect(response.status).toBe(302);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('code')).toBe('test-code');
    expect(callback.searchParams.get('state')).toBe('test-state');
    expect(issueOAuthAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'test-client',
      redirectUri,
      sessionHash: 'test-session-hash',
      codeChallenge: 'a'.repeat(43),
    }));
  });

  it('returns access_denied and the original state on Cancel without issuing a code', async () => {
    const response = await authorize(request({ decision: 'deny' }, 'POST'));
    const callback = new URL(response.headers.get('location')!);
    expect(response.status).toBe(302);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe('test-state');
    expect(callback.searchParams.has('code')).toBe(false);
    expect(issueOAuthAuthorizationCode).not.toHaveBeenCalled();
  });
});
