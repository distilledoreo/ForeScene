import {
  FORESCENE_READ_SCOPE,
  FORESCENE_WRITE_SCOPE,
  OFFLINE_ACCESS_SCOPE,
} from '../lib/oauthStore.ts';

export default async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET', 'cache-control': 'no-store' },
    });
  }

  const origin = new URL(req.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    resource_indicators_supported: true,
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [FORESCENE_READ_SCOPE, FORESCENE_WRITE_SCOPE, OFFLINE_ACCESS_SCOPE],
  }, {
    headers: {
      'cache-control': 'public, max-age=300',
      'content-type': 'application/json',
    },
  });
};

export const config = {
  path: '/.well-known/oauth-authorization-server',
};
