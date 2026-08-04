/** Agent adapters for reference-driven composition contracts and camera solves. */

import type { LocationProject, ShotCompositionConstraintSet } from '../../domain/types';
import { touchProject } from '../../state/slices/touchProject';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import {
  getShotCompositionContract,
  inspectShotCompositionError as inspectShotCompositionErrorEngine,
  verifyShotCompositionConstraints as verifyShotCompositionConstraintsEngine,
  type CompositionConstraintDiagnostic,
  type ShotCompositionConstraintInspection,
} from '../previs/compositionConstraints';
import {
  solveShotToCompositionConstraints as solveShotToCompositionConstraintsEngine,
  type CompositionConstraintSolveOptions,
} from '../previs/compositionConstraintSolver';
import { agentError, writeAccessRequiredDiagnostic, type AgentDiagnostic } from './diagnostics';
import type {
  AgentShotCompositionInspection,
  AgentShotCompositionMutationResult,
} from './protocol';

function mapDiagnostic(item: CompositionConstraintDiagnostic): AgentDiagnostic {
  return agentError(item.code, item.message, {
    path: item.entityId ? `shotComposition.entities[id=${item.entityId}]` : undefined,
  });
}

function mapInspection(result: ShotCompositionConstraintInspection): AgentShotCompositionInspection {
  return {
    ok: result.ok,
    shotId: result.shotId,
    contractPresent: result.contractPresent,
    totalWeightedError: result.totalWeightedError,
    entities: structuredClone(result.entities),
    diagnostics: result.diagnostics.map(mapDiagnostic),
  };
}

function shotOrFailure(project: LocationProject, shotId: string) {
  const shot = project.shots.find((candidate) => candidate.id === shotId);
  if (!shot) {
    return {
      shot: undefined,
      diagnostics: [agentError('shot_not_found', `No shot with id "${shotId}".`)],
    };
  }
  return { shot, diagnostics: [] as AgentDiagnostic[] };
}

function isUnitInterval(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1);
}

function validateRect(value: unknown, label: string): AgentDiagnostic | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return agentError('invalid_argument', `${label} must be a normalized rectangle.`);
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return agentError('invalid_argument', `${label} must contain finite x, y, width, and height values.`);
  }
  if (![rect.x, rect.y, rect.width, rect.height].every((item) => (item as number) >= 0 && (item as number) <= 1)) {
    return agentError('invalid_argument', `${label} must use normalized values in the 0–1 range.`);
  }
  return undefined;
}

function validateConstraintInput(contract: ShotCompositionConstraintSet): AgentDiagnostic | undefined {
  if (!contract || !Array.isArray(contract.subjects)) {
    return agentError('invalid_argument', 'A composition contract requires a subjects array.');
  }
  for (const [index, subject] of contract.subjects.entries()) {
    if (!subject?.entityId?.trim()) return agentError('invalid_argument', `subjects[${index}].entityId is required.`);
    const rectError = validateRect(subject.expectedBounds, `subjects[${index}].expectedBounds`);
    if (rectError) return rectError;
    if (![subject.headPoint, subject.facePoint].every((point) => (
      point === undefined
      || (Array.isArray(point) && point.length === 2 && point.every((item) => isUnitInterval(item)))
    ))) {
      return agentError('invalid_argument', `subjects[${index}] points must be normalized [x, y] values.`);
    }
    if (!isUnitInterval(subject.expectedVisibility)) {
      return agentError('invalid_argument', `subjects[${index}].expectedVisibility must be in the 0–1 range.`);
    }
  }
  for (const [index, prop] of (contract.props ?? []).entries()) {
    if (!prop?.entityId?.trim()) return agentError('invalid_argument', `props[${index}].entityId is required.`);
    const rectError = validateRect(prop.expectedBounds, `props[${index}].expectedBounds`);
    if (rectError) return rectError;
    if (prop.expectedScreenPoint && !(
      Array.isArray(prop.expectedScreenPoint)
      && prop.expectedScreenPoint.length === 2
      && prop.expectedScreenPoint.every((item) => isUnitInterval(item))
    )) {
      return agentError('invalid_argument', `props[${index}].expectedScreenPoint must be normalized [x, y].`);
    }
  }
  if (!isUnitInterval(contract.horizonY) || !isUnitInterval(contract.floorLineY)) {
    return agentError('invalid_argument', 'horizonY and floorLineY must be normalized values in the 0–1 range.');
  }
  if (contract.cropTolerance !== undefined && (!Number.isFinite(contract.cropTolerance) || contract.cropTolerance < 0)) {
    return agentError('invalid_argument', 'cropTolerance must be a finite non-negative number.');
  }
  return undefined;
}

function cloneProduction(project: LocationProject) {
  const existing = project.workflow.production;
  if (existing) return structuredClone(existing);
  const legacyBindings = project.workflow.productionManifestAssetBindings ?? {};
  return {
    schemaVersion: 1 as const,
    bindings: Object.fromEntries(
      Object.entries(legacyBindings).map(([entityId, objectId]) => [entityId, { kind: 'object' as const, objectId }]),
    ),
    locations: {},
    shotContracts: {},
  };
}

async function persistCompositionMutation(
  operation: string,
  mutate: (project: LocationProject) => LocationProject,
): Promise<AgentShotCompositionMutationResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic(operation)] };
  }
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }
  try {
    const verified = await runDestructive(operation, () => {
      useProjectStore.setState((state) => ({ project: touchProject(mutate(state.project)) }));
    });
    return { ok: true, revisionId: verified?.revision.id, diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError(
        'composition_mutation_failed',
        error instanceof Error ? error.message : `${operation} failed.`,
      )],
    };
  }
}

export function inspectAgentShotCompositionError(input: { shotId: string }): AgentShotCompositionInspection {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) {
    return {
      ok: false,
      shotId: input.shotId,
      contractPresent: false,
      totalWeightedError: 0,
      entities: {},
      diagnostics: target.diagnostics,
    };
  }
  return mapInspection(inspectShotCompositionErrorEngine(project, target.shot));
}

export function verifyAgentShotCompositionConstraints(input: { shotId: string }): AgentShotCompositionInspection {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) return inspectAgentShotCompositionError(input);
  return mapInspection(verifyShotCompositionConstraintsEngine(project, target.shot));
}

export async function setAgentShotCompositionConstraints(input: {
  shotId: string;
  contract: ShotCompositionConstraintSet;
}): Promise<AgentShotCompositionMutationResult> {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) return { ok: false, diagnostics: target.diagnostics };
  const invalid = validateConstraintInput(input.contract);
  if (invalid) return { ok: false, diagnostics: [invalid] };
  return persistCompositionMutation('Set shot composition constraints', (current) => {
    const production = cloneProduction(current);
    production.shotContracts[input.shotId] = {
      ...(production.shotContracts[input.shotId] ?? {}),
      composition: structuredClone(input.contract),
    };
    return {
      ...current,
      schemaVersion: '1.2',
      workflow: { ...current.workflow, production },
    };
  });
}

export async function solveAgentShotToCompositionConstraints(input: {
  shotId: string;
  maxIterations?: number;
}): Promise<AgentShotCompositionMutationResult> {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) return { ok: false, diagnostics: target.diagnostics };
  const contract = getShotCompositionContract(project, target.shot);
  if (!contract) {
    return {
      ok: false,
      diagnostics: [agentError('composition_contract_missing', `Shot "${input.shotId}" has no composition contract.`)],
    };
  }
  const options: CompositionConstraintSolveOptions = input.maxIterations === undefined
    ? {}
    : { maxIterations: input.maxIterations };
  const solved = solveShotToCompositionConstraintsEngine(project, target.shot, contract, options);
  const before = mapInspection(solved.before);
  const after = mapInspection(solved.after);
  if (!solved.ok) {
    return {
      ok: false,
      status: 'failed',
      changed: false,
      iterations: solved.iterations,
      before,
      after,
      diagnostics: solved.diagnostics.map(mapDiagnostic),
    };
  }
  const mutation = await persistCompositionMutation('Solve shot composition constraints', (current) => ({
    ...current,
    shots: current.shots.map((shot) => shot.id === input.shotId
      ? { ...shot, camera: structuredClone(solved.shot.camera) }
      : shot),
  }));
  if (!mutation.ok) return { ...mutation, before, after, changed: false, iterations: solved.iterations };
  const live = useProjectStore.getState().project;
  const liveShot = live.shots.find((shot) => shot.id === input.shotId);
  const verified = liveShot
    ? mapInspection(verifyShotCompositionConstraintsEngine(live, liveShot, contract))
    : after;
  const verificationOk = verified.ok;
  return {
    ...mutation,
    ok: verificationOk,
    status: verificationOk ? 'completed' : 'failed',
    changed: solved.changed,
    iterations: solved.iterations,
    before,
    after: verified,
    diagnostics: verificationOk ? [] : verified.diagnostics,
  };
}
