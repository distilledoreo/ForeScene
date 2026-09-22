import {
  FORESCENE_READ_SCOPE,
  FORESCENE_WRITE_SCOPE,
  issueOAuthAuthorizationCode,
  normalizeOAuthScopes,
  readOAuthClient,
  resolveOAuthPairing,
} from '../lib/oauthStore.ts';

interface AuthorizationRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  scope?: string;
  decision?: string;
  resource: string;
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  });
}

function errorPage(title: string, message: string, status = 400): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)} · ForeScene</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#111318; color:#f6f7fb; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; }
  main { width:min(560px,100%); box-sizing:border-box; padding:28px; border:1px solid #30343c; border-radius:16px; background:#181b21; }
  h1 { margin:0 0 12px; font-size:22px; }
  p { margin:0; color:#b7bdc8; line-height:1.55; }
</style>
</head>
<body><main><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p></main></body>
</html>`, status);
}

async function parseRequest(req: Request): Promise<AuthorizationRequest | undefined> {
  const origin = new URL(req.url).origin;
  let params: URLSearchParams;
  if (req.method === 'GET') {
    params = new URL(req.url).searchParams;
  } else {
    params = new URLSearchParams(await req.text());
  }

  const responseType = params.get('response_type') ?? '';
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? '';
  if (!responseType || !clientId || !redirectUri || !codeChallenge || !codeChallengeMethod) {
    return undefined;
  }
  return {
    responseType,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    ...(params.get('state') ? { state: params.get('state')! } : {}),
    ...(params.get('scope') ? { scope: params.get('scope')! } : {}),
    ...(params.get('decision') ? { decision: params.get('decision')! } : {}),
    resource: params.get('resource') || `${origin}/mcp`,
  };
}

function redirectWithError(
  request: AuthorizationRequest,
  error: string,
  description: string,
): Response {
  const target = new URL(request.redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (request.state) target.searchParams.set('state', request.state);
  return Response.redirect(target.toString(), 302);
}

export default async (req: Request) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET, POST', 'cache-control': 'no-store' },
    });
  }

  const request = await parseRequest(req);
  if (!request) {
    return errorPage(
      'Invalid OAuth request',
      'The authorization request is missing required OAuth or PKCE parameters.',
    );
  }

  const origin = new URL(req.url).origin;
  const expectedResource = `${origin}/mcp`;
  const client = await readOAuthClient(request.clientId);
  if (!client) {
    return errorPage('Unknown OAuth client', 'Register this client before requesting authorization.');
  }
  if (!client.redirectUris.includes(request.redirectUri)) {
    return errorPage('Invalid redirect URI', 'The OAuth redirect URI does not match the registered client.');
  }
  if (
    request.responseType !== 'code'
    || request.codeChallengeMethod !== 'S256'
    || request.codeChallenge.length < 43
  ) {
    return redirectWithError(
      request,
      'invalid_request',
      'ForeScene requires response_type=code and PKCE S256.',
    );
  }
  if (request.resource !== expectedResource) {
    return redirectWithError(
      request,
      'invalid_target',
      'This authorization server only issues tokens for the ForeScene MCP resource.',
    );
  }

  const pairing = await resolveOAuthPairing(req);
  if (!pairing) {
    return errorPage(
      'Connect ForeScene first',
      'Open ForeScene in this browser, choose Remote MCP Connection, and enable a connection. Then restart the ChatGPT connection flow.',
      401,
    );
  }

  const scopes = normalizeOAuthScopes(request.scope, pairing.session.accessMode);
  if (!scopes) {
    return redirectWithError(
      request,
      'invalid_scope',
      'The requested OAuth scope is not supported.',
    );
  }

  if (req.method === 'POST') {
    if (request.decision !== 'allow') {
      return redirectWithError(
        request,
        'access_denied',
        'The ForeScene connection request was denied.',
      );
    }

    const code = await issueOAuthAuthorizationCode({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes,
      sessionHash: pairing.sessionHash,
      resource: request.resource,
    });
    const target = new URL(request.redirectUri);
    target.searchParams.set('code', code);
    if (request.state) target.searchParams.set('state', request.state);
    return Response.redirect(target.toString(), 302);
  }

  const clientName = client.clientName || 'MCP client';
  const scopeRows = [
    scopes.includes(FORESCENE_READ_SCOPE)
      ? '<li><strong>Read and preview</strong><span>Inspect, query, validate, capture, render, and preview scripts.</span></li>'
      : '',
    scopes.includes(FORESCENE_WRITE_SCOPE)
      ? '<li><strong>Edit the project</strong><span>Apply an explicitly previewed ForeScene plan.</span></li>'
      : '',
  ].filter(Boolean).join('');

  const hidden = [
    ['response_type', request.responseType],
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', request.codeChallengeMethod],
    ['resource', request.resource],
    ...(request.state ? [['state', request.state]] : []),
    ...(request.scope ? [['scope', request.scope]] : []),
  ].map(([name, value]) => (
    `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`
  )).join('');

  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ForeScene</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#111318; color:#f6f7fb; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; }
  main { width:min(600px,100%); padding:28px; border:1px solid #30343c; border-radius:18px; background:#181b21; box-shadow:0 20px 60px #0006; }
  .eyebrow { color:#8d96a7; font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
  h1 { margin:7px 0 8px; font-size:24px; }
  p { color:#b7bdc8; line-height:1.55; }
  .project { margin:20px 0; padding:14px 16px; border:1px solid #30343c; border-radius:12px; background:#12151a; }
  .project strong { display:block; color:#f6f7fb; }
  .project span { color:#929aaa; font-size:13px; }
  ul { list-style:none; padding:0; margin:18px 0; display:grid; gap:10px; }
  li { padding:13px 14px; border:1px solid #30343c; border-radius:12px; }
  li strong, li span { display:block; }
  li span { margin-top:4px; color:#9ea6b5; font-size:13px; line-height:1.45; }
  form { display:flex; gap:10px; margin-top:22px; }
  button { appearance:none; border:1px solid #3a404b; border-radius:10px; padding:10px 16px; font:inherit; font-weight:650; cursor:pointer; color:#f6f7fb; background:#232730; }
  button.primary { background:#6d5dfc; border-color:#6d5dfc; }
  .note { margin-top:16px; font-size:12px; color:#7f8795; }
</style>
</head>
<body>
<main>
  <div class="eyebrow">ForeScene Remote MCP</div>
  <h1>Allow ${htmlEscape(clientName)} to use this ForeScene tab?</h1>
  <p>The client will be linked only to the temporary browser session shown below. Your project remains in this browser tab.</p>
  <div class="project">
    <strong>${htmlEscape(pairing.session.projectName || 'Current ForeScene project')}</strong>
    <span>${htmlEscape(pairing.session.accessMode)} · expires ${htmlEscape(new Date(pairing.session.expiresAt).toLocaleString('en-US'))}</span>
  </div>
  <ul>${scopeRows}</ul>
  <form method="post" action="/oauth/authorize">
    ${hidden}
    <button type="submit" name="decision" value="deny">Cancel</button>
    <button class="primary" type="submit" name="decision" value="allow">Allow</button>
  </form>
  <div class="note">Disconnecting the Remote MCP Connection in ForeScene immediately makes this authorization unusable.</div>
</main>
</body>
</html>`);
};

export const config = {
  path: '/oauth/authorize',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
