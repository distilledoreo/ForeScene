import { describe, expect, it } from 'vitest';
import { resolveAgentBrowserProxy } from '../scripts/agent/browserProxy';

describe('agent browser environment proxy', () => {
  it('leaves the browser unconfigured when no applicable proxy is supplied', () => {
    expect(resolveAgentBrowserProxy('https://forescene.example', {})).toBeUndefined();
    expect(resolveAgentBrowserProxy('https://forescene.example', { HTTP_PROXY: 'http://http-only.example:3128' })).toBeUndefined();
    expect(resolveAgentBrowserProxy('http://localhost:3000', { HTTPS_PROXY: 'http://https-only.example:3128' })).toBeUndefined();
  });

  it('prefers lowercase scheme-specific variables over uppercase and ALL_PROXY', () => {
    const env = {
      https_proxy: ' http://lowercase.example:3128 ',
      HTTPS_PROXY: 'http://uppercase.example:3128',
      HTTP_PROXY: 'http://http-only.example:3128',
      ALL_PROXY: 'socks5://fallback.example:1080',
    };
    expect(resolveAgentBrowserProxy('https://forescene.example', env)).toEqual({ server: 'http://lowercase.example:3128' });
    expect(resolveAgentBrowserProxy('http://forescene.example', env)).toEqual({ server: 'http://http-only.example:3128' });
    expect(env.https_proxy).toBe(' http://lowercase.example:3128 ');
  });

  it('falls back from empty variables and accepts bare HTTP proxy hosts', () => {
    expect(resolveAgentBrowserProxy('https://forescene.example', {
      https_proxy: '  ', HTTPS_PROXY: 'proxy.example:3128',
    })).toEqual({ server: 'http://proxy.example:3128' });
    expect(resolveAgentBrowserProxy('https://forescene.example', {
      all_proxy: 'socks5://fallback.example:1080', ALL_PROXY: 'http://ignored.example:3128',
    })).toEqual({ server: 'socks5://fallback.example:1080' });
  });

  it('preserves bypass rules for local navigation and remote assets in the same context', () => {
    expect(resolveAgentBrowserProxy('http://localhost:3000', {
      HTTP_PROXY: 'http://proxy.example:3128',
      no_proxy: 'localhost, 127.0.0.1 [::1],.internal.example,service.example:8080',
      NO_PROXY: '*',
    })).toEqual({
      server: 'http://proxy.example:3128',
      bypass: 'localhost,127.0.0.1,[::1],.internal.example,service.example:8080',
    });
  });

  it.each(['*', 'localhost, *'])('disables the proxy for a universal NO_PROXY rule: %s', (NO_PROXY) => {
    expect(resolveAgentBrowserProxy('https://forescene.example', {
      HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY,
    })).toBeUndefined();
  });

  it('extracts decoded HTTP credentials without placing them in the proxy server string', () => {
    expect(resolveAgentBrowserProxy('https://forescene.example', {
      HTTPS_PROXY: 'http://user%40name:p%3Ass%2Fword@[::1]:3128',
    })).toEqual({ server: 'http://[::1]:3128', username: 'user@name', password: 'p:ss/word' });
    expect(resolveAgentBrowserProxy('https://forescene.example', {
      HTTPS_PROXY: 'https://username@proxy.example:8443',
    })).toEqual({ server: 'https://proxy.example:8443', username: 'username', password: '' });
  });

  it.each([
    'http://user:private-value@bad-host:99999',
    'ftp://user:private-value@proxy.example',
    'socks4://user:private-value@proxy.example:1080',
    'socks5://user:private-value@proxy.example:1080',
    'http://user:private-value%@proxy.example:3128',
    'http://user:private-value@proxy.example:3128/path',
    'http://user:private-value@proxy.example:3128?query',
    'http://user:private-value@proxy.example:3128#fragment',
  ])('rejects unsupported or malformed configuration without exposing its value', (configured) => {
    let error: unknown;
    try {
      resolveAgentBrowserProxy('https://forescene.example', { HTTPS_PROXY: configured });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('private-value');
    expect((error as Error).message).not.toContain(configured);
  });
});
