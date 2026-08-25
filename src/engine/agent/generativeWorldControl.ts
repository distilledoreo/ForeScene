import {
  createGenerativeWorldRequest,
  createHyWorld2CameraPriorFile,
  resolveGenerativeWorldCleanPlate,
  runMockGenerativeWorldBackend,
  validateGenerativeWorldRequest,
} from '../generativeWorldBoundary';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { renderShotDepthFrame } from '../depthRender';
import { sampleShotTimeline } from '../shotTimeline';
import { registerAgentArtifact } from './artifactRegistry';
import { agentError } from './diagnostics';
import type {
  AgentGenerativeWorldDepthResult,
  AgentGenerativeWorldMockResult,
  AgentGenerativeWorldPreviewResult,
} from './protocol';

function unknownShotIds(projectShotIds: string[], requested?: string[]): string[] {
  if (!requested) return [];
  const known = new Set(projectShotIds);
  return requested.filter((shotId) => !known.has(shotId));
}

export function previewAgentGenerativeWorldRequest(input: {
  shotIds?: string[];
  desiredRepresentations?: Array<'mesh' | '3dgs'>;
} = {}): AgentGenerativeWorldPreviewResult {
  const project = useProjectStore.getState().project;
  const unknown = unknownShotIds(project.shots.map((shot) => shot.id), input.shotIds);
  if (unknown.length > 0) {
    return {
      ok: false,
      diagnostics: [agentError('target_not_found', `Unknown shot id(s): ${unknown.join(', ')}.`)],
    };
  }
  const request = createGenerativeWorldRequest({ project, ...input });
  const validation = validateGenerativeWorldRequest(request);
  return {
    ok: validation.ok,
    request,
    hyWorld2CameraPrior: createHyWorld2CameraPriorFile(request),
    diagnostics: validation.errors.map((message) => agentError('world_request_invalid', message)),
  };
}

export function runAgentMockGenerativeWorldBackend(input: {
  shotIds?: string[];
  desiredRepresentations?: Array<'mesh' | '3dgs'>;
} = {}): AgentGenerativeWorldMockResult {
  const preview = previewAgentGenerativeWorldRequest(input);
  if (!preview.ok || !preview.request) {
    return { ok: false, diagnostics: preview.diagnostics };
  }
  return {
    ok: true,
    request: preview.request,
    result: runMockGenerativeWorldBackend(preview.request),
    diagnostics: [],
  };
}

export async function renderAgentGenerativeWorldDepthPrior(input: {
  shotId: string;
  timeSeconds?: number;
  width?: number;
  height?: number;
}): Promise<AgentGenerativeWorldDepthResult> {
  const project = useProjectStore.getState().project;
  const revisionAtStart = useProjectSafetyStore.getState().activeRevisionId ?? '';
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      revisionId: revisionAtStart,
      width: input.width ?? 0,
      height: input.height ?? 0,
      diagnostics: [agentError('target_not_found', `Unknown shot id: ${input.shotId}.`)],
    };
  }
  const width = input.width ?? shot.exportSettings.width;
  const height = input.height ?? shot.exportSettings.height;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      revisionId: revisionAtStart,
      width,
      height,
      diagnostics: [agentError('invalid_argument', 'Depth-prior width and height must be positive integers.')],
    };
  }
  let sample: ReturnType<typeof sampleShotTimeline> | undefined;
  try {
    sample = input.timeSeconds === undefined
      ? undefined
      : sampleShotTimeline(project, shot.id, input.timeSeconds);
    const shotForRender = {
      ...shot,
      ...(sample ? { camera: sample.camera, objectOverrides: sample.objectOverrides } : {}),
      exportSettings: { ...shot.exportSettings, width, height },
    };
    const cleanPlate = resolveGenerativeWorldCleanPlate(project, shotForRender);
    const frame = await renderShotDepthFrame(cleanPlate.project, cleanPlate.shot, {
      peopleVariant: 'clean_plate',
      output: 'blob',
      includeMetricDepth: true,
    });
    if (!frame.metricDepthNpy) throw new Error('Metric depth renderer returned no NumPy artifact.');
    const revisionNow = useProjectSafetyStore.getState().activeRevisionId ?? '';
    if (revisionAtStart && revisionNow && revisionAtStart !== revisionNow) {
      return {
        ok: false,
        status: 'stale_revision',
        shotId: shot.id,
        revisionId: revisionNow,
        width,
        height,
        diagnostics: [agentError('stale_revision', 'Project revision changed during metric-depth rendering.')],
      };
    }
    const artifact = registerAgentArtifact({
      blob: frame.metricDepthNpy,
      mimeType: 'application/x-npy',
      fileName: `shot_${shot.shotNumber}_${(sample?.sampledTimeSeconds ?? 0).toFixed(3)}_depth.npy`,
      revisionId: revisionNow,
      shotId: shot.id,
      authoritative: true,
    });
    return {
      ok: true,
      status: 'completed',
      shotId: shot.id,
      ...(sample ? {
        requestedTimeSeconds: sample.requestedTimeSeconds,
        sampledTimeSeconds: sample.sampledTimeSeconds,
      } : {}),
      revisionId: revisionNow,
      width,
      height,
      encoding: 'npy-float32-linear-camera-z',
      invalidDepthValue: 0,
      nearMeters: frame.nearMeters,
      farMeters: frame.farMeters,
      artifact,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      revisionId: useProjectSafetyStore.getState().activeRevisionId ?? revisionAtStart,
      width,
      height,
      diagnostics: [agentError('world_depth_render_failed', error instanceof Error ? error.message : String(error))],
    };
  }
}
