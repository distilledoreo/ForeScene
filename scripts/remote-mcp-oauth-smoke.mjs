import { createHash, randomBytes } from 'node:crypto';

const base = (process.argv[2] || 'https://forescene.distilledlabs.org').replace(/\/$/, '');
const resource = `${base}/mcp`;
const redirectUri = 'https://oauth-smoke.invalid/callback';

function fail(message, extra) {
  if (extra !== undefined) console.error(extra);
  throw new Error(message);
}

function pairingCookie(setCookie) {
  const match = setCookie?.match(/(__Host-forescene-mcp-pairing=[^;]+)/);
  return match?.[1];
}

async function json(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    fail(`${label} did not return JSON (HTTP ${response.status})`, text.slice(0, 1000));
  }
  if (!response.ok) fail(`${label} failed (HTTP ${response.status})`, parsed);
  return parsed;
}

let relayToken;

try {
  const sessionResponse = await fetch(`${base}/api/agent/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accessMode: 'read-write',
      projectId: 'oauth-smoke',
      projectName: 'OAuth Production Smoke Test',
    }),
    redirect: 'manual',
  });
  const cookie = pairingCookie(sessionResponse.headers.get('set-cookie'));
  const session = await json(sessionResponse, 'agent session');
  relayToken = session.token;
  if (!cookie) fail('agent session did not set the OAuth pairing cookie');

  const metadata = await json(
    await fetch(`${base}/.well-known/oauth-authorization-server`),
    'authorization server metadata',
  );
  if (metadata.authorization_endpoint !== `${base}/oauth/authorize`) {
    fail('unexpected authorization endpoint', metadata);
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    fail('authorization server does not advertise PKCE S256', metadata);
  }

  const registration = await json(
    await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: 'ForeScene OAuth smoke test',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
    'dynamic client registration',
  );
  if (!registration.client_id) fail('DCR response did not include client_id', registration);

  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', registration.client_id);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('scope', 'forescene:read forescene:write offline_access');
  authorize.searchParams.set('resource', resource);

  const consentResponse = await fetch(authorize, {
    headers: { cookie },
    redirect: 'manual',
  });
  const consentHtml = await consentResponse.text();
  if (consentResponse.status !== 200 || !consentHtml.includes('value="allow"')) {
    fail(`consent page failed (HTTP ${consentResponse.status})`, consentHtml.slice(0, 1000));
  }

  const form = new URLSearchParams(authorize.searchParams);
  form.set('decision', 'allow');
  const approvalResponse = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
  if (approvalResponse.status < 300 || approvalResponse.status >= 400) {
    fail(
      `consent approval did not redirect (HTTP ${approvalResponse.status})`,
      await approvalResponse.text(),
    );
  }

  const location = approvalResponse.headers.get('location');
  if (!location) fail('consent approval redirect did not include Location');
  const callback = new URL(location);
  const code = callback.searchParams.get('code');
  if (!code) fail('authorization callback did not include code', location);
  if (callback.searchParams.get('state') !== state) {
    fail('authorization callback state mismatch', location);
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  });
  const tokens = await json(
    await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    }),
    'authorization code exchange',
  );
  if (!tokens.access_token) fail('token exchange did not return access_token', tokens);
  if (!tokens.refresh_token) fail('offline_access grant did not return refresh_token', tokens);

  const mcpResponse = await fetch(resource, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'forescene-oauth-smoke', version: '1.0.0' },
      },
    }),
  });
  const mcp = await json(mcpResponse, 'authenticated MCP initialize');
  if (mcp?.result?.serverInfo?.name !== 'ForeScene Remote') {
    fail('unexpected MCP initialize response', mcp);
  }

  console.log('ForeScene production OAuth smoke test passed.');
} finally {
  if (relayToken) {
    await fetch(`${base}/api/agent/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${relayToken}` },
    }).catch(() => undefined);
  }
}
