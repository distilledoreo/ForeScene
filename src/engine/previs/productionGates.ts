/**
 * Integrity gates for production orchestration.
 *
 * This module is deliberately pure. Browser rendering, persistence, and
 * review UI adapters feed observed outcomes into this state machine; they do
 * not get to skip a gate by returning a successful command response.
 */

import type {
  LocationProject,
  ProductionConfiguration,
  ShotCompositionConstraintSet,
} from '../../domain/types';
import type {
  PrevisCharacterDefinition,
  PrevisProductionManifestV1,
  PrevisShotDefinition,
} from './manifest';
import type { ApprovedLayoutRevision } from './stillLayoutApproval';

export const PRODUCTION_GATE_ORDER = [
  'VALIDATE_INPUT',
  'VALIDATE_BINDINGS',
  'VALIDATE_CAPABILITIES',
  'CREATE_RECOVERY_REVISION',
  'PLAN_CANARY',
  'AUTHOR_CANARY',
  'VERIFY_CANARY_STATE',
  'RENDER_CANARY',
  'VERIFY_CANARY_OUTPUT',
  'WAIT_FOR_CANARY_APPROVAL',
  'AUTHOR_FULL_STILL_SEQUENCE',
  'VERIFY_FULL_STILL_SEQUENCE',
  'WAIT_FOR_STILL_APPROVAL',
  'CLONE_FOR_MOTION',
  'AUTHOR_MOTION',
  'FINAL_EXPORT',
] as const;

export type ProductionGate = (typeof PRODUCTION_GATE_ORDER)[number];

export type GateFailurePolicy =
  | 'abort_and_rollback'
  | 'pause_for_review'
  | 'skip_item'
  | 'continue_with_warning';

export type ProductionGateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'paused' | 'skipped';

export const DEFAULT_GATE_FAILURE_POLICIES: Record<ProductionGate, GateFailurePolicy> = {
  VALIDATE_INPUT: 'abort_and_rollback',
  VALIDATE_BINDINGS: 'abort_and_rollback',
  VALIDATE_CAPABILITIES: 'abort_and_rollback',
  CREATE_RECOVERY_REVISION: 'abort_and_rollback',
  PLAN_CANARY: 'abort_and_rollback',
  AUTHOR_CANARY: 'abort_and_rollback',
  VERIFY_CANARY_STATE: 'abort_and_rollback',
  RENDER_CANARY: 'abort_and_rollback',
  VERIFY_CANARY_OUTPUT: 'abort_and_rollback',
  WAIT_FOR_CANARY_APPROVAL: 'pause_for_review',
  AUTHOR_FULL_STILL_SEQUENCE: 'abort_and_rollback',
  VERIFY_FULL_STILL_SEQUENCE: 'abort_and_rollback',
  WAIT_FOR_STILL_APPROVAL: 'pause_for_review',
  CLONE_FOR_MOTION: 'abort_and_rollback',
  AUTHOR_MOTION: 'abort_and_rollback',
  FINAL_EXPORT: 'pause_for_review',
};

export type ProductionCapability =
  | 'location'
  | 'panorama'
  | 'imported_character'
  | 'pose_deformation'
  | 'multipart_group'
  | 'multiple_subjects'
  | 'prop'
  | 'visibility_transition'
  | 'camera_motion'
  | 'object_motion'
  | 'dynamic_presence'
  | 'reference_composition';

export const CANARY_OUTPUTS = [
  'clay_dynamic_subjects',
  'characters_only',
  'clay_clean_plate',
  'projected_dynamic_subjects',
] as const;

export type CanaryOutput = (typeof CANARY_OUTPUTS)[number];

export interface ProductionGateDiagnostic {
  code: string;
  message: string;
  gate?: ProductionGate;
  shotId?: string;
  severity?: 'error' | 'warning' | 'info';
}

export interface ProductionGateRecord {
  status: ProductionGateStatus;
  policy: GateFailurePolicy;
  startedAt?: string;
  completedAt?: string;
  diagnostics: ProductionGateDiagnostic[];
}

export interface ProductionGateState {
  runId: string;
  currentGate: ProductionGate;
  gates: Record<ProductionGate, ProductionGateRecord>;
  canaryPlan?: ProductionCanaryPlan;
  canaryResult?: ProductionCanaryResult;
  canaryApproved: boolean;
  stillLayoutApproved: boolean;
  fullRunUnlocked: boolean;
  approvedLayoutRevision?: ApprovedLayoutRevision;
  stillReviewRecord?: string;
  motionWorkingRevisionId?: string;
  motionWorkingProjectId?: string;
  overrideReason?: string;
  updatedAt: string;
}

export interface ProductionCanaryCandidate {
  shotId: string;
  shotNumber: string;
  capabilities: ProductionCapability[];
}

export interface ProductionCanaryPlan {
  shotIds: string[];
  shotNumbers: string[];
  requiredCapabilities: ProductionCapability[];
  coveredCapabilities: ProductionCapability[];
  uncoveredCapabilities: ProductionCapability[];
  outputs: CanaryOutput[];
  complete: boolean;
  maxShots: number;
}

export interface ProductionCanaryOutputResult {
  output: CanaryOutput;
  ok: boolean;
  artifactId?: string;
  diagnostics?: ProductionGateDiagnostic[];
}

export interface ProductionCanaryShotResult {
  shotId: string;
  presenceOk: boolean;
  capabilitiesOk: boolean;
  panoramaOk: boolean;
  compositionOk: boolean;
  unrelatedStateChanged: boolean;
  outputs: ProductionCanaryOutputResult[];
  diagnostics?: ProductionGateDiagnostic[];
}

export interface ProductionCanaryResult {
  ok: boolean;
  shotResults: ProductionCanaryShotResult[];
  missingShotIds: string[];
  uncoveredCapabilities: ProductionCapability[];
  diagnostics: ProductionGateDiagnostic[];
}

export interface StillLayoutApproval {
  runId: string;
  approvedShotIds: string[];
  reviewRecord?: string;
  approvedAt?: string;
}

function sortedCapabilities(values: Iterable<ProductionCapability>): ProductionCapability[] {
  return [...new Set(values)].sort();
}

function isImportedCharacter(character: PrevisCharacterDefinition | undefined): boolean {
  return character?.type === 'imported_character';
}

function shotContractFor(
  configuration: ProductionConfiguration | undefined,
  shot: Pick<PrevisShotDefinition, 'id' | 'shotNumber'>,
): {
  presence?: ProductionConfiguration['shotContracts'][string]['presence'];
  environment?: ProductionConfiguration['shotContracts'][string]['environment'];
  composition?: ShotCompositionConstraintSet;
} | undefined {
  if (!configuration) return undefined;
  for (const key of [shot.id, shot.shotNumber]) {
    const contract = configuration.shotContracts[key];
    if (contract) return contract;
  }
  return undefined;
}

/** Derive the high-risk capabilities exercised by one manifest shot. */
export function deriveProductionShotCapabilities(params: {
  shot: PrevisShotDefinition;
  manifest: PrevisProductionManifestV1;
  production?: ProductionConfiguration;
  project?: LocationProject;
}): ProductionCapability[] {
  const { shot, manifest, production, project } = params;
  const capabilities = new Set<ProductionCapability>(['location']);
  const contract = shotContractFor(production, shot);
  if (contract?.environment) capabilities.add('panorama');
  if (contract?.presence) capabilities.add('dynamic_presence');
  if (contract?.composition) capabilities.add('reference_composition');
  if (shot.subjects.length >= 2 || shot.camera.subjects.length >= 2) capabilities.add('multiple_subjects');
  if ((shot.requirements?.visibleProps?.length ?? 0) > 0) capabilities.add('prop');
  if (shot.blocking?.some((item) => Boolean(item.pose))) capabilities.add('pose_deformation');

  for (const subject of shot.subjects) {
    const character = manifest.cast.find((entry) => entry.id === subject);
    if (isImportedCharacter(character)) capabilities.add('imported_character');
    const binding = production?.bindings[subject]
      ?? production?.bindings[`cast.${subject}`];
    if (binding?.kind === 'group') capabilities.add('multipart_group');
    if (project && binding?.kind === 'group' && project.scene.objectGroups?.[binding.groupId]) {
      capabilities.add('multipart_group');
    }
  }

  if (shot.motion) {
    capabilities.add('camera_motion');
    const staging = shot.motion.keyframes.flatMap((keyframe) => keyframe.staging ?? []);
    if (staging.some((entry) => Boolean(entry.transform || entry.posePreset))) capabilities.add('object_motion');
    const visibilityValues = staging
      .map((entry) => entry.visible)
      .filter((value): value is boolean => value !== undefined);
    if (new Set(visibilityValues).size > 1) capabilities.add('visibility_transition');
    if (staging.some((entry) => Boolean(entry.posePreset))) capabilities.add('pose_deformation');
  }
  return sortedCapabilities(capabilities);
}

/** Select the smallest deterministic capability-covering canary (usually 2–5 shots). */
export function planProductionCanary(params: {
  candidates: ProductionCanaryCandidate[];
  requiredCapabilities?: ProductionCapability[];
  maxShots?: number;
}): ProductionCanaryPlan {
  const maxShots = Math.max(1, Math.min(5, Math.floor(params.maxShots ?? 5)));
  const candidates = [...params.candidates].sort((a, b) => (
    a.shotNumber.localeCompare(b.shotNumber, undefined, { numeric: true })
    || a.shotId.localeCompare(b.shotId)
  ));
  const required = sortedCapabilities(params.requiredCapabilities ?? candidates.flatMap((item) => item.capabilities));
  const covered = new Set<ProductionCapability>();
  const selected: ProductionCanaryCandidate[] = [];
  const remaining = [...candidates];

  while (remaining.length > 0 && selected.length < maxShots && covered.size < required.length) {
    let bestIndex = -1;
    let bestGain = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const gain = candidate.capabilities.filter((capability) => !covered.has(capability) && required.includes(capability)).length;
      if (gain > bestGain) {
        bestIndex = index;
        bestGain = gain;
      }
    }
    if (bestIndex < 0) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    if (!chosen) break;
    selected.push(chosen);
    for (const capability of chosen.capabilities) covered.add(capability);
  }

  // A two-shot review is the useful default when the production has enough
  // material, even if one broad shot already covers every capability.
  for (const candidate of remaining) {
    if (selected.length >= Math.min(2, maxShots) || selected.length >= candidates.length) break;
    selected.push(candidate);
  }

  const coveredCapabilities = sortedCapabilities(selected.flatMap((item) => item.capabilities));
  const uncoveredCapabilities = required.filter((capability) => !coveredCapabilities.includes(capability));
  return {
    shotIds: selected.map((item) => item.shotId),
    shotNumbers: selected.map((item) => item.shotNumber),
    requiredCapabilities: required,
    coveredCapabilities,
    uncoveredCapabilities,
    outputs: [...CANARY_OUTPUTS],
    complete: uncoveredCapabilities.length === 0,
    maxShots,
  };
}

export function runProductionCanary(
  plan: ProductionCanaryPlan,
  results: ProductionCanaryShotResult[],
): ProductionCanaryResult {
  const byId = new Map(results.map((result) => [result.shotId, result]));
  const diagnostics: ProductionGateDiagnostic[] = [];
  const missingShotIds = plan.shotIds.filter((shotId) => !byId.has(shotId));
  for (const shotId of missingShotIds) {
    diagnostics.push({ code: 'canary_shot_missing', message: `Canary result for shot "${shotId}" is missing.`, shotId });
  }
  for (const result of results) {
    if (!plan.shotIds.includes(result.shotId)) {
      diagnostics.push({ code: 'canary_unplanned_shot', message: `Shot "${result.shotId}" was reported but is not in the canary plan.`, shotId: result.shotId });
      continue;
    }
    if (!result.presenceOk) diagnostics.push({ code: 'canary_presence_failed', message: `Canary presence failed for "${result.shotId}".`, shotId: result.shotId });
    if (!result.capabilitiesOk) diagnostics.push({ code: 'canary_capabilities_failed', message: `Canary capability validation failed for "${result.shotId}".`, shotId: result.shotId });
    if (!result.panoramaOk) diagnostics.push({ code: 'canary_panorama_failed', message: `Canary panorama validation failed for "${result.shotId}".`, shotId: result.shotId });
    if (!result.compositionOk) diagnostics.push({ code: 'canary_composition_failed', message: `Canary composition validation failed for "${result.shotId}".`, shotId: result.shotId });
    if (result.unrelatedStateChanged) diagnostics.push({ code: 'canary_unrelated_state_changed', message: `Canary authoring changed unrelated state for "${result.shotId}".`, shotId: result.shotId });
    const requiredOutputs = plan.outputs.filter((output) => output !== 'projected_dynamic_subjects' || result.panoramaOk);
    for (const output of requiredOutputs) {
      const outputResult = result.outputs.find((item) => item.output === output);
      if (!outputResult?.ok) diagnostics.push({ code: 'canary_output_failed', message: `Canary output "${output}" failed for "${result.shotId}".`, shotId: result.shotId });
    }
    diagnostics.push(...(result.diagnostics ?? []));
  }
  return {
    ok: plan.complete && missingShotIds.length === 0 && diagnostics.length === 0,
    shotResults: results,
    missingShotIds,
    uncoveredCapabilities: plan.uncoveredCapabilities,
    diagnostics,
  };
}

export function createProductionGateState(runId: string, now = new Date().toISOString()): ProductionGateState {
  const gates = Object.fromEntries(PRODUCTION_GATE_ORDER.map((gate) => [gate, {
    status: 'pending' as const,
    policy: DEFAULT_GATE_FAILURE_POLICIES[gate],
    diagnostics: [],
  }])) as unknown as Record<ProductionGate, ProductionGateRecord>;
  return {
    runId,
    currentGate: PRODUCTION_GATE_ORDER[0]!,
    gates,
    canaryApproved: false,
    stillLayoutApproved: false,
    fullRunUnlocked: false,
    updatedAt: now,
  };
}

export function startProductionGate(
  state: ProductionGateState,
  gate: ProductionGate = state.currentGate,
  now = new Date().toISOString(),
): ProductionGateState {
  const record = state.gates[gate];
  if (record.status === 'passed') return state;
  return {
    ...state,
    currentGate: gate,
    gates: { ...state.gates, [gate]: { ...record, status: 'running', startedAt: record.startedAt ?? now } },
    updatedAt: now,
  };
}

export function completeProductionGate(
  state: ProductionGateState,
  gate: ProductionGate,
  outcome: { ok: boolean; diagnostics?: ProductionGateDiagnostic[]; status?: Exclude<ProductionGateStatus, 'pending' | 'running'> },
  now = new Date().toISOString(),
): ProductionGateState {
  const record = state.gates[gate];
  const status = outcome.status ?? (outcome.ok ? 'passed' : record.policy === 'pause_for_review' ? 'paused' : 'failed');
  const next = {
    ...state,
    gates: {
      ...state.gates,
      [gate]: { ...record, status, completedAt: now, diagnostics: [...(outcome.diagnostics ?? [])] },
    },
    updatedAt: now,
  };
  const index = PRODUCTION_GATE_ORDER.indexOf(gate);
  const nextGate = PRODUCTION_GATE_ORDER[index + 1];
  return nextGate && status === 'passed'
    ? { ...next, currentGate: nextGate }
    : next;
}

export function approveProductionCanary(
  state: ProductionGateState,
  result: ProductionCanaryResult,
  overrideReason?: string,
  now = new Date().toISOString(),
): ProductionGateState {
  const override = overrideReason?.trim();
  if (!result.ok && !override) {
    return completeProductionGate(state, 'WAIT_FOR_CANARY_APPROVAL', {
      ok: false,
      diagnostics: result.diagnostics,
      status: 'paused',
    }, now);
  }
  const next = completeProductionGate(state, 'WAIT_FOR_CANARY_APPROVAL', {
    ok: true,
    diagnostics: override ? [{ code: 'canary_override', message: override, severity: 'warning' }] : [],
  }, now);
  return {
    ...next,
    canaryResult: result,
    canaryApproved: true,
    fullRunUnlocked: true,
    ...(override ? { overrideReason: override } : {}),
    updatedAt: now,
  };
}

export function canAdvanceFullStillRun(state: ProductionGateState): boolean {
  return state.canaryApproved
    && state.fullRunUnlocked
    && state.gates.VERIFY_CANARY_STATE.status === 'passed'
    && state.gates.VERIFY_CANARY_OUTPUT.status === 'passed'
    && state.gates.WAIT_FOR_CANARY_APPROVAL.status === 'passed';
}

export function approveStillLayout(
  state: ProductionGateState,
  approval: StillLayoutApproval,
  now = new Date().toISOString(),
): ProductionGateState {
  if (approval.runId !== state.runId || approval.approvedShotIds.length === 0) return state;
  const next = completeProductionGate(state, 'WAIT_FOR_STILL_APPROVAL', { ok: true }, now);
  return { ...next, stillLayoutApproved: true, updatedAt: now };
}
