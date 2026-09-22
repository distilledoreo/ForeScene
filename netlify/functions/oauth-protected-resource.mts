import {
  FORESCENE_READ_SCOPE,
  FORESCENE_WRITE_SCOPE,
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
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [FORESCENE_READ_SCOPE, FORESCENE_WRITE_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'ForeScene Remote MCP',
  }, {
    headers: {
      'cache-control': 'public, max-age=300',
      'content-type': 'application/json',
    },
  });
};

export const config = {
  path: '/.well-known/oauth-protected-resource',
};
