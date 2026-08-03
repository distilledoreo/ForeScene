/**
 * Agent API panorama / reference workspace lifecycle.
 */

import type { Euler, Vec3 } from '../../domain/types';
import { getCanonicalPano } from '../../domain/selectors';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { awaitAgentNotBusy } from './busy';
import {
  agentError,
  writeAccessRequiredDiagnostic,
} from './diagnostics';
import type {
  AgentGrayboxPanoramaRenderInput,
  AgentPanoramaReferenceImportInput,
  AgentPanoramaReferenceResult,
  AgentPanoramaReferenceUpdateInput,
} from './protocol';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';

function requireWrite(operation: string): AgentPanoramaReferenceResult | null {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic(operation)],
    };
  }
  return null;
}

async function commitMutation(
  reason: string,
  mutate: () => void | Promise<void>,
): Promise<{ revisionId?: string } | AgentPanoramaReferenceResult> {
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }
  const verified = await runDestructive(reason, mutate);
  return { revisionId: verified?.revision.id };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read panorama file.'));
    reader.readAsDataURL(file);
  });
}

export async function importAgentPanoramaReference(
  input: AgentPanoramaReferenceImportInput,
): Promise<AgentPanoramaReferenceResult> {
  const blocked = requireWrite('importPanoramaReference');
  if (blocked) return blocked;

  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  try {
    const dataUrl = await fileToDataUrl(input.file);
    const mode = input.mode ?? 'canonical';
    let panoId: string | undefined;

    const commit = await commitMutation(`Import panorama (${mode})`, async () => {
      const store = useProjectStore.getState();
      if (mode === 'canonical' || mode === 'replace') {
        store.importCanonicalPano({
          name: input.name ?? input.file.name,
          dataUrl,
        });
      } else {
        store.importStyledPano({
          name: input.name ?? input.file.name,
          dataUrl,
        });
      }
      const project = useProjectStore.getState().project;
      const canonical = getCanonicalPano(project);
      panoId = canonical?.id ?? project.panoRefs[project.panoRefs.length - 1]?.id;
    });

    if ('ok' in commit && commit.ok === false) return commit as AgentPanoramaReferenceResult;

    const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
    return {
      ok: deriveOperationOk(status),
      status,
      panoId,
      revisionId: 'revisionId' in commit ? commit.revisionId : undefined,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('pano_import_failed', error instanceof Error ? error.message : 'Panorama import failed.')],
    };
  }
}

export async function updateAgentPanoramaReference(
  input: AgentPanoramaReferenceUpdateInput,
): Promise<AgentPanoramaReferenceResult> {
  const blocked = requireWrite('updatePanoramaReference');
  if (blocked) return blocked;

  const project = useProjectStore.getState().project;
  const pano = project.panoRefs.find((candidate) => candidate.id === input.panoId);
  if (!pano) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('pano_not_found', `No panorama with id "${input.panoId}".`)],
    };
  }

  const commit = await commitMutation('Update panorama reference', () => {
    useProjectStore.setState((state) => {
      const panoRefs = state.project.panoRefs.map((candidate) => {
        if (candidate.id !== input.panoId) return candidate;
        return {
          ...candidate,
          ...(input.origin ? { origin: [...input.origin] as Vec3 } : {}),
          ...(input.rotation ? { rotation: [...input.rotation] as Euler } : {}),
        };
      });
      let scene = state.project.scene;
      if (pano.isCanonical && input.origin) {
        scene = {
          ...scene,
          panoOrigin: [...input.origin] as Vec3,
          ...(input.rotation ? { panoRotation: [...input.rotation] as Euler } : {}),
        };
      }
      return { project: touchProject({ ...state.project, panoRefs, scene }) };
    });
  });

  if ('ok' in commit && commit.ok === false) return commit as AgentPanoramaReferenceResult;

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    panoId: input.panoId,
    revisionId: 'revisionId' in commit ? commit.revisionId : undefined,
    diagnostics: [],
  };
}

export async function renderAgentGrayboxPanorama(
  input: AgentGrayboxPanoramaRenderInput = {},
): Promise<AgentPanoramaReferenceResult> {
  const blocked = requireWrite('renderGrayboxPanorama');
  if (blocked) return blocked;

  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  if (input.origin) {
    useProjectStore.getState().setPanoOrigin([...input.origin] as Vec3);
  }

  try {
    let panoId: string | undefined;
    const commit = await commitMutation('Render graybox panorama', async () => {
      const pano = await useProjectStore.getState().renderGrayboxPano();
      panoId = pano.id;
    });

    if ('ok' in commit && commit.ok === false) return commit as AgentPanoramaReferenceResult;

    const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
    return {
      ok: deriveOperationOk(status),
      status,
      panoId,
      revisionId: 'revisionId' in commit ? commit.revisionId : undefined,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('graybox_render_failed', error instanceof Error ? error.message : 'Graybox render failed.')],
    };
  }
}

export async function approveAgentPanoramaReference(input: { panoId: string }): Promise<AgentPanoramaReferenceResult> {
  const blocked = requireWrite('approvePanoramaReference');
  if (blocked) return blocked;

  const commit = await commitMutation('Approve panorama reference', () => {
    useProjectStore.setState((state) => ({
      project: touchProject({
        ...state.project,
        workflow: {
          ...state.project.workflow,
          grayboxApprovedForReferenceAt: new Date().toISOString(),
        },
      }),
    }));
  });

  if ('ok' in commit && commit.ok === false) return commit as AgentPanoramaReferenceResult;

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    panoId: input.panoId,
    revisionId: 'revisionId' in commit ? commit.revisionId : undefined,
    diagnostics: [],
  };
}

export async function acceptAgentReferenceAlignment(input: { panoId: string }): Promise<AgentPanoramaReferenceResult> {
  const blocked = requireWrite('acceptReferenceAlignment');
  if (blocked) return blocked;

  const commit = await commitMutation('Accept reference alignment', () => {
    useProjectStore.setState((state) => ({
      project: touchProject({
        ...state.project,
        workflow: {
          ...state.project.workflow,
          referenceAlignmentAcceptedForPanoId: input.panoId,
        },
      }),
    }));
  });

  if ('ok' in commit && commit.ok === false) return commit as AgentPanoramaReferenceResult;

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    panoId: input.panoId,
    revisionId: 'revisionId' in commit ? commit.revisionId : undefined,
    diagnostics: [],
  };
}

export async function removeAgentPanoramaReference(input: { panoId: string }): Promise<AgentPanoramaReferenceResult> {
  const blocked = requireWrite('removePanoramaReference');
  if (blocked) return blocked;

  const commit = await commitMutation('Remove panorama reference', () => {
    useProjectStore.getState().removePanoReference(input.panoId);
  });

  if ('ok' in commit && commit.ok === false) return commit as AgentPanoramaReferenceResult;

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    panoId: input.panoId,
    revisionId: 'revisionId' in commit ? commit.revisionId : undefined,
    diagnostics: [],
  };
}

export async function setAgentPanoramaCaptureOrigin(
  input: { position: [number, number, number] },
): Promise<AgentPanoramaReferenceResult> {
  const blocked = requireWrite('setPanoramaCaptureOrigin');
  if (blocked) return blocked;

  const commit = await commitMutation('Set panorama capture origin', () => {
    useProjectStore.getState().setPanoOrigin([...input.position] as Vec3);
  });

  if ('ok' in commit && commit.ok === false) return commit as AgentPanoramaReferenceResult;

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    revisionId: 'revisionId' in commit ? commit.revisionId : undefined,
    diagnostics: [],
  };
}

export async function inspectAgentPanoramaProjection(input: {
  panoId: string;
  camera?: import('../../domain/types').CameraData;
}): Promise<AgentPanoramaReferenceResult & { projection?: Record<string, unknown> }> {
  const project = useProjectStore.getState().project;
  const pano = project.panoRefs.find((candidate) => candidate.id === input.panoId);
  if (!pano) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('pano_not_found', `No panorama with id "${input.panoId}".`)],
    };
  }

  return {
    ok: true,
    status: 'completed',
    panoId: pano.id,
    projection: {
      origin: pano.origin,
      rotation: pano.rotation,
      width: pano.width,
      height: pano.height,
      isCanonical: pano.isCanonical,
      type: pano.type,
      camera: input.camera,
    },
    diagnostics: [],
  };
}
