import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('shot still capture scheduling', () => {
  it('stores optional companion views sequentially without an implicit projected download', () => {
    const source = readFileSync(
      new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('const snapshotPreview');
    const end = source.indexOf('const captureStill', start);
    const capture = source.slice(start, end);

    expect(capture).toContain('runSettledSequentially(companionJobs)');
    expect(capture).not.toContain('Promise.allSettled(companionJobs)');
    expect(capture).not.toContain('downloadDataUrl(');
  });
});
