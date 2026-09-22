import { describe, expect, it } from 'vitest';
import {
  FORESCENE_READ_SCOPE,
  FORESCENE_WRITE_SCOPE,
  OFFLINE_ACCESS_SCOPE,
  normalizeOAuthScopes,
} from '../netlify/lib/oauthStore';

describe('ForeScene MCP OAuth scopes', () => {
  it('defaults read-only relay sessions to read plus refresh access', () => {
    expect(normalizeOAuthScopes(undefined, 'read-only')).toEqual([
      FORESCENE_READ_SCOPE,
      OFFLINE_ACCESS_SCOPE,
    ]);
  });

  it('defaults read-write relay sessions to read, write, and refresh access', () => {
    expect(normalizeOAuthScopes(undefined, 'read-write')).toEqual([
      FORESCENE_READ_SCOPE,
      FORESCENE_WRITE_SCOPE,
      OFFLINE_ACCESS_SCOPE,
    ]);
  });

  it('downscopes requested writes when the browser relay is read-only', () => {
    expect(normalizeOAuthScopes(
      `${FORESCENE_READ_SCOPE} ${FORESCENE_WRITE_SCOPE} ${OFFLINE_ACCESS_SCOPE}`,
      'read-only',
    )).toEqual([
      FORESCENE_READ_SCOPE,
      OFFLINE_ACCESS_SCOPE,
    ]);
  });

  it('rejects unknown scopes', () => {
    expect(normalizeOAuthScopes('forescene:admin', 'read-write')).toBeUndefined();
  });

  it('always includes read access when write is requested', () => {
    expect(normalizeOAuthScopes(FORESCENE_WRITE_SCOPE, 'read-write')).toEqual([
      FORESCENE_READ_SCOPE,
      FORESCENE_WRITE_SCOPE,
    ]);
  });
});
