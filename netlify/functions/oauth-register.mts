import { registerOAuthClient } from '../lib/oauthStore.ts';

interface DynamicClientRegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
}

function invalidClientMetadata(message: string): Response {
  return Response.json({
    error: 'invalid_client_metadata',
    error_description: message,
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

  const body = await req.json().catch(() => undefined) as DynamicClientRegistrationRequest | undefined;
  if (!body || !Array.isArray(body.redirect_uris)) {
    return invalidClientMetadata('redirect_uris is required.');
  }
  const redirectUris = body.redirect_uris.filter(
    (value): value is string => typeof value === 'string',
  );
  if (redirectUris.length !== body.redirect_uris.length) {
    return invalidClientMetadata('Every redirect_uri must be a string.');
  }

  if (
    body.token_endpoint_auth_method !== undefined
    && body.token_endpoint_auth_method !== 'none'
  ) {
    return invalidClientMetadata('ForeScene supports public OAuth clients with token_endpoint_auth_method=none.');
  }

  if (
    Array.isArray(body.response_types)
    && body.response_types.some((value) => value !== 'code')
  ) {
    return invalidClientMetadata('Only response_type=code is supported.');
  }
  if (
    Array.isArray(body.grant_types)
    && body.grant_types.some(
      (value) => value !== 'authorization_code' && value !== 'refresh_token',
    )
  ) {
    return invalidClientMetadata('Only authorization_code and refresh_token grants are supported.');
  }

  try {
    const client = await registerOAuthClient({
      redirectUris,
      ...(typeof body.client_name === 'string' ? { clientName: body.client_name } : {}),
    });
    return Response.json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, {
      status: 201,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return invalidClientMetadata(
      error instanceof Error ? error.message : 'Client registration failed.',
    );
  }
};

export const config = {
  path: '/oauth/register',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
