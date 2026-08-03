import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoReference } from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { createId } from '../src/utils/ids';
import { resetAgentArtifactRegistryForTests, registerAgentArtifact } from '../src/engine/agent/artifactRegistry';
import { describeAgentOperation, getAgentSchema } from '../src/engine/agent/discovery';
import { deriveOperationOk, deriveOperationStatus } from '../src/engine/agent/renderResult';
import { resetAgentPackageExportControl } from '../src/engine/agent/packageExportControl';
import { resetAgentShotVideoRenderControl } from '../src/engine/agent/videoRenderControl';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { withShotPanoLink, getCanonicalPano } from '../src/engine/sync';
import { setAgentShotPanorama } from '../src/engine/agent/shotPanorama';
import { inspectAgentShotDiagnostics } from '../src/engine/agent/shotDiagnostics';

function installMockDestructiveMutation() {
  useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
    await mutation();
    const project = useProjectStore.getState().project;
    return {
      project: structuredClone(project),
      revision: {
        id: `rev_${Date.now().toString(36)}`,
        projectId: project.id,
        kind: 'autosave' as const,
        reason: 'test',
        createdAt: new Date().toISOString(),
        manifest: '{}',
        resources: { projectAssetKeys: [], modelAssetKeys: [] },
      },
    };
  });
}

function projectWithPano(): LocationProject {
  const project = createDefaultProject();
  const assetId = createId('asset');
  const pano = createPanoReference({
    name: 'Test Pano',
    assetId,
    type: 'ai_global_reference',
    origin: [0, 1.6, 0],
    rotation: [0, 0, 0],
    width: 1024,
    height: 512,
    isCanonical: true,
  });
  return {
    ...project,
    assets: {
      assets: {
        ...project.assets.assets,
        [assetId]: {
          id: assetId,
          name: 'Test Pano Asset',
          type: 'image',
          mimeType: 'image/png',
          uri: 'data:image/png;base64,test',
          width: 1024,
          height: 512,
          resolutionStatus: 'available',
          createdAt: new Date().toISOString(),
        },
      },
    },
    panoRefs: [pano],
    shots: project.shots.map((shot) => ({
      ...shot,
      linkedPanoId: pano.id,
    })),
  };
}

describe('agent API improvements', () => {
  beforeEach(() => {
    resetAgentArtifactRegistryForTests();
    resetAgentPackageExportControl();
    resetAgentShotVideoRenderControl();
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const project = projectWithPano();
    useProjectStore.setState({
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
      activePanoId: undefined,
      isRenderingGraybox: false,
      isExportingPackage: false,
    });
    useProjectSafetyStore.setState({ criticalWrite: false, status: 'saved' });
    installMockDestructiveMutation();
  });

  afterEach(() => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(undefined);
    resetAgentArtifactRegistryForTests();
  });

  it('derives render status with artifact despite quality diagnostics', () => {
    const status = deriveOperationStatus({
      hasArtifact: true,
      diagnostics: [{ code: 'frame_zero_variance', message: 'flat', severity: 'error' }],
    });
    expect(status).toBe('completed_with_warnings');
    expect(deriveOperationOk(status)).toBe(true);
  });

  it('registers and describes artifact handles', () => {
    const handle = registerAgentArtifact({
      blob: new Blob(['hello'], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileName: 'hello.txt',
      revisionId: 'rev_test',
    });
    expect(handle.artifactId).toMatch(/^artifact_/);
    expect(handle.byteLength).toBeGreaterThan(0);
    expect(describeAgentOperation('downloadArtifact')?.name).toBe('downloadArtifact');
    expect(getAgentSchema().apiVersion).toBe(1);
  });

  it('sets and clears shot panorama links', async () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const canonical = getCanonicalPano(project);
    expect(canonical).toBeTruthy();

    const linked = await setAgentShotPanorama({ shotId: shot.id, panoId: canonical!.id });
    expect(linked.ok).toBe(true);
    expect(linked.linkedPanoId).toBe(canonical!.id);

    const cleared = await setAgentShotPanorama({ shotId: shot.id, panoId: null });
    expect(cleared.ok).toBe(true);
    expect(cleared.linkedPanoId).toBeUndefined();

    const updatedShot = useProjectStore.getState().project.shots.find((item) => item.id === shot.id);
    expect(updatedShot?.linkedPanoId).toBeUndefined();
    expect(updatedShot?.panoCrop).toBeUndefined();
  });

  it('returns shot diagnostics with subject coverage fields', () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const diagnostics = inspectAgentShotDiagnostics({ project, shot });
    expect(diagnostics.shotId).toBe(shot.id);
    expect(Array.isArray(diagnostics.subjects)).toBe(true);
    expect(typeof diagnostics.cameraInsideEnvironmentBounds).toBe('boolean');
    expect(typeof diagnostics.motionDisplacementMeters).toBe('number');
  });

  it('recomputes pano crop when linking via withShotPanoLink helper', () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const canonical = getCanonicalPano(project)!;
    const linked = withShotPanoLink(project, shot, canonical);
    expect(linked.linkedPanoId).toBe(canonical.id);
    expect(linked.panoCrop?.panoId).toBe(canonical.id);
  });
});
