import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBlankGrayboxProject } from '../src/engine/previs/blankProject';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import { createDefaultProject, createSceneObject, createShot } from '../src/domain/defaults';
import type { LocationProject, ObjectGroup, Transform } from '../src/domain/types';
import { createId } from '../src/utils/ids';
import { inspectAgentShotDiagnostics } from '../src/engine/agent/shotDiagnostics';
import { identifyFloorY } from '../src/engine/agent/spatialShotState';
import {
  createAgentObjectGroup,
  inspectAgentObjectGroup,
  listAgentObjectGroups,
  stageAgentObjectGroup,
} from '../src/engine/agent/objectGroupControl';
import {
  getAgentLoadedProjectSource,
  markAgentProjectSource,
} from '../src/engine/agent/projectImportControl';
import {
  listAgentArtifacts,
  registerAgentArtifact,
  resetAgentArtifactRegistryForTests,
} from '../src/engine/agent/artifactRegistry';
import {
  submitAgentJob,
  getAgentJob,
  cancelAgentJob,
  resumeAgentJob,
  resetAgentJobsForTests,
  waitForAgentJob,
} from '../src/engine/agent/jobQueue';
import {
  applyAgentProductionCompile,
  bindAgentManifestAssets,
  inspectAgentProductionStatus,
  resetAgentProductionManifestBindingsForTests,
} from '../src/engine/agent/productionManifestControl';
import {
  bindAgentProductionEntity,
  defineAgentProductionLocation,
  approveAgentPoseSubstitution,
  inspectAgentEntityCapability,
  inspectAgentProductionConfiguration,
  removeAgentProductionBinding,
  resolveAgentProductionPose,
  validateAgentProductionCapabilities,
  validateAgentProductionConfiguration,
} from '../src/engine/agent/productionConfigurationControl';
import {
  inspectAgentShotPresence,
  repairAgentShotPresence,
  setAgentShotPresenceContract,
} from '../src/engine/agent/shotPresenceControl';
import { deriveDynamicObjectUniverse } from '../src/engine/previs/shotPresence';
import { restoreAgentProjectRevision } from '../src/engine/agent/projectHealthControl';
import { setAgentJointRotation } from '../src/engine/agent/poseControl';
import {
  setAgentRenderShotFrameImpl,
  resetAgentRenderShotFrameImplForTests,
} from '../src/engine/agent/renderCallbackRegistry';
import { buildInlineArtifact } from '../src/engine/agent/renderResult';
import { projectFingerprint } from '../src/engine/agent/planDiff';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

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

describe('agent API robustness', () => {
  beforeEach(() => {
    useAgentControlStore.getState().setControlMode('read-write');
    useProjectStore.getState().setProject(createDefaultProject());
    installMockDestructiveMutation();
    resetAgentArtifactRegistryForTests();
    resetAgentJobsForTests();
    resetAgentProductionManifestBindingsForTests();
    resetAgentRenderShotFrameImplForTests();
  });

  afterEach(() => {
    useAgentControlStore.getState().setControlMode('off');
    resetAgentArtifactRegistryForTests();
    resetAgentJobsForTests();
    resetAgentProductionManifestBindingsForTests();
    resetAgentRenderShotFrameImplForTests();
  });

  it('reports missing diagnostic subjects instead of silently skipping them', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const diagnostics = inspectAgentShotDiagnostics({
      project,
      shot,
      subjectIds: ['missing-subject-id'],
    });
    expect(diagnostics.subjects).toHaveLength(0);
    expect(diagnostics.diagnostics.some((item) => item.code === 'subject_missing')).toBe(true);
  });

  it('uses shot-effective floors for grounding diagnostics', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [10, 0.1, 10];
    floor.transform.position = [0, 0, 0];

    const hiddenFloor = createSceneObject('floor', 1);
    hiddenFloor.dimensions = [10, 0.1, 10];
    hiddenFloor.transform.position = [0, 5, 0];

    const actor = createSceneObject('human_dummy', 1, [0, 1, 0]);
    const project: LocationProject = {
      ...createDefaultProject(),
      scene: {
        ...createDefaultProject().scene,
        objects: [floor, hiddenFloor, actor],
      },
    };
    const shot = createShot({
      index: 1,
      camera: project.shots[0]!.camera,
    });
    shot.objectOverrides = {
      [hiddenFloor.id]: { visible: false },
    };
    project.shots = [shot];

    const baseFloorY = identifyFloorY(project, actor.transform.position);
    const effectiveObjects = project.scene.objects.map((object) => (
      object.id === hiddenFloor.id ? { ...object, visible: false } : object
    ));
    const effectiveFloorY = identifyFloorY(project, actor.transform.position, effectiveObjects);
    expect(baseFloorY).toBeGreaterThan(4);
    expect(effectiveFloorY).toBeLessThan(1);
  });

  it('creates and inspects logical object groups', async () => {
    const project = useProjectStore.getState().project;
    const a = createSceneObject('box', 1);
    const b = createSceneObject('box', 1);
    useProjectStore.setState({
      project: {
        ...project,
        scene: { ...project.scene, objects: [...project.scene.objects, a, b] },
      },
    });

    const result = await createAgentObjectGroup({
      name: 'Creature parts',
      objectIds: [a.id, b.id],
    });
    expect(result.ok).toBe(true);
    expect(result.groupId).toBeTruthy();

    const group = inspectAgentObjectGroup(result.groupId!);
    expect(group?.objectIds).toEqual([a.id, b.id]);
    expect(listAgentObjectGroups().length).toBe(1);
  });

  it('preserves pairwise member offsets when staging object groups', async () => {
    const project = useProjectStore.getState().project;
    const shotId = project.shots[0]!.id;
    const a = createSceneObject('box', 1, [0, 0, 0]);
    const b = createSceneObject('box', 1, [2, 0, 0]);
    useProjectStore.setState({
      project: {
        ...project,
        scene: { ...project.scene, objects: [...project.scene.objects, a, b] },
      },
    });

    const created = await createAgentObjectGroup({ name: 'Pair', objectIds: [a.id, b.id] });
    expect(created.ok).toBe(true);

    const groupTransform: Transform = {
      position: [5, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    const staged = await stageAgentObjectGroup({
      shotId,
      groupId: created.groupId!,
      transform: groupTransform,
    });
    expect(staged.ok).toBe(true);

    const updated = useProjectStore.getState().project;
    const shot = updated.shots.find((candidate) => candidate.id === shotId)!;
    const overrideA = shot.objectOverrides?.[a.id]?.transform?.position;
    const overrideB = shot.objectOverrides?.[b.id]?.transform?.position;
    expect(overrideA).toBeTruthy();
    expect(overrideB).toBeTruthy();
    const offsetX = overrideB![0] - overrideA![0];
    expect(offsetX).toBeCloseTo(2, 3);
  });

  it('tracks loaded project source metadata', () => {
    markAgentProjectSource('import', 'demo.fsp');
    const source = getAgentLoadedProjectSource();
    expect(source.source).toBe('import');
    expect(source.sourceLabel).toBe('demo.fsp');
  });

  it('executes render-shot-batch jobs and registers artifacts', async () => {
    setAgentRenderShotFrameImpl(async (input) => ({
      ok: true,
      status: 'completed',
      shotId: input.shotId,
      revisionId: 'rev_test',
      width: 64,
      height: 64,
      artifact: buildInlineArtifact({
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      }),
      pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      diagnostics: [],
    }));

    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_a' }, { shotId: 'shot_b' }],
      concurrency: 1,
    });
    expect(submitted.ok).toBe(true);

    const progress = await waitForAgentJob(submitted.jobId!);
    expect(progress.status).toBe('completed');
    expect(progress.completedItems).toBe(2);
    expect(progress.artifactIds?.length).toBe(2);
    expect(listAgentArtifacts({ jobId: submitted.jobId }).length).toBe(2);
  });

  it('submits and cancels async jobs', () => {
    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: ['a', 'b', 'c'],
      concurrency: 1,
    });
    expect(submitted.ok).toBe(true);
    expect(submitted.jobId).toBeTruthy();

    const job = getAgentJob(submitted.jobId!);
    expect(job?.totalItems).toBe(3);

    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(true);
  });

  it('produces pass-matrix artifacts for each shot and pass combination', async () => {
    setAgentRenderShotFrameImpl(async (input) => ({
      ok: true,
      status: 'completed',
      shotId: input.shotId,
      revisionId: 'rev_test',
      width: 32,
      height: 32,
      artifact: buildInlineArtifact({
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      }),
      pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      diagnostics: [],
    }));

    const submitted = submitAgentJob({
      type: 'render-pass-matrix',
      shotIds: ['shot_1', 'shot_2'],
      passes: ['clay', 'depth'],
      concurrency: 2,
    });
    const progress = await waitForAgentJob(submitted.jobId!);
    expect(progress.completedItems).toBe(4);
    expect(progress.artifactIds?.length).toBe(4);
  });

  it('lists registered artifacts with filters', () => {
    registerAgentArtifact({
      blob: new Blob(['test'], { type: 'image/png' }),
      mimeType: 'image/png',
      fileName: 'shot.png',
      revisionId: 'rev_test',
      shotId: 'shot_1',
    });
    const listed = listAgentArtifacts({ shotId: 'shot_1' });
    expect(listed.length).toBe(1);
    expect(listed[0]?.fileName).toBe('shot.png');
  });

  it('binds manifest assets and reports manifestBound status', async () => {
    const manifest = {
      version: 1 as const,
      project: { name: 'Demo', aspectRatio: '16:9' },
      cast: [{ id: 'hero', name: 'Hero', type: 'human_dummy', height: 1.75, defaultPose: 'standing-neutral' }],
      locations: [{ id: 'loc', name: 'Loc', template: 'interior_room' }],
      shots: [{
        id: 'shot_1',
        shotNumber: '001',
        name: 'Hero shot',
        description: 'Hero in room.',
        locationId: 'loc',
        subjects: ['hero'],
        camera: { template: 'medium', subjects: ['hero'] },
      }],
    };
    const heroObject = useProjectStore.getState().project.scene.objects.find((object) => object.type === 'human_dummy');
    expect(heroObject).toBeTruthy();

    const bound = await bindAgentManifestAssets({
      manifest,
      bindings: { hero: heroObject!.id },
    });
    expect(bound.ok).toBe(true);
    const status = inspectAgentProductionStatus();
    expect(status.manifestBound).toBe(true);
    expect(status.bindingCount).toBe(1);
    expect(useProjectStore.getState().project.workflow.productionManifestAssetBindings?.hero).toBe(heroObject!.id);
  });

  it('persists typed production bindings and validates a prepared location', async () => {
    const project = useProjectStore.getState().project;
    const heroObject = project.scene.objects.find((object) => object.type === 'human_dummy')!;
    const wall = project.scene.objects.find((object) => object.type === 'wall')!;
    const manifest = {
      version: 1 as const,
      project: { name: 'Prepared Demo', aspectRatio: '16:9' as const },
      cast: [{ id: 'hero', name: 'Hero', type: 'human_dummy' as const }],
      locations: [{ id: 'loc', name: 'Loc', template: 'interior_room' as const }],
      shots: [{
        id: 'shot_1',
        shotNumber: '001',
        name: 'Hero shot',
        description: 'Hero in room.',
        locationId: 'loc',
        subjects: ['hero'],
        camera: { template: 'medium' as const, subjects: ['hero'] },
      }],
    };

    const location = await defineAgentProductionLocation({
      location: {
        id: 'loc',
        objectIds: [wall.id],
        objectGroupIds: [],
        anchors: {},
        blockerObjectIds: [],
      },
    });
    expect(location.ok, JSON.stringify(location.diagnostics)).toBe(true);

    const heroBinding = await bindAgentProductionEntity({
      entityId: 'hero',
      binding: { kind: 'object', objectId: heroObject.id },
    });
    expect(heroBinding.ok, JSON.stringify(heroBinding.diagnostics)).toBe(true);
    const locationBinding = await bindAgentProductionEntity({
      entityId: 'loc',
      binding: { kind: 'location', locationId: 'loc' },
    });
    expect(locationBinding.ok, JSON.stringify(locationBinding.diagnostics)).toBe(true);

    const inspection = inspectAgentProductionConfiguration();
    expect(inspection.bindings.hero).toEqual({ kind: 'object', objectId: heroObject.id });
    expect(inspection.locations.loc.objectIds).toEqual([wall.id]);

    const validation = validateAgentProductionConfiguration({ manifest });
    expect(validation.ok, JSON.stringify(validation.diagnostics)).toBe(true);

    const capability = inspectAgentEntityCapability({ entityId: 'hero' });
    expect(capability.readiness).toBe('ready');
    const approximate = resolveAgentProductionPose({ entityId: 'hero', requestedPose: 'running' });
    expect(approximate.relationship).toBe('approximate');
    const approved = await approveAgentPoseSubstitution({
      approval: {
        entityId: 'hero',
        requestedPose: 'running',
        resolvedPose: 'walking',
        relationship: 'approved_substitute',
        requiresReview: false,
      },
    });
    expect(approved.ok, JSON.stringify(approved.diagnostics)).toBe(true);
    expect(resolveAgentProductionPose({ entityId: 'hero', requestedPose: 'running' }).relationship).toBe('approved_substitute');
    expect(validateAgentProductionCapabilities({ manifest }).ok).toBe(true);

    const removed = await removeAgentProductionBinding({ entityId: 'hero' });
    expect(removed.ok, JSON.stringify(removed.diagnostics)).toBe(true);
    expect(inspectAgentProductionConfiguration().bindings.hero).toBeUndefined();
  });

  it('sets, verifies, and repairs a closed-world shot presence contract', async () => {
    const before = useProjectStore.getState().project;
    const shot = before.shots[0]!;
    const extra = createSceneObject('human_dummy', 2);
    useProjectStore.setState({
      project: {
        ...before,
        scene: { ...before.scene, objects: [...before.scene.objects, extra] },
      },
    });
    const dynamicBefore = deriveDynamicObjectUniverse(useProjectStore.getState().project)
      .map((item) => item.objectId)
      .filter((objectId) => objectId !== extra.id);

    const set = await setAgentShotPresenceContract({
      shotId: shot.id,
      contract: {
        expectedVisibleObjectIds: dynamicBefore,
        expectedVisibleGroupIds: [],
        allowUnspecifiedDynamicObjects: false,
      },
    });
    expect(set.ok, JSON.stringify(set.diagnostics)).toBe(true);

    const failed = inspectAgentShotPresence({ shotId: shot.id });
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics.some((item) => (
      item.code === 'unexpected_dynamic_object' && item.message.includes(extra.id)
    ))).toBe(true);

    const repaired = await repairAgentShotPresence({ shotId: shot.id });
    expect(repaired.ok, JSON.stringify(repaired.diagnostics)).toBe(true);
    expect(repaired.inspection?.ok).toBe(true);
    expect(repaired.inspection?.actualVisibleObjectIds).not.toContain(extra.id);
  });

  it('blocks restoreProjectRevision in read-only mode', async () => {
    const before = projectFingerprint(useProjectStore.getState().project);
    useAgentControlStore.getState().setControlMode('read-only');
    const result = await restoreAgentProjectRevision({ revisionId: 'rev_fake' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === 'write_access_required')).toBe(true);
    expect(projectFingerprint(useProjectStore.getState().project)).toBe(before);
  });

  it('creates pose keyframes when timeSeconds is supplied', async () => {
    const project = useProjectStore.getState().project;
    const shotId = project.shots[0]!.id;
    const object = project.scene.objects.find((candidate) => candidate.type === 'human_dummy');
    expect(object).toBeTruthy();

    const result = await setAgentJointRotation({
      objectId: object!.id,
      shotId,
      timeSeconds: 1.5,
      jointId: 'rightLowerArm',
      rotation: [10, 0, 0],
    });
    expect(result.ok).toBe(true);

    const shot = useProjectStore.getState().project.shots.find((candidate) => candidate.id === shotId)!;
    const keyframe = shot.cameraKeyframes?.find((candidate) => candidate.timeSeconds === 1.5);
    expect(keyframe).toBeTruthy();
    expect(keyframe?.objectOverrides?.[object!.id]?.humanPose?.joints.rightLowerArm).toBeTruthy();
    expect(shot.objectOverrides?.[object!.id]?.humanPose).toBeUndefined();
  });

  it('skips cast create commands when manifest assets are bound', async () => {
    const { compileProduction } = await import('../src/engine/previs/productionCompiler');
    const manifest = {
      version: 1 as const,
      project: { name: 'Demo', aspectRatio: '16:9' as const },
      cast: [{ id: 'hero', name: 'Hero', type: 'human_dummy', height: 1.75, defaultPose: 'standing-neutral' }],
      locations: [{ id: 'loc', name: 'Loc', template: 'interior_room' as const }],
      shots: [{
        id: 'shot_1',
        shotNumber: '001',
        name: 'Hero shot',
        description: 'Hero in room.',
        locationId: 'loc',
        subjects: ['hero'],
        camera: { template: 'medium', subjects: ['hero'] },
      }],
    };
    const heroObject = useProjectStore.getState().project.scene.objects.find((object) => object.type === 'human_dummy');
    await bindAgentManifestAssets({
      manifest,
      bindings: { hero: heroObject!.id },
    });

    const result = compileProduction(manifest as PrevisProductionManifestV1, {
      assetBindings: { hero: heroObject!.id },
    });
    expect(result.cast.plan.commands.length).toBe(0);
    expect(result.cast.context.entities['cast.hero']?.objectId).toBe(heroObject!.id);
  });

  it('applyProductionCompile authors every manifest shot in the project', async () => {
    useProjectStore.getState().setProject(createBlankGrayboxProject({
      name: 'Production compile test',
      aspectRatio: '16:9',
    }));

    const manifest = JSON.parse(
      readFileSync(path.resolve('examples/previs/minimal-dialogue.json'), 'utf8'),
    ) as { shots: Array<{ shotNumber: string }> };
    const manifestShotNumbers = manifest.shots.map((shot) => shot.shotNumber);

    const result = await applyAgentProductionCompile({ manifest });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);

    const projectShotNumbers = new Set(
      useProjectStore.getState().project.shots.map((shot) => shot.shotNumber),
    );
    for (const shotNumber of manifestShotNumbers) {
      expect(projectShotNumbers.has(shotNumber)).toBe(true);
    }
  });

  it('does not mark failed job items complete when continueOnError is false', async () => {
    setAgentRenderShotFrameImpl(async () => {
      throw new Error('Simulated render failure.');
    });

    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_retry' }],
      continueOnError: false,
    });
    expect(submitted.ok).toBe(true);

    const failed = await waitForAgentJob(submitted.jobId!);
    expect(failed.status).toBe('failed');
    expect(failed.completedItems).toBe(0);

    let renderCalls = 0;
    setAgentRenderShotFrameImpl(async (input) => {
      renderCalls += 1;
      return {
        ok: true,
        status: 'completed',
        shotId: input.shotId,
        revisionId: 'rev_retry',
        width: 32,
        height: 32,
        artifact: buildInlineArtifact({
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }),
        pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        diagnostics: [],
      };
    });

    const resumed = await resumeAgentJob(submitted.jobId!);
    expect(resumed.ok).toBe(true);

    const completed = await waitForAgentJob(submitted.jobId!, { timeoutMs: 5000 });
    expect(completed.status).toBe('completed_with_warnings');
    expect(completed.completedItems).toBe(1);
    expect(renderCalls).toBe(1);
  }, 15000);
});
