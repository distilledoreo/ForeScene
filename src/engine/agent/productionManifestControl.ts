/**
 * Agent API production manifest compiler endpoints.
 */

import type {
  LocationProject,
  ProductionConfiguration,
  ProductionEntityBinding,
  ShotProductionContract,
  Workspace,
} from '../../domain/types';
import type { PrevisProductionManifestV1 } from '../previs/manifest';
import { parsePrevisProductionManifest } from '../previs/manifestValidation';
import { buildProductionCompileEntityBindings, buildProductionCompileLocationBindings } from '../previs/productionCompileBindings';
import { inferExistingProjectLocationBindings } from '../previs/productionCompileBindings';
import { deriveShotActionContracts } from '../previs/productionConfiguration';
import { resolveProductionPose } from '../previs/entityCapability';
import { compileProduction, plansForProductionCompile } from '../previs/productionCompiler';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { touchProject } from '../../state/slices/touchProject';
import { agentError, agentWarning, writeAccessRequiredDiagnostic } from './diagnostics';
import type {
  AgentProductionCompilePreviewResult,
  AgentProductionManifestValidateResult,
} from './protocol';
import { prepareAgentPlan, type PreparedAgentPlan } from './planCompiler';
import { projectFingerprint } from './planDiff';
import { commitPreparedPlanToStore } from './transaction';

function readLiveSource() {
  const projectState = useProjectStore.getState();
  return {
    project: projectState.project,
    workspace: projectState.workspace as Workspace,
    selectedObjectIds: projectState.selectedObjectIds,
    selectedShotId: projectState.selectedShotId,
    activePanoId: projectState.activePanoId,
    gridSnap: projectState.gridSnap,
  };
}

function readPersistedManifestBindings(): Record<string, string> {
  const project = useProjectStore.getState().project;
  return { ...(project.workflow.productionManifestAssetBindings ?? {}) };
}

function readCompileAssetBindings(project: LocationProject): Record<string, string> {
  const bindings = { ...readPersistedManifestBindings() };
  const production = project.workflow.production;
  if (!production) return bindings;
  for (const [entityId, binding] of Object.entries(production.bindings)) {
    if (binding.kind === 'object' && !bindings[entityId]) {
      bindings[entityId] = binding.objectId;
    }
    if (binding.kind === 'location' && !bindings[binding.locationId]) {
      const locationDef = production.locations[binding.locationId];
      const anchorObjectId = locationDef?.objectIds[0];
      if (anchorObjectId) bindings[binding.locationId] = anchorObjectId;
    }
    if (binding.kind === 'location' && !bindings[entityId]) {
      const locationDef = production.locations[binding.locationId];
      const anchorObjectId = locationDef?.objectIds[0];
      if (anchorObjectId) bindings[entityId] = anchorObjectId;
    }
  }
  return bindings;
}

function existingShotIdsForManifest(
  project: LocationProject,
  manifest: PrevisProductionManifestV1,
): Record<string, string> {
  const existingShotIds: Record<string, string> = {};
  for (const definition of manifest.shots) {
    const match = project.shots.find((shot) => (
      shot.shotNumber === definition.shotNumber
      || shot.productionShotId === definition.id
      || shot.productionShotId === definition.shotNumber
    ));
    if (match) existingShotIds[definition.shotNumber] = match.id;
  }
  return existingShotIds;
}

function mapPrevisDiagnostics(items: Array<{ code: string; message: string; severity: string }>) {
  return items.map((item) => (
    item.severity === 'warning' || item.severity === 'info'
      ? agentWarning(item.code, item.message)
      : agentError(item.code, item.message)
  ));
}

function mergeAgentPlans(plans: import('./protocol').ForeSceneAgentPlan[]): import('./protocol').ForeSceneAgentPlan {
  if (plans.length === 0) {
    return {
      version: 1,
      planId: 'production-compile-empty',
      description: 'Production compile (no commands)',
      commands: [],
    };
  }
  return {
    version: 1,
    planId: `production-compile-${plans[0]!.planId}`.slice(0, 80),
    description: plans.map((plan) => plan.description).filter(Boolean).join(' · '),
    commands: plans.flatMap((plan) => plan.commands),
  };
}

function chainPreparePlans(
  plans: unknown[],
  source: ReturnType<typeof readLiveSource>,
): { ok: true; lastPrepared: PreparedAgentPlan; commandCount: number } | { ok: false; diagnostics: import('./diagnostics').AgentDiagnostic[] } {
  let chainSource = source;
  let lastPrepared: PreparedAgentPlan | undefined;
  let commandCount = 0;

  for (const plan of plans) {
    const prepared = prepareAgentPlan(plan, chainSource);
    if (!prepared.ok) {
      return { ok: false, diagnostics: prepared.diagnostics };
    }
    lastPrepared = prepared.prepared;
    commandCount += prepared.prepared.summary.commandCount;
    chainSource = {
      ...chainSource,
      project: prepared.prepared.nextProject,
      workspace: prepared.prepared.nextSelection.workspace,
      selectedObjectIds: prepared.prepared.nextSelection.selectedObjectIds,
      selectedShotId: prepared.prepared.nextSelection.selectedShotId,
      activePanoId: prepared.prepared.nextActivePanoId ?? chainSource.activePanoId,
    };
  }

  if (!lastPrepared) {
    return { ok: false, diagnostics: [agentError('compile_empty', 'Production compile produced no plans.')] };
  }

  return { ok: true, lastPrepared, commandCount };
}

export function resetAgentProductionManifestBindingsForTests(): void {
  useProjectStore.setState((state) => ({
    project: touchProject({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        productionManifestAssetBindings: undefined,
      },
    }),
  }));
}

export function validateAgentProductionManifest(input: { manifest: unknown }): AgentProductionManifestValidateResult {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      diagnostics: mapPrevisDiagnostics(parsed.errors),
    };
  }
  return {
    ok: true,
    shotCount: parsed.manifest.shots.length,
    diagnostics: mapPrevisDiagnostics(parsed.warnings.filter((item) => item.severity === 'error')),
  };
}

export async function bindAgentManifestAssets(input: {
  manifest: unknown;
  bindings: Record<string, string>;
  groupBindings?: Record<string, string>;
}): Promise<AgentProductionManifestValidateResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      diagnostics: [writeAccessRequiredDiagnostic('bindManifestAssets')],
    };
  }

  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      diagnostics: mapPrevisDiagnostics(parsed.errors),
    };
  }

  const manifestIds = new Set([
    ...parsed.manifest.cast.map((entry) => entry.id),
    ...(parsed.manifest.props ?? []).map((entry) => entry.id),
    ...(parsed.manifest.assets ?? []).map((entry) => entry.id),
    ...parsed.manifest.locations.map((entry) => entry.id),
  ]);
  const missingBindings = Object.keys(input.bindings).filter((key) => !manifestIds.has(key));
  if (missingBindings.length > 0) {
    return {
      ok: false,
      diagnostics: [agentError('binding_not_found', 'Manifest entities not found: ' + missingBindings.join(', ') + '.')],
    };
  }

  const project = useProjectStore.getState().project;
  const missingObjects = Object.values(input.bindings).filter((objectId) => (
    !project.scene.objects.some((object) => object.id === objectId)
  ));
  if (missingObjects.length > 0) {
    return {
      ok: false,
      diagnostics: [agentError('object_not_found', 'Bound scene objects not found: ' + missingObjects.join(', ') + '.')],
    };
  }
  const missingGroups = Object.values(input.groupBindings ?? {}).filter((groupId) => (
    !project.scene.objectGroups?.[groupId]
  ));
  if (missingGroups.length > 0) {
    return {
      ok: false,
      diagnostics: [agentError('group_not_found', 'Bound object groups not found: ' + missingGroups.join(', ') + '.')],
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }

  await runDestructive('Bind manifest assets', () => {
    useProjectStore.setState((state) => ({
      project: touchProject({
        ...state.project,
        workflow: {
          ...state.project.workflow,
          productionManifestAssetBindings: {
            ...input.bindings,
            ...Object.fromEntries(Object.entries(input.groupBindings ?? {}).flatMap(([entityId, groupId]) => {
              const objectId = state.project.scene.objectGroups?.[groupId]?.objectIds[0];
              return objectId ? [[entityId, objectId]] : [];
            })),
          },
          production: buildManifestProductionConfiguration({
            project: state.project,
            manifest: parsed.manifest!,
            bindings: input.bindings,
            groupBindings: input.groupBindings ?? {},
          }),
        },
      }),
    }));
  });

  const locationBindingIds = Object.keys(input.bindings).filter((id) => (
    parsed.manifest!.locations.some((location) => location.id === id)
  ));
  const bindingWarnings = locationBindingIds.length > 0
    ? [agentWarning(
      'location_binding_limited',
      'Simple locationId→objectId binding records only the object reference and zone origin. '
        + 'Anchors, blocker geometry, and template geography are not populated — shots may lack '
        + 'location-specific solver context until rich location bindings are supported.',
    )]
    : [];

  return {
    ok: true,
    shotCount: parsed.manifest.shots.length,
    diagnostics: [
      ...bindingWarnings,
      ...mapPrevisDiagnostics(parsed.warnings.filter((item) => item.severity === 'warning')),
    ],
  };
}

function buildManifestProductionConfiguration(input: {
  project: LocationProject;
  manifest: PrevisProductionManifestV1;
  bindings: Record<string, string>;
  groupBindings: Record<string, string>;
}): ProductionConfiguration {
  const existing = input.project.workflow.production;
  const bindings: Record<string, ProductionEntityBinding> = {};
  for (const [entityId, objectId] of Object.entries(input.bindings)) {
    bindings[entityId] = { kind: 'object', objectId };
  }
  for (const [entityId, groupId] of Object.entries(input.groupBindings)) {
    bindings[entityId] = { kind: 'group', groupId };
  }

  const preparedLocations = inferExistingProjectLocationBindings(input.project, input.manifest);
  const boundDynamicObjectIds = new Set<string>();
  for (const binding of Object.values(bindings)) {
    if (binding.kind === 'object') boundDynamicObjectIds.add(binding.objectId);
    if (binding.kind === 'group') {
      for (const objectId of input.project.scene.objectGroups?.[binding.groupId]?.objectIds ?? []) {
        boundDynamicObjectIds.add(objectId);
      }
    }
  }
  const locations: ProductionConfiguration['locations'] = {};
  for (const definition of input.manifest.locations) {
    const prepared = preparedLocations[definition.id];
    const previous = existing?.locations[definition.id];
    if (!prepared && !previous) continue;
    const manifestDefinesPanoIds = definition.panoIds !== undefined;
    const manifestDefinesDefaultPano = Object.prototype.hasOwnProperty.call(
      definition,
      'defaultPanoId',
    );
    const configuredDefaultPanoId = manifestDefinesDefaultPano
      ? definition.defaultPanoId
      : previous?.defaultPanoId;
    const panoIds = [...new Set([
      ...(manifestDefinesPanoIds ? definition.panoIds ?? [] : previous?.panoIds ?? []),
      ...(typeof configuredDefaultPanoId === 'string' ? [configuredDefaultPanoId] : []),
    ])];
    locations[definition.id] = prepared
      ? {
          id: definition.id,
          objectIds: prepared.objectIds.filter((objectId) => !boundDynamicObjectIds.has(objectId)),
          objectGroupIds: [],
          anchors: Object.fromEntries(Object.entries(prepared.anchors).map(([key, position]) => [
            key,
            { position: [...position] },
          ])),
          blockerObjectIds: prepared.blockerObjectIds.filter((objectId) => !boundDynamicObjectIds.has(objectId)),
          ...(panoIds.length > 0 ? { panoIds } : {}),
          ...(typeof configuredDefaultPanoId === 'string'
            ? { defaultPanoId: configuredDefaultPanoId }
            : {}),
        }
      : structuredClone(previous!);
    bindings[definition.id] = { kind: 'location', locationId: definition.id };
  }

  const shotContracts: Record<string, ShotProductionContract> = {};
  for (const definition of input.manifest.shots) {
    const shot = input.project.shots.find((candidate) => (
      candidate.shotNumber === definition.shotNumber
      || candidate.productionShotId === definition.id
    ));
    const contractId = shot?.id ?? definition.id;
    const entityIds = [...new Set([
      ...definition.subjects,
      ...definition.camera.subjects,
      ...(definition.camera.foregroundSubject ? [definition.camera.foregroundSubject] : []),
      ...(definition.requirements?.visibleSubjects ?? []),
      ...(definition.requirements?.visibleProps ?? []),
    ])];
    const visibleEntityIds = [...new Set([
      ...(definition.requirements?.visibleSubjects ?? definition.subjects),
      ...definition.camera.subjects,
      ...(definition.camera.foregroundSubject ? [definition.camera.foregroundSubject] : []),
      ...(definition.requirements?.visibleProps ?? []),
    ])];
    const expectedVisibleObjectIds: string[] = [];
    const expectedVisibleGroupIds: string[] = [];
    for (const entityId of visibleEntityIds) {
      const binding = bindings[entityId];
      if (binding?.kind === 'object') expectedVisibleObjectIds.push(binding.objectId);
      if (binding?.kind === 'group') expectedVisibleGroupIds.push(binding.groupId);
    }
    const presenceState = {
      expectedVisibleObjectIds: [...new Set(expectedVisibleObjectIds)],
      expectedVisibleGroupIds: [...new Set(expectedVisibleGroupIds)],
    };
    const location = input.manifest.locations.find((candidate) => candidate.id === definition.locationId);
    const preparedLocation = location ? locations[location.id] : undefined;
    const preparedPanoId = preparedLocation?.defaultPanoId ?? preparedLocation?.panoIds?.[0];
    const manifestExplicitlyUnlinksPanorama = location?.defaultPanoId === null;
    const greenfieldWithoutPanorama = Boolean(location)
      && input.manifest.project.operatingMode !== 'existing-project-refinement'
      && !preparedPanoId;
    const environment = location && preparedLocation
      ? manifestExplicitlyUnlinksPanorama || greenfieldWithoutPanorama
        ? {
            locationId: location.id,
            expectNoPanorama: true,
            requireProjection: false,
          }
        : preparedPanoId
          ? {
              locationId: location.id,
              expectedPanoId: preparedPanoId,
              requireProjection: true,
            }
          : undefined
      : undefined;
    const capabilityRequirements = entityIds.flatMap((entityId) => {
      const binding = bindings[entityId];
      if (!binding) return [];
      const cast = input.manifest.cast.find((candidate) => candidate.id === entityId);
      return [{
        entityId,
        requires: {
          renderable: true,
          ...(binding.kind === 'group' ? { rigidAssembly: true } : {}),
          ...(cast?.type === 'imported_character'
            ? {
                poseable: true,
                deforming: true,
                ...(definition.motion ? { timelinePoseable: true } : {}),
              }
            : {}),
        },
      }];
    });
    const actions = deriveShotActionContracts(definition, {
      poseableEntityIds: new Set(input.manifest.cast.map((entry) => entry.id)),
      resolvePose: (entityId, requestedPose) => resolveProductionPose({
        project: input.project,
        entityId,
        requestedPose,
        shotId: definition.id,
      }),
    });
    const requireCompleteAssembly = [
      'establishing',
      'wide',
      'full',
      'two_shot',
      'insert',
      'profile',
      'low_angle',
      'high_angle',
      'overhead',
    ].includes(definition.camera.template);
    const compositionSubjects = [...new Set([
      ...definition.camera.subjects,
      ...(definition.camera.foregroundSubject ? [definition.camera.foregroundSubject] : []),
    ])]
      .filter((entityId) => Boolean(bindings[entityId]))
      .map((entityId) => ({
        entityId,
        completeAssemblyInFrame: requireCompleteAssembly,
      }));
    const occlusionIntent = definition.camera.foregroundSubject && definition.camera.subjects[0]
      ? [{
          foregroundEntityId: definition.camera.foregroundSubject,
          backgroundEntityId: definition.camera.subjects[0],
        }]
      : undefined;
    shotContracts[contractId] = {
      presence: {
        ...presenceState,
        allowUnspecifiedDynamicObjects: false,
        ...(definition.motion
          ? {
              base: structuredClone(presenceState),
              timeline: definition.motion.keyframes.map((keyframe) => ({
                timeSeconds: keyframe.timeSeconds,
                ...structuredClone(presenceState),
              })),
            }
          : {}),
      },
      ...(environment ? { environment } : {}),
      ...(compositionSubjects.length > 0
        ? {
            composition: {
              subjects: compositionSubjects,
              ...(occlusionIntent ? { occlusionIntent } : {}),
            },
          }
        : {}),
      ...(capabilityRequirements.length > 0 ? { capabilityRequirements } : {}),
      ...(actions.length > 0 ? { actions } : {}),
    };
  }

  return {
    schemaVersion: 1,
    bindings,
    locations,
    shotContracts,
    ...(existing?.poseSubstitutions
      ? { poseSubstitutions: structuredClone(existing.poseSubstitutions) }
      : {}),
  };
}

export function getAgentManifestBindings(): Record<string, string> {
  return readPersistedManifestBindings();
}

export function previewAgentProductionCompile(input: { manifest: unknown }): AgentProductionCompilePreviewResult {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      diagnostics: mapPrevisDiagnostics(parsed.errors),
    };
  }

  const project = useProjectStore.getState().project;
  const entityBindings = buildProductionCompileEntityBindings(project);
  const locationBindings = buildProductionCompileLocationBindings(project);
  const result = compileProduction(parsed.manifest, {
    assetBindings: readCompileAssetBindings(project),
    entityBindings,
    locationBindings,
    presenceProject: project,
    existingShotIds: existingShotIdsForManifest(project, parsed.manifest),
  });
  const setupPlans = plansForProductionCompile(result);
  const mergedPlan = mergeAgentPlans(setupPlans);
  const chained = chainPreparePlans([mergedPlan], readLiveSource());
  if (!chained.ok) {
    return { ok: false, diagnostics: chained.diagnostics };
  }

  return {
    ok: result.ok,
    planCount: setupPlans.length,
    commandCount: chained.commandCount,
    diagnostics: mapPrevisDiagnostics(result.diagnostics.filter((item) => item.severity === 'error')),
  };
}

export async function applyAgentProductionCompile(input: {
  manifest: unknown;
  preserveCurrentAsRecovery?: boolean;
  onlyShotIds?: string[];
}) {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      diagnostics: [writeAccessRequiredDiagnostic('applyProductionCompile')],
    };
  }

  const preview = previewAgentProductionCompile({ manifest: input.manifest });
  if (!preview.ok) {
    return { ok: false, diagnostics: preview.diagnostics };
  }

  const parsed = parsePrevisProductionManifest(input.manifest);
  if (!parsed.manifest) {
    return { ok: false, diagnostics: preview.diagnostics };
  }

  const project = useProjectStore.getState().project;
  const onlyShotIds = new Set(input.onlyShotIds ?? []);
  const skipShotNumbers = onlyShotIds.size > 0
    ? new Set(parsed.manifest.shots
      .filter((shot) => !onlyShotIds.has(shot.id))
      .map((shot) => shot.shotNumber))
    : undefined;
  const entityBindings = buildProductionCompileEntityBindings(project);
  const locationBindings = buildProductionCompileLocationBindings(project);
  const result = compileProduction(parsed.manifest, {
    assetBindings: readCompileAssetBindings(project),
    entityBindings,
    locationBindings,
    presenceProject: project,
    existingShotIds: existingShotIdsForManifest(project, parsed.manifest),
    ...(skipShotNumbers ? { skipShotNumbers } : {}),
  });
  const setupPlans = plansForProductionCompile(result);
  const mergedPlan = mergeAgentPlans(setupPlans);
  const chained = chainPreparePlans([mergedPlan], readLiveSource());
  if (!chained.ok) {
    return { ok: false, diagnostics: chained.diagnostics };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }

  const baseFingerprint = projectFingerprint(readLiveSource().project);

  try {
    if (input.preserveCurrentAsRecovery) {
      await runDestructive('Recovery snapshot before production compile', async () => {
        // Snapshot only — compile commit follows.
      });
    }

    const verified = await runDestructive('Apply production compile', () => {
      const live = useProjectStore.getState().project;
      if (projectFingerprint(live) !== baseFingerprint) {
        throw new Error('Project changed before production compile could be committed.');
      }
      commitPreparedPlanToStore(chained.lastPrepared);
    });

    return {
      ok: true,
      revisionId: verified?.revision.id,
      diagnostics: mapPrevisDiagnostics(result.diagnostics.filter((item) => item.severity === 'warning')),
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError(
        'compile_apply_failed',
        error instanceof Error ? error.message : 'Production compile apply failed.',
      )],
    };
  }
}

export function inspectAgentProductionStatus() {
  const project = useProjectStore.getState().project;
  const bindings = readPersistedManifestBindings();
  return {
    manifestBound: Object.keys(bindings).length > 0,
    shotCount: project.shots.length,
    bindingCount: Object.keys(bindings).length,
    diagnostics: [],
  };
}
