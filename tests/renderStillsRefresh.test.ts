import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInitialRunState } from '../src/engine/previs/runState';
const mock = vi.hoisted(() => ({ close: vi.fn(), evaluate: vi.fn() }));
vi.mock('../scripts/agent/browser', () => ({ openAgentBrowser: vi.fn(async () => ({ page: { evaluate: mock.evaluate }, close: mock.close })), waitForAgentIdle: vi.fn() }));
vi.mock('../scripts/agent/screenshot', () => ({ openWorkspace: vi.fn(), captureSceneScreenshot: vi.fn() }));
import { runRenderStillsCli } from '../scripts/agent/previs';
let dir: string;
let calls: number;
let interrupt = false;
let projectId = 'project';
let missing = false;
let invalidated: unknown;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'stills-refresh-')); calls = 0; interrupt = false; missing = false; projectId = 'project'; invalidated = undefined;
  const state = createInitialRunState({ manifestHash: 'hash', projectId, shotNumbers: ['01', '02'] });
  for (const [n, row] of Object.entries(state.shots)) Object.assign(row, { compile: 'complete', render: 'complete', shotId: `shot${n}`, framePath: path.join(dir, `${n}.png`), renderSource: 'canonical_clay_renderer', renderFingerprint: 'old' });
  await writeFile(path.join(dir, 'run-state.json'), JSON.stringify(state));
  mock.evaluate.mockImplementation(async (fn, arg) => {
    const source = String(fn);
    if (source.includes('getProjectDocument')) return { id: projectId, shots: missing ? [] : [{ id: 'shot01', shotNumber: '01' }, { id: 'shot02', shotNumber: '02' }] };
    if (source.includes('renderShotFrame')) {
      calls++; invalidated = JSON.parse(await readFile(path.join(dir, 'run-state.json'), 'utf8'));
      if (interrupt) throw new Error('interrupted');
      return { ok: true, width: 1, height: 1, pngDataUrl: 'data:image/png;base64,aGVsbG8=', source: 'canonical_clay_renderer' };
    }
    return { ok: true };
  });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.clearAllMocks(); });
const run = () => runRenderStillsCli({ headless: true, writeAccess: true, persistWrite: true, outputDir: dir });
it('refreshes previously complete rows from the live project instead of counting cache as renders', async () => {
  const result = await run(); expect(result.ok).toBe(true); expect(result.framesRendered).toBe(2); expect(calls).toBe(2);
  const state = JSON.parse(await readFile(path.join(dir, 'run-state.json'), 'utf8'));
  expect(state.shots['01'].renderFingerprint).toBeUndefined();
  expect(await readFile(state.shots['01'].framePath, 'utf8')).toBe('hello');
});
it('invalidates unvisited rows before a render interruption', async () => {
  interrupt = true; await expect(run()).rejects.toThrow('interrupted');
  const state = invalidated as ReturnType<typeof createInitialRunState>;
  expect(state.shots['01'].render).toBe('pending'); expect(state.shots['02'].render).toBe('pending');
  expect(state.shots['02'].renderSource).toBeUndefined(); expect(mock.close).toHaveBeenCalled();
});
it('fails for missing tracked shots rather than trusting old complete state', async () => {
  missing = true; const result = await run(); expect(result.ok).toBe(false); expect(result.framesRendered).toBe(0);
});
it('rejects the wrong project before overwriting run state', async () => {
  projectId = 'other'; const before = await readFile(path.join(dir, 'run-state.json'), 'utf8');
  expect((await run()).ok).toBe(false); expect(await readFile(path.join(dir, 'run-state.json'), 'utf8')).toBe(before);
});
