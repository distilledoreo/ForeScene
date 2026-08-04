/** Agent adapters for prepared shot environment and projected health gates. */

import type { LocationProject, Shot } from '../../domain/types';
import {
  evaluateProjectionHealth,
  inspectShotEnvironment as inspectShotEnvironmentEngine,
  verifyShotPanorama as verifyShotPanoramaEngine,
  type ShotEnvironmentDiagnostic,
  type ShotEnvironmentInspection,
} from '../previs/shotEnvironment';
import { renderShotProjectedFrameWithHealth } from '../renderers';
import { sampleShotTimeline } from '../shotTimeline';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { agentError, agentWarning, type AgentDiagnostic } from './diagnostics';
import type {
  AgentProjectionHealthInspection,
  AgentShotEnvironmentInspection,
} from './protocol';

function mapDiagnostic(item: ShotEnvironmentDiagnostic): AgentDiagnostic {
  const create = item.severity === 'warning' ? agentWarning : agentError;
  return create(item.code, item.message, {
    path: item.shotId ? `shots[id=${item.shotId}]` : undefined,
  });
}

function mapEnvironmentInspection(result: ShotEnvironmentInspection): AgentShotEnvironmentInspection {
  return {
    ok: result.ok,
    shotId: result.shotId,
    contractPresent: result.contractPresent,
    locationId: result.locationId,
    expectedPanoId: result.expectedPanoId,
    actualPanoId: result.actualPanoId,
    requireProjection: result.requireProjection,
    minimumProjectionCoverage: result.minimumProjectionCoverage,
    diagnostics: result.diagnostics.map(mapDiagnostic),
  };
}

function missingShot(project: LocationProject, shotId: string): Shot | undefined {
  return project.shots.find((candidate) => candidate.id === shotId);
}

export function inspectAgentShotEnvironmentContract(input: { shotId: string }): AgentShotEnvironmentInspection {
  const project = useProjectStore.getState().project;
  const shot = missingShot(project, input.shotId);
  if (!shot) {
    return {
      ok: false,
      shotId: input.shotId,
      contractPresent: false,
      requireProjection: false,
      minimumProjectionCoverage: 0.5,
      diagnostics: [agentError('shot_not_found', `No shot with id "${input.shotId}".`)],
    };
  }
  return mapEnvironmentInspection(inspectShotEnvironmentEngine(project, shot));
}

export function verifyAgentShotPanorama(input: { shotId: string }): AgentShotEnvironmentInspection {
  const project = useProjectStore.getState().project;
  const shot = missingShot(project, input.shotId);
  if (!shot) return inspectAgentShotEnvironmentContract(input);
  return mapEnvironmentInspection(verifyShotPanoramaEngine(project, shot));
}

export async function inspectAgentProjectionHealth(input: {
  shotId: string;
  timeSeconds?: number;
  minimumCoverage?: number;
  requireProjection?: boolean;
}): Promise<AgentProjectionHealthInspection> {
  const project = useProjectStore.getState().project;
  const revisionId = useProjectSafetyStore.getState().activeRevisionId ?? '';
  const shot = missingShot(project, input.shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      revisionId,
      diagnostics: [agentError('shot_not_found', `No shot with id "${input.shotId}".`)],
    };
  }

  const environment = inspectShotEnvironmentEngine(project, shot);
  let shotForRender = shot;
  let sampledTimeSeconds: number | undefined;
  if (input.timeSeconds !== undefined) {
    try {
      const sample = sampleShotTimeline(project, shot.id, input.timeSeconds);
      sampledTimeSeconds = sample.sampledTimeSeconds;
      shotForRender = {
        ...shot,
        camera: sample.camera,
        objectOverrides: sample.objectOverrides,
      };
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        shotId: shot.id,
        revisionId,
        diagnostics: [agentError('invalid_argument', error instanceof Error ? error.message : 'Invalid frame time.')],
      };
    }
  }

  try {
    const rendered = await renderShotProjectedFrameWithHealth(project, shotForRender);
    const healthDiagnostics = evaluateProjectionHealth(rendered.projectionHealth, {
      shotId: shot.id,
      requireProjection: input.requireProjection ?? environment.requireProjection ?? true,
      minimumProjectionCoverage: input.minimumCoverage ?? environment.minimumProjectionCoverage,
    });
    const diagnostics = [
      ...environment.diagnostics.map(mapDiagnostic),
      ...healthDiagnostics.map(mapDiagnostic),
    ];
    const revisionNow = useProjectSafetyStore.getState().activeRevisionId ?? '';
    if (revisionId && revisionNow && revisionId !== revisionNow) {
      diagnostics.push(agentError('stale_revision', 'Project revision changed during projected health render.'));
    }
    const hasError = diagnostics.some((item) => item.severity === 'error');
    const hasWarning = diagnostics.some((item) => item.severity === 'warning');
    return {
      ok: !hasError,
      status: hasError ? 'failed' : hasWarning ? 'completed_with_warnings' : 'completed',
      shotId: shot.id,
      revisionId: revisionNow || revisionId,
      ...(sampledTimeSeconds !== undefined ? { sampledTimeSeconds } : {}),
      metrics: rendered.projectionHealth,
      diagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      shotId: shot.id,
      revisionId,
      ...(sampledTimeSeconds !== undefined ? { sampledTimeSeconds } : {}),
      diagnostics: [agentError(
        'projection_render_failed',
        error instanceof Error ? error.message : 'Projected health render failed.',
      )],
    };
  }
}
