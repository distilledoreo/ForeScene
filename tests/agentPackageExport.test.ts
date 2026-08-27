import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  cancelAgentPackageExport,
  exportAgentPackage,
  getAgentPackageExportProgress,
  resetAgentPackageExportControl,
} from '../src/engine/agent/packageExportControl';
import { buildAgentCapabilities } from '../src/engine/agent/capabilities';
import { projectFingerprint } from '../src/engine/agent/planDiff';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

vi.mock('../src/engine/packageExport', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/packageExport')>(
    '../src/engine/packageExport',
  );
  return {
    ...actual,
    buildMultiShotPackage: vi.fn(async (_project, shots, options) => {
      options?.onProgress?.({
        phase: 'packaging',
        progress: 0.5,
        currentShot: 1,
        totalShots: shots.length,
        message: 'Packaging…',
      });
      return {
        blob: new Blob(['zip'], { type: 'application/zip' }),
        fileName: 'agent-package.zip',
        manifestPaths: ['manifest.json'],
      };
    }),
    downloadBlob: vi.fn(),
  };
});

describe('agent package export control', () => {
  beforeEach(() => {
    resetAgentPackageExportControl();
    useAgentControlStore.setState({ controlMode: 'read-only' });
    const project = createDefaultProject();
    useProjectStore.setState({
      project,
      isExportingPackage: false,
      isRenderingGraybox: false,
    });
    useProjectSafetyStore.setState({
      criticalWrite: false,
      activeRevisionId: 'rev-active',
      flushProject: async () => ({
        project,
        revision: { id: 'rev-1' },
      } as never),
    });
  });

  it('reports packageExport capability and blocks without write access', async () => {
    expect(buildAgentCapabilities('read-only').packageExport).toBe(true);
    const blocked = await exportAgentPackage();
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics[0]?.code).toBe('write_access_required');
  });

  it('exports through the package engine and tracks progress', async () => {
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const { downloadBlob } = await import('../src/engine/packageExport');

    const result = await exportAgentPackage({ download: true });
    expect(result.ok).toBe(true);
    expect(result.fileName).toBe('agent-package.zip');
    expect(result.manifestPaths).toEqual(['manifest.json']);
    expect(downloadBlob).toHaveBeenCalled();
    expect(getAgentPackageExportProgress()?.phase).toBe('complete');
    expect(getAgentPackageExportProgress()?.message).toBe('Package downloaded');
    expect(useProjectStore.getState().isExportingPackage).toBe(false);
  });

  it('build-only export does not download or mark shots exported', async () => {
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const project = useProjectStore.getState().project;
    const shotStatuses = project.shots.map((shot) => shot.status);
    const { downloadBlob } = await import('../src/engine/packageExport');
    vi.mocked(downloadBlob).mockClear();

    const result = await exportAgentPackage({ download: false });
    expect(result.ok).toBe(true);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(result.progress?.message).toBe('Package built');
    expect(useProjectStore.getState().project.shots.map((shot) => shot.status)).toEqual(shotStatuses);
  });

  it('accepts a new durability revision when refreshed project content is unchanged', async () => {
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const project = useProjectStore.getState().project;
    const result = await exportAgentPackage({
      download: false,
      expectedRevisionId: 'rev-active',
      expectedFingerprint: projectFingerprint(project),
    });
    expect(result.ok).toBe(true);
    expect(result.revisionId).toBe('rev-1');
  });

  it('rejects export when project content changed after revision refresh', async () => {
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const result = await exportAgentPackage({
      download: false,
      expectedRevisionId: 'rev-active',
      expectedFingerprint: 'stale-fingerprint',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('stale_revision');
    expect(result.diagnostics[0]?.code).toBe('stale_revision');
  });

  it('cancel without an active export returns a diagnostic', () => {
    const result = cancelAgentPackageExport();
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('invalid_argument');
  });
});
