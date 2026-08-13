/**
 * Transactional shot-repair candidates.
 * Later repairs cannot silently replace a better validated snapshot.
 */

import type { LocationProject, Shot } from '../../domain/types';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { awaitAgentNotBusy } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
} from './diagnostics';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import type { AgentRepairCandidateResult, AgentShotRepairSnapshot } from './protocol';
import { inspectShotVisualPreflight } from './visualPreflight';

const sessions = new Map<string, {
  best: AgentShotRepairSnapshot;
  currentLabel: string;
}>();

function snapshotShot(shot: Shot, label: string, score: number): AgentShotRepairSnapshot {
  const complete = structuredClone(shot);
  return {
    shotId: shot.id,
    capturedAt: new Date().toISOString(),
    label,
    score,
    shot: complete,
    camera: structuredClone(complete.camera),
    objectOverrides: structuredClone(complete.objectOverrides),
    cameraKeyframes: structuredClone(complete.cameraKeyframes),
    linkedPanoId: complete.linkedPanoId,
    panoCrop: structuredClone(complete.panoCrop),
    landmarkIds: structuredClone(complete.landmarkIds),
    exportSettings: structuredClone(complete.exportSettings),
    exportOverrides: structuredClone(complete.exportOverrides),
    promptOverrides: structuredClone(complete.promptOverrides),
    name: complete.name,
    description: complete.description,
    productionShotId: complete.productionShotId,
    metadata: structuredClone(complete.metadata),
  };
}

function applySnapshot(project: LocationProject, snapshot: AgentShotRepairSnapshot): LocationProject {
  return {
    ...project,
    shots: project.shots.map((shot) => {
      if (shot.id !== snapshot.shotId) return shot;
      if (snapshot.shot) {
        return {
          ...structuredClone(snapshot.shot),
          id: shot.id,
          updatedAt: new Date().toISOString(),
        };
      }
      return {
        ...shot,
        camera: structuredClone(snapshot.camera),
        objectOverrides: structuredClone(snapshot.objectOverrides),
        cameraKeyframes: structuredClone(snapshot.cameraKeyframes),
        linkedPanoId: snapshot.linkedPanoId,
        panoCrop: structuredClone(snapshot.panoCrop),
        landmarkIds: snapshot.landmarkIds ? structuredClone(snapshot.landmarkIds) : shot.landmarkIds,
        exportSettings: snapshot.exportSettings ? structuredClone(snapshot.exportSettings) : shot.exportSettings,
        exportOverrides: snapshot.exportOverrides ? structuredClone(snapshot.exportOverrides) : shot.exportOverrides,
        promptOverrides: snapshot.promptOverrides ? structuredClone(snapshot.promptOverrides) : shot.promptOverrides,
        name: snapshot.name ?? shot.name,
        description: snapshot.description ?? shot.description,
        productionShotId: snapshot.productionShotId ?? shot.productionShotId,
        metadata: snapshot.metadata ? structuredClone(snapshot.metadata) : shot.metadata,
        updatedAt: new Date().toISOString(),
      };
    }),
  };
}

function scoreShot(project: LocationProject, shotId: string, timeSeconds?: number, subjectIds?: string[]): number {
  return inspectShotVisualPreflight({ project, shotId, timeSeconds, subjectIds }).score;
}

export function beginShotRepairSession(input: {
  shotId: string;
  label?: string;
  timeSeconds?: number;
  subjectIds?: string[];
}): AgentRepairCandidateResult {
  const project = useProjectStore.getState().project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      kept: false,
      currentScore: 0,
      bestScore: 0,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${input.shotId}".`)],
    };
  }
  const score = scoreShot(project, shot.id, input.timeSeconds, input.subjectIds);
  const snapshot = snapshotShot(shot, input.label ?? 'baseline', score);
  sessions.set(shot.id, { best: snapshot, currentLabel: snapshot.label });
  return {
    ok: true,
    status: 'completed',
    shotId: shot.id,
    kept: true,
    currentScore: score,
    bestScore: score,
    bestLabel: snapshot.label,
    diagnostics: [],
  };
}

export function evaluateShotRepairCandidate(input: {
  shotId: string;
  label?: string;
  timeSeconds?: number;
  subjectIds?: string[];
  restoreIfWorse?: boolean;
  /** When false, treat the live shot as rejected even if visual score improved. */
  accepted?: boolean;
}): AgentRepairCandidateResult {
  const project = useProjectStore.getState().project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      kept: false,
      currentScore: 0,
      bestScore: 0,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${input.shotId}".`)],
    };
  }
  const existing = sessions.get(shot.id);
  const score = scoreShot(project, shot.id, input.timeSeconds, input.subjectIds);
  const snapshot = snapshotShot(shot, input.label ?? `candidate-${Date.now().toString(36)}`, score);
  const callerAccepted = input.accepted !== false;
  const scoreImproved = !existing || score > existing.best.score;
  if (callerAccepted && scoreImproved) {
    sessions.set(shot.id, { best: snapshot, currentLabel: snapshot.label });
    return {
      ok: true,
      status: 'completed',
      shotId: shot.id,
      kept: true,
      currentScore: score,
      bestScore: score,
      bestLabel: snapshot.label,
      diagnostics: [],
    };
  }
  const best = existing?.best ?? snapshot;
  sessions.set(shot.id, { best, currentLabel: snapshot.label });
  if (input.restoreIfWorse && existing) {
    useProjectStore.setState((state) => ({
      project: applySnapshot(state.project, existing.best),
    }));
  }
  return {
    ok: true,
    status: 'completed',
    shotId: shot.id,
    kept: false,
    currentScore: score,
    bestScore: best.score,
    bestLabel: best.label,
    diagnostics: [],
  };
}

export async function commitBestShotRepairCandidate(input: {
  shotId: string;
}): Promise<AgentRepairCandidateResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      kept: false,
      currentScore: 0,
      bestScore: 0,
      diagnostics: [writeAccessRequiredDiagnostic('commitBestShotRepairCandidate')],
    };
  }
  const busy = await awaitAgentNotBusy();
  if (busy) {
    return {
      ok: false,
      status: 'busy',
      shotId: input.shotId,
      kept: false,
      currentScore: 0,
      bestScore: 0,
      diagnostics: busy,
    };
  }
  const session = sessions.get(input.shotId);
  if (!session) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      kept: false,
      currentScore: 0,
      bestScore: 0,
      diagnostics: [agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'No repair session is open for this shot. Call beginShotRepairSession first.',
      )],
    };
  }
  const currentScore = scoreShot(useProjectStore.getState().project, input.shotId);
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      kept: false,
      currentScore,
      bestScore: session.best.score,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
    };
  }
  const verified = await runDestructive('Restore best validated repair candidate', () => {
    useProjectStore.setState((state) => ({
      project: touchProject(applySnapshot(state.project, session.best)),
    }));
  });
  return {
    ok: true,
    status: 'completed',
    shotId: input.shotId,
    revisionId: verified?.revision.id,
    kept: true,
    currentScore: session.best.score,
    bestScore: session.best.score,
    bestLabel: session.best.label,
    diagnostics: [],
  };
}

export function resetShotRepairSessionsForTests(): void {
  sessions.clear();
}
