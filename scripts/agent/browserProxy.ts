import type { LaunchOptions } from '@playwright/test';

export type AgentBrowserProxy = NonNullable<LaunchOptions['proxy']>;

function proxyEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  return env[name.toLowerCase()]?.trim() || env[name.toUpperCase()]?.trim() || '';
}

/**
 * Explicit browser proxy settings: Chromium does not inherit Node's proxy agent.
 * Follow proxy-from-env precedence (lowercase, scheme-specific, then ALL_PROXY).
 * A context handles redirects and asset requests too, so NO_PROXY stays a browser
 * bypass list rather than disabling its proxy when only the initial URL matches.
 */
export function resolveAgentBrowserProxy(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentBrowserProxy | undefined {
  const bypassEntries = proxyEnvironmentValue(env, 'no_proxy').split(/[,\s]+/).filter(Boolean);
  if (bypassEntries.includes('*')) return undefined;

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error('Agent browser target URL is invalid.');
  }
  const scheme = target.protocol.slice(0, -1);
  const configured = proxyEnvironmentValue(env, `${scheme}_proxy`) || proxyEnvironmentValue(env, 'all_proxy');
  if (!configured) return undefined;

  let proxyUrl: URL;
  try {
    // Playwright documents a bare host:port as an HTTP proxy, including for HTTPS targets.
    proxyUrl = new URL(configured.includes('://') ? configured : `http://${configured}`);
  } catch {
    // Never include the supplied value or URL parser error: either can contain credentials.
    throw new Error('Agent browser proxy URL is invalid.');
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxyUrl.protocol) || !proxyUrl.hostname) {
    throw new Error('Agent browser proxy must use HTTP, HTTPS, SOCKS4, or SOCKS5.');
  }
  if ((proxyUrl.pathname && proxyUrl.pathname !== '/') || proxyUrl.search || proxyUrl.hash) {
    throw new Error('Agent browser proxy URL cannot include a path, query, or fragment.');
  }
  const hasCredentials = Boolean(proxyUrl.username || proxyUrl.password);
  if (hasCredentials && proxyUrl.protocol.startsWith('socks')) {
    throw new Error('Chromium does not support authenticated SOCKS proxies.');
  }

  let username: string | undefined;
  let password: string | undefined;
  if (hasCredentials) {
    try {
      username = decodeURIComponent(proxyUrl.username);
      password = decodeURIComponent(proxyUrl.password);
    } catch {
      throw new Error('Agent browser proxy credentials contain invalid percent encoding.');
    }
    if (!username) throw new Error('Agent browser HTTP proxy credentials require a username.');
  }
  return {
    server: `${proxyUrl.protocol}//${proxyUrl.host}`,
    ...(bypassEntries.length > 0 ? { bypass: bypassEntries.join(',') } : {}),
    ...(hasCredentials ? { username, password } : {}),
  };
}
