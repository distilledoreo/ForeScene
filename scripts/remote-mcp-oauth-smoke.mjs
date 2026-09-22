import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const base = (process.argv[2] || 'https://forescene.distilledlabs.org').replace(/\/$/, '');
const resource = `${base}/mcp`;
let redirectUri = 'https://oauth-smoke.invalid/callback';
const useBrowser = process.argv.includes('--browser');

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
let browser;
let callbackServer;
let receivedCallback;

async function startCallbackServer() {
  callbackServer = createServer((req, res) => {
    const target = new URL(req.url, redirectUri);
    if (req.method !== 'GET' || target.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    receivedCallback = target;
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<h1>OAuth callback received</h1>');
  });
  await new Promise((resolve, reject) => {
    callbackServer.once('error', reject);
    callbackServer.listen(0, '127.0.0.1', resolve);
  });
  redirectUri = `http://127.0.0.1:${callbackServer.address().port}/callback`;
}

async function browserConsent(authorize, cookie) {
  const { chromium } = await import('@playwright/test');
  browser = await chromium.launch();
  const context = await browser.newContext();
  const separator = cookie.indexOf('=');
  await context.addCookies([{
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1),
    url: base,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const diagnostics = { policy: '', postStatus: null, failedRequests: [] };
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/oauth/authorize') {
      diagnostics.postStatus = response.status();
    }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    diagnostics.failedRequests.push({ url: url.origin + url.pathname, error: request.failure()?.errorText });
  });
  // Use a real loopback receiver: Playwright routes do not intercept the second
  // request in a redirect chain. No callback code leaves this test runner.
  let callback;
  for (const decision of ['Cancel', 'Allow']) {
    receivedCallback = undefined;
    const consent = await page.goto(authorize.toString());
    diagnostics.policy = consent.headers()['content-security-policy'];
    try {
      await page.getByRole('button', { name: decision, exact: true }).click();
      await page.waitForURL((url) => `${url.origin}${url.pathname}` === redirectUri, { timeout: 15_000 });
      await page.getByRole('heading', { name: 'OAuth callback received', exact: true }).waitFor();
    } catch {
      // Do not print browser errors or URLs containing authorization codes.
      fail(`${decision} did not reach the OAuth callback in Chromium.`, diagnostics);
    }
    callback = receivedCallback;
    if (!callback) fail(`${decision} callback was not received by the test server`);
    if (callback.searchParams.get('state') !== authorize.searchParams.get('state')) {
      fail(`${decision} callback state mismatch`);
    }
    if (decision === 'Cancel' && (
      callback.searchParams.get('error') !== 'access_denied' || callback.searchParams.has('code')
    )) fail('Cancel did not deny authorization');
  }
  return callback.toString();
}

try {
  if (useBrowser) await startCallbackServer();
  // This isolated read-only session has no paired ForeScene tab or project data.
  // Do not reuse a user's pairing cookie or relay token for this test.
  const sessionResponse = await fetch(`${base}/api/agent/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accessMode: 'read-only',
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
  authorize.searchParams.set('scope', 'forescene:read offline_access');
  authorize.searchParams.set('resource', resource);

  const consentResponse = await fetch(authorize, {
    headers: { cookie },
    redirect: 'manual',
  });
  const consentHtml = await consentResponse.text();
  if (consentResponse.status !== 200 || !consentHtml.includes('value="allow"')) {
    fail(`consent page failed (HTTP ${consentResponse.status})`, consentHtml.slice(0, 1000));
  }

  let location;
  if (useBrowser) {
    location = await browserConsent(authorize, cookie);
  } else {
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

    location = approvalResponse.headers.get('location');
  }
  if (!location) fail('consent approval redirect did not include Location');
  const callback = new URL(location);
  const code = callback.searchParams.get('code');
  if (!code) fail('authorization callback did not include code');
  if (callback.searchParams.get('state') !== state) {
    fail('authorization callback state mismatch');
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
  if (!tokens.access_token) fail('token exchange did not return access_token');
  if (!tokens.refresh_token) fail('offline_access grant did not return refresh_token');

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

  console.log(`ForeScene production OAuth smoke test passed${useBrowser ? ' (Chromium Allow + Cancel, PKCE, MCP initialize)' : ''}.`);
} finally {
  await browser?.close().catch(() => undefined);
  if (callbackServer) await new Promise((resolve) => callbackServer.close(resolve));
  if (relayToken) {
    await fetch(`${base}/api/agent/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${relayToken}` },
    }).catch(() => undefined);
  }
}
