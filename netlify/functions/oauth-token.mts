import {
  exchangeOAuthAuthorizationCode,
  refreshOAuthAccessToken,
} from '../lib/oauthStore.ts';

async function readBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(body)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function tokenError(
  error: 'invalid_request' | 'invalid_grant' | 'unsupported_grant_type',
  description: string,
): Response {
  return Response.json({
    error,
    error_description: description,
  }, {
    status: 400,
    headers: { 'cache-control': 'no-store' },
  });
}

export default async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'POST', 'cache-control': 'no-store' },
    });
  }

  const body = await readBody(req);
  const origin = new URL(req.url).origin;
  const resource = body.resource || `${origin}/mcp`;

  if (body.grant_type === 'authorization_code') {
    if (
      !body.code
      || !body.client_id
      || !body.redirect_uri
      || !body.code_verifier
    ) {
      return tokenError(
        'invalid_request',
        'code, client_id, redirect_uri, and code_verifier are required.',
      );
    }
    const tokenSet = await exchangeOAuthAuthorizationCode({
      code: body.code,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
      resource,
    });
    if (!tokenSet) {
      return tokenError('invalid_grant', 'Authorization code exchange failed.');
    }
    return Response.json(tokenSet, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token || !body.client_id) {
      return tokenError(
        'invalid_request',
        'refresh_token and client_id are required.',
      );
    }
    const tokenSet = await refreshOAuthAccessToken({
      refreshToken: body.refresh_token,
      clientId: body.client_id,
      requestedScope: body.scope,
      resource,
    });
    if (!tokenSet) {
      return tokenError('invalid_grant', 'Refresh token exchange failed.');
    }
    return Response.json(tokenSet, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  return tokenError(
    'unsupported_grant_type',
    'Use authorization_code or refresh_token.',
  );
};

export const config = {
  path: '/oauth/token',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
