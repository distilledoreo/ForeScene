import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { inspectBenchmarkArtifact } from '../scripts/benchmark/artifactEvidence';

describe('benchmark artifact evidence', () => {
  it('rejects arbitrary bytes even when they exceed the size threshold', async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-artifact-'));
    const filePath = path.join(runRoot, 'fake.png');
    await writeFile(filePath, Buffer.alloc(2048, 7));
    const evidence = await inspectBenchmarkArtifact({ runRoot, filePath, kind: 'png', minBytes: 1024 });
    expect(evidence.valid).toBe(false);
  });

  it('parses semantic identity from a valid FSP archive', async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-artifact-'));
    const filePath = path.join(runRoot, 'project.fsp');
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify({
      id: 'project_fixture',
      scene: { objects: [{ id: 'cast', type: 'human_dummy' }] },
      shots: [{ id: 'shot_fixture' }],
      assets: { assets: {} },
    }));
    zip.file('integrity.json', '{}');
    await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const evidence = await inspectBenchmarkArtifact({ runRoot, filePath, kind: 'fsp', minBytes: 10 });
    expect(evidence.valid).toBe(true);
    expect(evidence.projectSnapshot).toEqual({
      projectId: 'project_fixture',
      shotIds: ['shot_fixture'],
      castCount: 1,
      assetCount: 0,
      importedModelCount: 0,
    });
  });
});
