import handler from './oauth-protected-resource.mts';

export default handler;

export const config = {
  path: '/.well-known/oauth-protected-resource/mcp',
};
