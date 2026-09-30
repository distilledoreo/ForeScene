import { beforeEach, describe, expect, it, vi } from 'vitest';
import mcp from '../netlify/functions/mcp.mts';
import {
  authenticateOAuthMcpRequest,
  FORESCENE_READ_SCOPE,
} from '../netlify/lib/oauthStore';
import {
  RemoteAgentRelayError,
  runRemoteBrowserCommandBySessionHash,
} from '../netlify/lib/remoteAgentStore';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { listObjectsSnapshot } from '../src/engine/agent/inspection';
import { inspectSceneSpatially } from '../src/engine/agent/spatialAuthoring';

vi.mock('../netlify/lib/oauthStore.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../netlify/lib/oauthStore')>(),
  authenticateOAuthMcpRequest: vi.fn(),
}));

vi.mock('../netlify/lib/remoteAgentStore.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../netlify/lib/remoteAgentStore')>(),
  runRemoteBrowserCommandBySessionHash: vi.fn(),
}));

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await mcp(new Request('https://forescene.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ jsonrpc: '2.0', id: 7 });
  expect(body.error).toBeUndefined();
  // MCP CallToolResult requires a JSON object, not an array, scalar, or null.
  expect(body.result.structuredContent).not.toBeNull();
  expect(typeof body.result.structuredContent).toBe('object');
  expect(Array.isArray(body.result.structuredContent)).toBe(false);
  return body.result;
}

function expectJsonText(result: Awaited<ReturnType<typeof callTool>>) {
  expect(result.content[0].type).toBe('text');
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  expect(result.isError).not.toBe(true);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticateOAuthMcpRequest).mockResolvedValue({
    clientId: 'test-client',
    sessionHash: 'test-session-hash',
    resource: 'https://forescene.example/mcp',
    scopes: new Set([FORESCENE_READ_SCOPE]),
    session: {
      version: 1,
      sessionId: 'test-session',
      projectName: 'Test project',
      accessMode: 'read-only',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
});

describe('MCP tool-result serialization', () => {
  it.each(['Book', 'Missing'])('wraps scene_query arrays, including no matches: %s', async (name) => {
    const project = createDefaultProject();
    const book = createSceneObject('box', 1);
    book.name = 'Book cover';
    project.scene.objects = [book];
    const query = { name, match: 'contains' as const };
    const objects = listObjectsSnapshot(project, query);
    vi.mocked(runRemoteBrowserCommandBySessionHash).mockResolvedValue(objects);

    const result = await callTool('scene_query', query);

    expect(result.structuredContent).toEqual({ result: objects });
    expectJsonText(result);
    expect(runRemoteBrowserCommandBySessionHash).toHaveBeenCalledExactlyOnceWith(
      'test-session-hash', 'scene.query', { query }, { timeoutMs: 20_000 },
    );
  });

  it.each(['Book', 'Bench', 'Missing'])('wraps real scene_inspect results without changing the project: %s', async (name) => {
    const project = createDefaultProject();
    const book = createSceneObject('box', 1);
    book.name = 'Book cover';
    const bench = createSceneObject('box', 2);
    bench.name = 'Bench seat';
    project.scene.objects = [book, bench];
    const before = structuredClone(project);
    const query = { name, match: 'contains' as const };
    vi.mocked(runRemoteBrowserCommandBySessionHash).mockResolvedValue(project);

    const result = await callTool('scene_inspect', query);

    expect(result.structuredContent).toEqual({ result: inspectSceneSpatially(project, query) });
    expect(result.structuredContent.result).toHaveLength(name === 'Missing' ? 0 : 1);
    expectJsonText(result);
    expect(project).toEqual(before);
    expect(runRemoteBrowserCommandBySessionHash).toHaveBeenCalledExactlyOnceWith(
      'test-session-hash', 'project.document', {}, { timeoutMs: 18_000 },
    );
  });

  it('preserves existing object-shaped project results without an extra wrapper', async () => {
    const snapshot = { id: 'project-1', objectCount: 245, shots: [{ id: 'shot-1' }] };
    vi.mocked(runRemoteBrowserCommandBySessionHash).mockResolvedValue(snapshot);

    const result = await callTool('project_inspect');

    expect(result.structuredContent).toEqual(snapshot);
    expectJsonText(result);
  });

  it.each([null, undefined, 'ready', 0, false])('normalizes other non-object results: %s', async (value) => {
    vi.mocked(runRemoteBrowserCommandBySessionHash).mockResolvedValue(value);

    const result = await callTool('project_inspect');

    expect(result.structuredContent).toEqual({ result: value ?? null });
    expectJsonText(result);
  });

  it('preserves scene_capture image blocks and structured metadata', async () => {
    const metadata = { view: 'top', width: 128, height: 128, mimeType: 'image/png' };
    vi.mocked(runRemoteBrowserCommandBySessionHash).mockResolvedValue({
      ...metadata,
      dataUrl: 'data:image/png;base64,dGVzdA==',
    });

    const result = await callTool('scene_capture', { view: 'top' });

    expect(result.structuredContent).toEqual(metadata);
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: 'image', data: 'dGVzdA==', mimeType: 'image/png' });
    expectJsonText(result);
  });

  it('preserves structured tool errors', async () => {
    vi.mocked(runRemoteBrowserCommandBySessionHash).mockRejectedValue(
      new RemoteAgentRelayError('browser_offline', 'The paired browser is offline.'),
    );

    const result = await callTool('project_inspect');

    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'browser_offline: The paired browser is offline.' }],
      structuredContent: {
        ok: false,
        error: { code: 'browser_offline', message: 'The paired browser is offline.' },
      },
    });
  });
});
