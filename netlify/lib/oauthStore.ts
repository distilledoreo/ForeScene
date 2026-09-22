import { createHash, randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import {
  readRemoteAgentSessionByHash,
  type RemoteAgentAccessMode,
  type RemoteAgentSession,
} from './remoteAgentStore.ts';

export const FORESCENE_READ_SCOPE = 'forescene:read' as const;
export const FORESCENE_WRITE_SCOPE = 'forescene:write' as const;
export const OFFLINE_ACCESS_SCOPE = 'offline_access' as const;
export type ForeSceneOAuthScope =
  | typeof FORESCENE_READ_SCOPE
  | typeof FORESCENE_WRITE_SCOPE
  | typeof OFFLINE_ACCESS_SCOPE;

export interface OAuthClientRegistration {
  version: 1;
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

interface OAuthPairing {
  version: 1;
  sessionHash: string;
  expiresAt: string;
}

interface OAuthAuthorizationCode {
  version: 1;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: ForeSceneOAuthScope[];
  sessionHash: string;
  resource: string;
  expiresAt: string;
}

interface OAuthAccessGrant {
  version: 1;
  clientId: string;
  sessionHash: string;
  scopes: ForeSceneOAuthScope[];
  resource: string;
  createdAt: string;
  expiresAt: string;
}

interface OAuthRefreshGrant {
  version: 1;
  clientId: string;
  sessionHash: string;
  scopes: ForeSceneOAuthScope[];
  resource: string;
  createdAt: string;
  expiresAt: string;
}

export interface OAuthMcpAuthentication {
  clientId: string;
  sessionHash: string;
  session: RemoteAgentSession;
  scopes: Set<ForeSceneOAuthScope>;
  resource: string;
}

export interface OAuthTokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const STORE_NAME = 'forescene-oauth';
const PAIRING_COOKIE = '__Host-forescene-mcp-pairing';
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function store() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenKey(kind: 'pairing' | 'code' | 'access' | 'refresh', token: string): string {
  return `${kind}/${sha256(token)}`;
}

function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function isExpired(expiresAt: string): boolean {
  return Date.parse(expiresAt) <= Date.now();
}

function scopeString(scopes: ForeSceneOAuthScope[]): string {
  return [...scopes].sort().join(' ');
}

function bearerToken(req: Request): string | undefined {
  const authorization = req.headers.get('authorization')?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookie = req.headers.get('cookie');
  if (!cookie) return undefined;
  for (const entry of cookie.split(';')) {
    const [rawName, ...rest] = entry.trim().split('=');
    if (rawName === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function safeRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function normalizeOAuthScopes(
  rawScope: string | undefined,
  accessMode: RemoteAgentAccessMode,
): ForeSceneOAuthScope[] | undefined {
  const requested = rawScope?.trim()
    ? [...new Set(rawScope.trim().split(/\s+/))]
    : accessMode === 'read-write'
      ? [FORESCENE_READ_SCOPE, FORESCENE_WRITE_SCOPE, OFFLINE_ACCESS_SCOPE]
      : [FORESCENE_READ_SCOPE, OFFLINE_ACCESS_SCOPE];

  if (requested.some((scope) => (
    scope !== FORESCENE_READ_SCOPE
    && scope !== FORESCENE_WRITE_SCOPE
    && scope !== OFFLINE_ACCESS_SCOPE
  ))) {
    return undefined;
  }
  const permitted = requested.filter(
    (scope) => scope !== FORESCENE_WRITE_SCOPE || accessMode === 'read-write',
  );
  if (!permitted.includes(FORESCENE_READ_SCOPE)) {
    permitted.unshift(FORESCENE_READ_SCOPE);
  }
  return permitted as ForeSceneOAuthScope[];
}

export async function registerOAuthClient(input: {
  redirectUris: string[];
  clientName?: string;
}): Promise<OAuthClientRegistration> {
  const redirectUris = [...new Set(input.redirectUris.map((uri) => uri.trim()).filter(Boolean))];
  if (redirectUris.length === 0 || redirectUris.some((uri) => !safeRedirectUri(uri))) {
    throw new Error('At least one valid HTTPS redirect_uri is required.');
  }

  const client: OAuthClientRegistration = {
    version: 1,
    clientId: randomToken('fs_oauth_client_', 24),
    ...(input.clientName?.trim() ? { clientName: input.clientName.trim().slice(0, 160) } : {}),
    redirectUris,
    createdAt: new Date().toISOString(),
  };
  await store().setJSON(`client/${client.clientId}`, client, { onlyIfNew: true });
  return client;
}

export async function readOAuthClient(
  clientId: string,
): Promise<OAuthClientRegistration | undefined> {
  const client = await store().get(`client/${clientId}`, {
    type: 'json',
    consistency: 'strong',
  }) as OAuthClientRegistration | null;
  return client ?? undefined;
}

export async function createOAuthPairing(
  sessionHash: string,
  sessionExpiresAt: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken('fs_pair_', 24);
  const expiresAtMs = Math.min(
    Date.parse(sessionExpiresAt),
    Date.now() + MAX_REFRESH_TOKEN_TTL_MS,
  );
  const pairing: OAuthPairing = {
    version: 1,
    sessionHash,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  await store().setJSON(tokenKey('pairing', token), pairing, { onlyIfNew: true });
  return { token, expiresAt: pairing.expiresAt };
}

export function oauthPairingCookie(token: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return [
    `${PAIRING_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export function clearOAuthPairingCookie(): string {
  return [
    `${PAIRING_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export async function resolveOAuthPairing(
  req: Request,
): Promise<{ sessionHash: string; session: RemoteAgentSession } | undefined> {
  const token = cookieValue(req, PAIRING_COOKIE);
  if (!token) return undefined;
  const key = tokenKey('pairing', token);
  const pairing = await store().get(key, {
    type: 'json',
    consistency: 'strong',
  }) as OAuthPairing | null;
  if (!pairing) return undefined;
  if (isExpired(pairing.expiresAt)) {
    await store().delete(key);
    return undefined;
  }
  const session = await readRemoteAgentSessionByHash(pairing.sessionHash);
  if (!session) return undefined;
  return { sessionHash: pairing.sessionHash, session };
}

export async function issueOAuthAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ForeSceneOAuthScope[];
  sessionHash: string;
  resource: string;
}): Promise<string> {
  const code = randomToken('fs_oauth_code_', 32);
  const grant: OAuthAuthorizationCode = {
    version: 1,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: 'S256',
    scopes: input.scopes,
    sessionHash: input.sessionHash,
    resource: input.resource,
    expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
  };
  await store().setJSON(tokenKey('code', code), grant, { onlyIfNew: true });
  return code;
}

async function issueOAuthTokenSet(input: {
  clientId: string;
  sessionHash: string;
  scopes: ForeSceneOAuthScope[];
  resource: string;
  session: RemoteAgentSession;
}): Promise<OAuthTokenSet> {
  const now = Date.now();
  const sessionExpiry = Date.parse(input.session.expiresAt);
  const accessExpiresAtMs = Math.min(now + ACCESS_TOKEN_TTL_MS, sessionExpiry);
  const refreshExpiresAtMs = Math.min(now + MAX_REFRESH_TOKEN_TTL_MS, sessionExpiry);
  if (accessExpiresAtMs <= now || refreshExpiresAtMs <= now) {
    throw new Error('The linked ForeScene browser session has expired.');
  }

  const accessToken = randomToken('fs_oauth_at_', 32);
  const refreshToken = randomToken('fs_oauth_rt_', 32);
  const access: OAuthAccessGrant = {
    version: 1,
    clientId: input.clientId,
    sessionHash: input.sessionHash,
    scopes: input.scopes,
    resource: input.resource,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(accessExpiresAtMs).toISOString(),
  };
  const refresh: OAuthRefreshGrant = {
    version: 1,
    clientId: input.clientId,
    sessionHash: input.sessionHash,
    scopes: input.scopes,
    resource: input.resource,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(refreshExpiresAtMs).toISOString(),
  };
  await Promise.all([
    store().setJSON(tokenKey('access', accessToken), access, { onlyIfNew: true }),
    store().setJSON(tokenKey('refresh', refreshToken), refresh, { onlyIfNew: true }),
  ]);

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor((accessExpiresAtMs - now) / 1000)),
    refresh_token: refreshToken,
    scope: scopeString(input.scopes),
  };
}

export async function exchangeOAuthAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}): Promise<OAuthTokenSet | undefined> {
  const key = tokenKey('code', input.code);
  const grant = await store().get(key, {
    type: 'json',
    consistency: 'strong',
  }) as OAuthAuthorizationCode | null;
  if (!grant) return undefined;

  // Authorization codes are single-use even when the exchange is malformed.
  await store().delete(key);
  if (isExpired(grant.expiresAt)) return undefined;
  if (
    grant.clientId !== input.clientId
    || grant.redirectUri !== input.redirectUri
    || grant.resource !== input.resource
  ) {
    return undefined;
  }
  const computedChallenge = createHash('sha256')
    .update(input.codeVerifier)
    .digest('base64url');
  if (computedChallenge !== grant.codeChallenge) return undefined;

  const session = await readRemoteAgentSessionByHash(grant.sessionHash);
  if (!session) return undefined;
  return issueOAuthTokenSet({
    clientId: grant.clientId,
    sessionHash: grant.sessionHash,
    scopes: grant.scopes,
    resource: grant.resource,
    session,
  });
}

export async function refreshOAuthAccessToken(input: {
  refreshToken: string;
  clientId: string;
  requestedScope?: string;
  resource: string;
}): Promise<OAuthTokenSet | undefined> {
  const key = tokenKey('refresh', input.refreshToken);
  const grant = await store().get(key, {
    type: 'json',
    consistency: 'strong',
  }) as OAuthRefreshGrant | null;
  if (!grant) return undefined;
  if (
    isExpired(grant.expiresAt)
    || grant.clientId !== input.clientId
    || grant.resource !== input.resource
  ) {
    await store().delete(key);
    return undefined;
  }

  const session = await readRemoteAgentSessionByHash(grant.sessionHash);
  if (!session) {
    await store().delete(key);
    return undefined;
  }

  let scopes = grant.scopes;
  if (input.requestedScope?.trim()) {
    const requested = normalizeOAuthScopes(input.requestedScope, session.accessMode);
    if (!requested || requested.some((scope) => !grant.scopes.includes(scope))) return undefined;
    scopes = requested;
  }

  // Rotate refresh tokens on every successful refresh.
  await store().delete(key);
  return issueOAuthTokenSet({
    clientId: grant.clientId,
    sessionHash: grant.sessionHash,
    scopes,
    resource: grant.resource,
    session,
  });
}

export async function authenticateOAuthMcpRequest(
  req: Request,
): Promise<OAuthMcpAuthentication | undefined> {
  const token = bearerToken(req);
  if (!token) return undefined;
  const key = tokenKey('access', token);
  const grant = await store().get(key, {
    type: 'json',
    consistency: 'strong',
  }) as OAuthAccessGrant | null;
  if (!grant) return undefined;
  if (isExpired(grant.expiresAt)) {
    await store().delete(key);
    return undefined;
  }
  const requestResource = `${new URL(req.url).origin}/mcp`;
  if (grant.resource !== requestResource) return undefined;

  const session = await readRemoteAgentSessionByHash(grant.sessionHash);
  if (!session) return undefined;
  return {
    clientId: grant.clientId,
    sessionHash: grant.sessionHash,
    session,
    scopes: new Set(grant.scopes),
    resource: grant.resource,
  };
}
