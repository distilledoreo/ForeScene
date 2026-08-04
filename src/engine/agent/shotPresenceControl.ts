/** Browser Agent adapters for closed-world shot presence contracts. */

import type { LocationProject, ShotPresenceContract } from '../../domain/types';
import { touchProject } from '../../state/slices/touchProject';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import {
  applyClosedWorldShotPresence,
  inspectShotPresence as inspectShotPresenceEngine,
  verifyShotPresence as verifyShotPresenceEngine,
  type ShotPresenceDiagnostic,
  type ShotPresenceInspection,
} from '../previs/shotPresence';
import { agentError, writeAccessRequiredDiagnostic } from './diagnostics';
import type {
  AgentShotPresenceInspection,
  AgentShotPresenceMutationResult,
} from './protocol';

function mapDiagnostics(items: ShotPresenceDiagnostic[]) {
  return items.map((item) => agentError(item.code, item.message));
}

function mapInspection(result: ShotPresenceInspection): AgentShotPresenceInspection {
  return {
    ok: result.ok,
    shotId: result.shotId,
    contractPresent: result.contractPresent,
    expectedVisibleObjectIds: result.expectedVisibleObjectIds,
    expectedVisibleGroupIds: result.expectedVisibleGroupIds,
    dynamicObjectIds: result.dynamicObjectIds,
    actualVisibleObjectIds: result.actualVisibleObjectIds,
    samples: result.samples.map((sample) => ({
      timeSeconds: sample.timeSeconds,
      visibleDynamicObjectIds: sample.visibleDynamicObjectIds,
      diagnostics: mapDiagnostics(sample.diagnostics),
    })),
    diagnostics: mapDiagnostics(result.diagnostics),
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
  return { shot, diagnostics: [] };
}

function validateContractInput(contract: ShotPresenceContract) {
  if (!Array.isArray(contract.expectedVisibleObjectIds)
    || !Array.isArray(contract.expectedVisibleGroupIds)) {
    return agentError('invalid_argument', 'A shot presence contract requires object and group id arrays.');
  }
  if (typeof contract.allowUnspecifiedDynamicObjects !== 'boolean') {
    return agentError('invalid_argument', 'allowUnspecifiedDynamicObjects must be boolean.');
  }
  const allIds = [...contract.expectedVisibleObjectIds, ...contract.expectedVisibleGroupIds];
  if (allIds.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    return agentError('invalid_argument', 'Shot presence contract ids must be non-empty strings.');
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

async function persistPresenceMutation(
  operation: string,
  mutate: (project: LocationProject) => LocationProject,
): Promise<AgentShotPresenceMutationResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic(operation)] };
  }
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }
  try {
    const verified = await runDestructive(operation, () => {
      useProjectStore.setState((state) => ({
        project: touchProject(mutate(state.project)),
      }));
    });
    return { ok: true, revisionId: verified?.revision.id, diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError(
        'shot_presence_mutation_failed',
        error instanceof Error ? error.message : `${operation} failed.`,
      )],
    };
  }
}

export function inspectAgentShotPresence(input: { shotId: string }): AgentShotPresenceInspection {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) {
    return {
      ok: false,
      shotId: input.shotId,
      contractPresent: false,
      expectedVisibleObjectIds: [],
      expectedVisibleGroupIds: [],
      dynamicObjectIds: [],
      actualVisibleObjectIds: [],
      samples: [],
      diagnostics: target.diagnostics,
    };
  }
  return mapInspection(inspectShotPresenceEngine(project, target.shot));
}

export function verifyAgentShotPresence(input: { shotId: string }): AgentShotPresenceInspection {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) return inspectAgentShotPresence(input);
  return mapInspection(verifyShotPresenceEngine(project, target.shot));
}

export async function setAgentShotPresenceContract(input: {
  shotId: string;
  contract: ShotPresenceContract;
}): Promise<AgentShotPresenceMutationResult> {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) return { ok: false, diagnostics: target.diagnostics };
  const invalid = validateContractInput(input.contract);
  if (invalid) return { ok: false, diagnostics: [invalid] };
  return persistPresenceMutation('Set shot presence contract', (current) => {
    const production = cloneProduction(current);
    production.shotContracts[input.shotId] = {
      ...(production.shotContracts[input.shotId] ?? {}),
      presence: structuredClone(input.contract),
    };
    return {
      ...current,
      schemaVersion: '1.2',
      workflow: { ...current.workflow, production },
    };
  });
}

export async function repairAgentShotPresence(input: {
  shotId: string;
}): Promise<AgentShotPresenceMutationResult> {
  const project = useProjectStore.getState().project;
  const target = shotOrFailure(project, input.shotId);
  if (!target.shot) return { ok: false, diagnostics: target.diagnostics };
  const before = verifyShotPresenceEngine(project, target.shot);
  if (!before.contractPresent) {
    return {
      ok: false,
      diagnostics: [agentError('presence_contract_missing', `Shot "${input.shotId}" has no presence contract.`)],
    };
  }
  const contract = project.workflow.production?.shotContracts[input.shotId]?.presence;
  const repaired = applyClosedWorldShotPresence(project, target.shot, contract);
  if (!repaired.ok) return { ok: false, diagnostics: mapDiagnostics(repaired.diagnostics) };
  const mutation = await persistPresenceMutation('Repair shot presence', () => repaired.project);
  return {
    ...mutation,
    inspection: mapInspection(repaired.inspection),
  };
}

