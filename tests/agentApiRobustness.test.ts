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
  getAgentArtifactHandle,
  listAgentArtifacts,
  registerAgentArtifact,
  resetAgentArtifactRegistryForTests,
} from '../src/engine/agent/artifactRegistry';
import {
  submitAgentJob,
  getAgentJob,
  cancelAgentJob,
  pauseAgentJob,
  resumeAgentJob,
  resetAgentJobsForTests,
  waitForAgentJob,
  inspectAgentJobRunForTests,
} from '../src/engine/agent/jobQueue';
import {
  resetAgentJobHandlersForTests,
  setAgentJobHandlerForTests,
} from '../src/engine/agent/jobHandlers';
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

async function waitForJobGenerationDrain(jobId: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (inspectAgentJobRunForTests(jobId)?.hasActiveRun) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Job ${jobId} generation did not drain within ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    resetAgentJobHandlersForTests();
    resetAgentProductionManifestBindingsForTests();
    resetAgentRenderShotFrameImplForTests();
  });

  afterEach(() => {
    useAgentControlStore.getState().setControlMode('off');
    resetAgentArtifactRegistryForTests();
    resetAgentJobsForTests();
    resetAgentJobHandlersForTests();
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
    for (const artifact of listAgentArtifacts({ jobId: submitted.jobId })) {
      expect(artifact.pinned).toBe(true);
      expect(artifact.pinReason).toBe('authoritative');
    }
  });

  it('pins job results as in-flight while running and clears inFlight after success, failure, and cancel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setAgentRenderShotFrameImpl(async (input) => {
      await gate;
      return {
        ok: true,
        status: 'completed',
        shotId: input.shotId,
        revisionId: 'rev_test',
        width: 16,
        height: 16,
        artifact: buildInlineArtifact({
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }),
        pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        diagnostics: [],
      };
    });

    const inFlightHandle = registerAgentArtifact({
      blob: new Blob(['busy'], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileName: 'busy.txt',
      inFlight: true,
      authoritative: true,
    });
    expect(getAgentArtifactHandle(inFlightHandle.artifactId)?.pinReason).toBe('in-flight');

    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_live' }],
      concurrency: 1,
    });
    release();
    const progress = await waitForAgentJob(submitted.jobId!);
    expect(progress.status).toBe('completed');
    const settled = listAgentArtifacts({ jobId: submitted.jobId });
    expect(settled.length).toBe(1);
    expect(settled[0]?.pinReason).toBe('authoritative');
    expect(settled[0]?.pinned).toBe(true);

    setAgentRenderShotFrameImpl(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      throw new Error('render failed');
    });
    const failed = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_fail' }],
      concurrency: 1,
      continueOnError: true,
    });
    const failedProgress = await waitForAgentJob(failed.jobId!);
    expect(failedProgress.status === 'completed_with_warnings' || failedProgress.status === 'failed').toBe(true);
    expect(listAgentArtifacts({ jobId: failed.jobId }).every((item) => item.pinReason !== 'in-flight')).toBe(true);

    setAgentRenderShotFrameImpl(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        ok: true,
        status: 'completed',
        shotId: input.shotId,
        revisionId: 'rev_test',
        width: 16,
        height: 16,
        artifact: buildInlineArtifact({
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }),
        pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        diagnostics: [],
      };
    });
    const cancellable = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_cancel_a' }, { shotId: 'shot_cancel_b' }],
      concurrency: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = cancelAgentJob(cancellable.jobId!);
    expect(cancelled.ok).toBe(true);
    const leftover = listAgentArtifacts({ jobId: cancellable.jobId });
    for (const artifact of leftover) {
      expect(artifact.pinReason).not.toBe('in-flight');
      expect(artifact.pinned).toBe(true);
      expect(artifact.pinReason).toBe('authoritative');
    }
  });

  it('settles a missing-handler job with a terminal timestamp and no in-flight pins', async () => {
    const leftover = registerAgentArtifact({
      blob: new Blob(['pending'], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileName: 'pending.txt',
      inFlight: true,
      authoritative: true,
    });
    const submitted = submitAgentJob({
      type: 'not-a-real-job' as 'custom',
      jobs: [{ shotId: 'shot_missing' }],
    });
    expect(submitted.ok).toBe(true);
    const progress = await waitForAgentJob(submitted.jobId!);
    expect(progress.status).toBe('failed');
    expect(progress.finishedAt).toEqual(expect.any(Number));
    expect(progress.errors?.[0]?.code).toBe('job_handler_missing');
    expect(listAgentArtifacts({ jobId: submitted.jobId }).every((item) => item.pinReason !== 'in-flight')).toBe(true);
    expect(getAgentArtifactHandle(leftover.artifactId)?.pinReason).toBe('in-flight');
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

  it('leaves completed and failed jobs unchanged when cancel is requested', async () => {
    setAgentRenderShotFrameImpl(async (input) => ({
      ok: true,
      status: 'completed',
      shotId: input.shotId,
      revisionId: 'rev_test',
      width: 16,
      height: 16,
      artifact: buildInlineArtifact({
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      }),
      pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      diagnostics: [],
    }));
    const completed = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_done' }],
    });
    const completedProgress = await waitForAgentJob(completed.jobId!);
    expect(completedProgress.status).toBe('completed');
    expect(completedProgress.finishedAt).toEqual(expect.any(Number));
    const completedArtifacts = listAgentArtifacts({ jobId: completed.jobId });
    expect(completedArtifacts.length).toBe(1);
    expect(completedArtifacts[0]?.pinReason).toBe('authoritative');

    const completedCancel = cancelAgentJob(completed.jobId!);
    expect(completedCancel.ok).toBe(false);
    expect(completedCancel.status).toBe('completed');
    expect(completedCancel.diagnostics[0]?.code).toBe('job_already_terminal');
    const afterCompletedCancel = getAgentJob(completed.jobId!);
    expect(afterCompletedCancel?.status).toBe('completed');
    expect(afterCompletedCancel?.finishedAt).toBe(completedProgress.finishedAt);
    expect(afterCompletedCancel?.artifactIds).toEqual(completedProgress.artifactIds);
    expect(afterCompletedCancel?.message).toBe(completedProgress.message);
    expect(listAgentArtifacts({ jobId: completed.jobId })[0]?.pinReason).toBe('authoritative');

    const secondCancel = cancelAgentJob(completed.jobId!);
    expect(secondCancel.ok).toBe(false);
    expect(secondCancel.status).toBe('completed');
    expect(getAgentJob(completed.jobId!)?.finishedAt).toBe(completedProgress.finishedAt);

    pauseAgentJob(completed.jobId!);
    expect(getAgentJob(completed.jobId!)?.status).toBe('completed');
    expect(getAgentJob(completed.jobId!)?.finishedAt).toBe(completedProgress.finishedAt);

    setAgentRenderShotFrameImpl(async () => {
      throw new Error('render failed');
    });
    const failed = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_fail_terminal' }],
      continueOnError: false,
    });
    const failedProgress = await waitForAgentJob(failed.jobId!);
    expect(failedProgress.status === 'failed' || failedProgress.status === 'completed_with_warnings').toBe(true);
    expect(failedProgress.finishedAt).toEqual(expect.any(Number));
    const failedCancel = cancelAgentJob(failed.jobId!);
    expect(failedCancel.ok).toBe(false);
    expect(failedCancel.status).toBe(failedProgress.status);
    expect(failedCancel.diagnostics[0]?.code).toBe('job_already_terminal');
    const afterFailedCancel = getAgentJob(failed.jobId!);
    expect(afterFailedCancel?.status).toBe(failedProgress.status);
    expect(afterFailedCancel?.finishedAt).toBe(failedProgress.finishedAt);
    expect(afterFailedCancel?.errors).toEqual(failedProgress.errors);
  });

  it('cancels an active job and treats a later cancel as a no-op', async () => {
    setAgentRenderShotFrameImpl(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        ok: true,
        status: 'completed',
        shotId: input.shotId,
        revisionId: 'rev_test',
        width: 16,
        height: 16,
        artifact: buildInlineArtifact({
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }),
        pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        diagnostics: [],
      };
    });
    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_active_a' }, { shotId: 'shot_active_b' }],
      concurrency: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    const progress = getAgentJob(submitted.jobId!);
    expect(progress?.status).toBe('cancelled');
    expect(progress?.finishedAt).toEqual(expect.any(Number));
    const firstFinishedAt = progress?.finishedAt;

    const again = cancelAgentJob(submitted.jobId!);
    expect(again.ok).toBe(false);
    expect(again.status).toBe('cancelled');
    expect(again.diagnostics[0]?.code).toBe('job_already_terminal');
    expect(getAgentJob(submitted.jobId!)?.finishedAt).toBe(firstFinishedAt);
    expect(getAgentJob(submitted.jobId!)?.artifactIds).toEqual(progress?.artifactIds);
    expect(listAgentArtifacts({ jobId: submitted.jobId }).every((item) => item.pinReason !== 'in-flight')).toBe(true);
  });

  it('does not treat pause as a terminal finishedAt and clears it on resume', async () => {
    let releaseFirst!: () => void;
    let firstStarted = false;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    setAgentRenderShotFrameImpl(async (input) => {
      if (!firstStarted) {
        firstStarted = true;
        await firstGate;
      }
      return {
        ok: true,
        status: 'completed',
        shotId: input.shotId,
        revisionId: 'rev_test',
        width: 16,
        height: 16,
        artifact: buildInlineArtifact({
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }),
        pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        diagnostics: [],
      };
    });
    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_pause_a' }, { shotId: 'shot_pause_b' }],
      concurrency: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    pauseAgentJob(submitted.jobId!);
    const paused = getAgentJob(submitted.jobId!);
    expect(paused?.status).toBe('paused');
    expect(paused?.finishedAt).toBeUndefined();

    let resumeSettled = false;
    const resumePromise = resumeAgentJob(submitted.jobId!).then((result) => {
      resumeSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resumeSettled).toBe(false);
    expect(getAgentJob(submitted.jobId!)?.status).toBe('paused');
    expect(getAgentJob(submitted.jobId!)?.finishedAt).toBeUndefined();

    releaseFirst();
    const resumed = await resumePromise;
    expect(resumed.ok).toBe(true);
    const afterResume = getAgentJob(submitted.jobId!);
    expect(afterResume?.status === 'pending' || afterResume?.status === 'running').toBe(true);
    expect(afterResume?.finishedAt).toBeUndefined();
    const finished = await waitForAgentJob(submitted.jobId!);
    expect(finished.status === 'completed' || finished.status === 'completed_with_warnings').toBe(true);
    expect(finished.finishedAt).toEqual(expect.any(Number));
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

  it('isolates a late ignoring-abort handler from the resumed generation', async () => {
    let releaseStale!: () => void;
    let releaseCurrent!: () => void;
    let staleStarted!: () => void;
    let currentStarted!: () => void;
    let staleSettled!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    const currentStartedAt = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });
    const staleSettledAt = new Promise<void>((resolve) => {
      staleSettled = resolve;
    });

    let staleSignal: AbortSignal | undefined;
    let currentSignal: AbortSignal | undefined;
    let staleArtifactId: string | undefined;
    let currentArtifactId: string | undefined;
    let handlerCalls = 0;

    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        staleSignal = ctx.signal;
        staleStarted();
        await staleGate;
        try {
          const stale = registerAgentArtifact({
            blob: new Blob(['stale-generation'], { type: 'text/plain' }),
            mimeType: 'text/plain',
            fileName: 'stale.txt',
            jobId: ctx.jobId,
            inFlight: true,
            authoritative: true,
          });
          staleArtifactId = stale.artifactId;
          ctx.registerArtifact(stale.artifactId);
          if (currentArtifactId) ctx.registerArtifact(currentArtifactId);
        } finally {
          staleSettled();
        }
        return;
      }
      currentSignal = ctx.signal;
      const current = registerAgentArtifact({
        blob: new Blob(['current-generation'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'current.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
      });
      currentArtifactId = current.artifactId;
      ctx.registerArtifact(current.artifactId);
      currentStarted();
      await currentGate;
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'item-0' }],
      concurrency: 1,
    });
    expect(submitted.ok).toBe(true);
    await staleStartedAt;
    const firstRun = inspectAgentJobRunForTests(submitted.jobId!);
    expect(firstRun?.runGeneration).toBe(1);
    expect(staleSignal?.aborted).toBe(false);

    pauseAgentJob(submitted.jobId!);
    expect(getAgentJob(submitted.jobId!)?.status).toBe('paused');
    expect(staleSignal?.aborted).toBe(true);
    const pausedFinishedAt = getAgentJob(submitted.jobId!)?.finishedAt;
    expect(pausedFinishedAt).toBeUndefined();

    let resumeSettled = false;
    const resumePromise = resumeAgentJob(submitted.jobId!).then((result) => {
      resumeSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resumeSettled).toBe(false);
    expect(handlerCalls).toBe(1);
    expect(currentSignal).toBeUndefined();

    releaseStale();
    await staleSettledAt;
    const resumed = await resumePromise;
    expect(resumed.ok).toBe(true);
    await currentStartedAt;
    const secondRun = inspectAgentJobRunForTests(submitted.jobId!);
    expect(secondRun?.runGeneration).toBe(2);
    expect(currentSignal).toBeDefined();
    expect(currentSignal).not.toBe(staleSignal);
    expect(currentSignal?.aborted).toBe(false);
    expect(currentArtifactId).toBeTruthy();
    expect(getAgentArtifactHandle(currentArtifactId!)?.pinReason).toBe('in-flight');

    const afterStale = getAgentJob(submitted.jobId!);
    expect(afterStale?.status === 'pending' || afterStale?.status === 'running').toBe(true);
    expect(afterStale?.finishedAt).toBeUndefined();
    expect(afterStale?.completedItems).toBe(0);
    expect(afterStale?.errors ?? []).toEqual([]);
    expect(staleArtifactId).toBeTruthy();
    expect(getAgentArtifactHandle(staleArtifactId!)).toBeUndefined();
    expect(afterStale?.artifactIds ?? []).not.toContain(staleArtifactId);
    expect(afterStale?.artifactIds).toContain(currentArtifactId);
    expect(getAgentArtifactHandle(currentArtifactId!)?.pinReason).toBe('in-flight');

    releaseCurrent();
    const finished = await waitForAgentJob(submitted.jobId!, { timeoutMs: 5000 });
    expect(finished.status).toBe('completed');
    expect(finished.completedItems).toBe(1);
    expect(finished.errors ?? []).toEqual([]);
    expect(finished.artifactIds).toEqual([currentArtifactId]);
    expect(finished.finishedAt).toEqual(expect.any(Number));
    expect(handlerCalls).toBe(2);
    expect(getAgentArtifactHandle(staleArtifactId!)).toBeUndefined();
    expect(listAgentArtifacts({ jobId: submitted.jobId }).some((item) => item.fileName === 'stale.txt')).toBe(false);
    expect(finished.artifactIds).not.toContain(staleArtifactId);
    expect(getAgentArtifactHandle(currentArtifactId!)?.pinReason).not.toBe('in-flight');
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.releasedInFlightIds).toEqual([currentArtifactId]);
  }, 15000);

  it('does not append stale errors or overwrite terminal cancel after a late rejection', async () => {
    let releaseStale!: () => void;
    let staleStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });

    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      staleStarted();
      await staleGate;
      ctx.registerArtifact('stale-after-cancel');
      throw new Error('stale-should-not-appear');
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'item-cancel' }],
    });
    await staleStartedAt;
    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(true);
    const afterCancel = getAgentJob(submitted.jobId!);
    expect(afterCancel?.status).toBe('cancelled');
    expect(afterCancel?.finishedAt).toEqual(expect.any(Number));
    const finishedAt = afterCancel?.finishedAt;

    releaseStale();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterStale = getAgentJob(submitted.jobId!);
    expect(afterStale?.status).toBe('cancelled');
    expect(afterStale?.finishedAt).toBe(finishedAt);
    expect(afterStale?.errors ?? []).toEqual([]);
    expect(afterStale?.artifactIds ?? []).not.toContain('stale-after-cancel');
    expect(afterStale?.completedItems).toBe(0);
  }, 15000);

  it('does not let a stale rejection fail or complete a newer generation', async () => {
    let releaseStale!: () => void;
    let releaseCurrent!: () => void;
    let staleStarted!: () => void;
    let currentStarted!: () => void;
    let staleSettled!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    const currentStartedAt = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });
    const staleSettledAt = new Promise<void>((resolve) => {
      staleSettled = resolve;
    });

    let handlerCalls = 0;
    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        staleStarted();
        await staleGate;
        try {
          ctx.registerArtifact('stale-error-artifact');
          throw new Error('stale-generation-failed');
        } finally {
          staleSettled();
        }
      }
      ctx.registerArtifact('current-ok');
      currentStarted();
      await currentGate;
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'item-0' }],
      continueOnError: false,
    });
    await staleStartedAt;
    pauseAgentJob(submitted.jobId!);
    let resumeSettled = false;
    const resumePromise = resumeAgentJob(submitted.jobId!).then((result) => {
      resumeSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resumeSettled).toBe(false);
    expect(handlerCalls).toBe(1);

    releaseStale();
    await staleSettledAt;
    await resumePromise;
    await currentStartedAt;
    await Promise.resolve();

    const mid = getAgentJob(submitted.jobId!);
    expect(mid?.status === 'failed').toBe(false);
    expect((mid?.errors ?? []).some((item) => item.message.includes('stale-generation-failed'))).toBe(false);
    expect(mid?.artifactIds ?? []).not.toContain('stale-error-artifact');
    expect(mid?.completedItems).toBe(0);

    releaseCurrent();
    const finished = await waitForAgentJob(submitted.jobId!, { timeoutMs: 5000 });
    expect(finished.status).toBe('completed');
    expect(finished.errors ?? []).toEqual([]);
    expect(finished.artifactIds).toEqual(['current-ok']);
    expect(finished.completedItems).toBe(1);
  }, 15000);

  it('drains a paused ignoring-abort handler before resume starts the next generation', async () => {
    let releaseStale!: () => void;
    let releaseCurrent!: () => void;
    let staleStarted!: () => void;
    let currentStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    const currentStartedAt = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });

    const intervals: Array<{ generation: number; start: number; end?: number }> = [];
    let handlerCalls = 0;
    let staleArtifactId: string | undefined;
    let currentArtifactId: string | undefined;

    const publishedInFlightCount = (jobId: string) => {
      const published = new Set(getAgentJob(jobId)?.artifactIds ?? []);
      return listAgentArtifacts({ jobId }).filter((item) => (
        published.has(item.artifactId) && item.pinReason === 'in-flight'
      )).length;
    };

    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      handlerCalls += 1;
      const generation = handlerCalls;
      const start = Date.now();
      intervals.push({ generation, start });
      if (generation === 1) {
        staleStarted();
        await staleGate;
        const stale = registerAgentArtifact({
          blob: new Blob(['stale-drain'], { type: 'text/plain' }),
          mimeType: 'text/plain',
          fileName: 'stale-drain.txt',
          jobId: ctx.jobId,
          inFlight: true,
          authoritative: true,
        });
        staleArtifactId = stale.artifactId;
        ctx.registerArtifact(stale.artifactId);
        intervals[0]!.end = Date.now();
        return;
      }
      const current = registerAgentArtifact({
        blob: new Blob(['current-drain'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'current-drain.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
      });
      currentArtifactId = current.artifactId;
      ctx.registerArtifact(current.artifactId);
      currentStarted();
      await currentGate;
      intervals[1]!.end = Date.now();
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'item-0' }],
      concurrency: 1,
    });
    await staleStartedAt;
    pauseAgentJob(submitted.jobId!);
    expect(publishedInFlightCount(submitted.jobId!)).toBe(0);
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.hasActiveRun).toBe(true);

    let resumeSettled = false;
    const resumePromise = resumeAgentJob(submitted.jobId!).then((result) => {
      resumeSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resumeSettled).toBe(false);
    expect(handlerCalls).toBe(1);
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.runGeneration).toBe(1);

    releaseStale();
    const resumed = await resumePromise;
    expect(resumed.ok).toBe(true);
    expect(resumeSettled).toBe(true);
    await currentStartedAt;
    expect(handlerCalls).toBe(2);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]?.end).toEqual(expect.any(Number));
    expect(intervals[1]?.start).toBeGreaterThanOrEqual(intervals[0]!.end!);
    expect(publishedInFlightCount(submitted.jobId!)).toBe(1);
    expect(getAgentJob(submitted.jobId!)?.artifactIds).toEqual([currentArtifactId]);
    expect(staleArtifactId).toBeTruthy();
    expect(getAgentArtifactHandle(staleArtifactId!)).toBeUndefined();

    releaseCurrent();
    const finished = await waitForAgentJob(submitted.jobId!, { timeoutMs: 5000 });
    expect(finished.status).toBe('completed');
    expect(finished.artifactIds).toEqual([currentArtifactId]);
    expect(publishedInFlightCount(submitted.jobId!)).toBe(0);
    expect(getAgentArtifactHandle(staleArtifactId!)).toBeUndefined();
  }, 15000);

  it('serializes concurrent resumes onto a single drained generation', async () => {
    let releaseStale!: () => void;
    let staleStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    let handlerCalls = 0;

    setAgentJobHandlerForTests('custom', async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        staleStarted();
        await staleGate;
        return;
      }
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'item-0' }],
    });
    await staleStartedAt;
    pauseAgentJob(submitted.jobId!);

    const first = resumeAgentJob(submitted.jobId!);
    const second = resumeAgentJob(submitted.jobId!);
    await Promise.resolve();
    await Promise.resolve();
    expect(handlerCalls).toBe(1);

    releaseStale();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    const finished = await waitForAgentJob(submitted.jobId!, { timeoutMs: 5000 });
    expect(finished.status).toBe('completed');
    expect(handlerCalls).toBe(2);
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.runGeneration).toBe(2);
  }, 15000);

  it('does not start the next item until a timed-out ignoring-abort handler settles', async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStartedAt = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondStartedAt = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let firstEndedAt = 0;
    let secondStartedAtMs = 0;
    let handlerCalls = 0;

    setAgentJobHandlerForTests('custom', async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        firstStarted();
        await firstGate;
        firstEndedAt = Date.now();
        return;
      }
      secondStartedAtMs = Date.now();
      secondStarted();
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'a' }, { id: 'b' }],
      concurrency: 1,
      timeoutMsPerItem: 20,
      continueOnError: true,
    });
    await firstStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(handlerCalls).toBe(1);

    releaseFirst();
    await secondStartedAt;
    expect(firstEndedAt).toBeGreaterThan(0);
    expect(secondStartedAtMs).toBeGreaterThanOrEqual(firstEndedAt);

    const finished = await waitForAgentJob(submitted.jobId!, { timeoutMs: 5000 });
    expect(finished.status).toBe('completed_with_warnings');
    expect(finished.completedItems).toBe(2);
    expect(handlerCalls).toBe(2);
  }, 15000);

  it('deletes a late unpublished artifact after pause/resume drain and keeps the current generation pinned once', async () => {
    let releaseStale!: () => void;
    let releaseCurrent!: () => void;
    let staleStarted!: () => void;
    let currentStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    const currentStartedAt = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });

    let staleArtifactId: string | undefined;
    let currentArtifactId: string | undefined;
    let handlerCalls = 0;

    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        staleStarted();
        await staleGate;
        const stale = registerAgentArtifact({
          blob: new Blob(['late-unpublished'], { type: 'text/plain' }),
          mimeType: 'text/plain',
          fileName: 'late-unpublished.txt',
          jobId: ctx.jobId,
          inFlight: true,
          authoritative: true,
        });
        staleArtifactId = stale.artifactId;
        expect(getAgentArtifactHandle(stale.artifactId)?.pinReason).toBe('in-flight');
        ctx.registerArtifact(stale.artifactId);
        return;
      }
      const current = registerAgentArtifact({
        blob: new Blob(['current-published'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'current-published.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
      });
      currentArtifactId = current.artifactId;
      ctx.registerArtifact(current.artifactId);
      currentStarted();
      await currentGate;
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'late-pause' }],
    });
    await staleStartedAt;
    pauseAgentJob(submitted.jobId!);
    expect(getAgentJob(submitted.jobId!)?.status).toBe('paused');
    expect(getAgentJob(submitted.jobId!)?.artifactIds ?? []).toEqual([]);

    const resumePromise = resumeAgentJob(submitted.jobId!);
    await Promise.resolve();
    expect(handlerCalls).toBe(1);
    expect(staleArtifactId).toBeUndefined();

    releaseStale();
    const resumed = await resumePromise;
    expect(resumed.ok).toBe(true);
    await currentStartedAt;

    expect(staleArtifactId).toBeTruthy();
    expect(getAgentArtifactHandle(staleArtifactId!)).toBeUndefined();
    expect(getAgentJob(submitted.jobId!)?.artifactIds ?? []).not.toContain(staleArtifactId);
    expect(getAgentJob(submitted.jobId!)?.artifactIds).toEqual([currentArtifactId]);
    expect(getAgentArtifactHandle(currentArtifactId!)?.pinReason).toBe('in-flight');
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.releasedInFlightIds ?? []).not.toContain(currentArtifactId);

    releaseCurrent();
    const finished = await waitForAgentJob(submitted.jobId!, { timeoutMs: 5000 });
    expect(finished.status).toBe('completed');
    expect(finished.artifactIds).toEqual([currentArtifactId]);
    expect(finished.artifactIds).not.toContain(staleArtifactId);
    expect(getAgentArtifactHandle(staleArtifactId!)).toBeUndefined();
    expect(getAgentArtifactHandle(currentArtifactId!)?.pinReason).toBe('authoritative');
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.releasedInFlightIds).toEqual([currentArtifactId]);
  }, 15000);

  it('deletes a late unpublished artifact after terminal cancel drain', async () => {
    let releaseStale!: () => void;
    let staleStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });

    let staleArtifactId: string | undefined;
    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      staleStarted();
      await staleGate;
      const stale = registerAgentArtifact({
        blob: new Blob(['late-cancel'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'late-cancel.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
      });
      staleArtifactId = stale.artifactId;
      ctx.registerArtifact(stale.artifactId);
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'late-cancel' }],
    });
    await staleStartedAt;
    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(true);
    expect(getAgentJob(submitted.jobId!)?.status).toBe('cancelled');
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.hasActiveRun).toBe(true);

    releaseStale();
    await waitForJobGenerationDrain(submitted.jobId!);

    const afterDrain = getAgentJob(submitted.jobId!);
    expect(afterDrain?.status).toBe('cancelled');
    expect(afterDrain?.artifactIds ?? []).not.toContain(staleArtifactId);
    expect(staleArtifactId).toBeTruthy();
    expect(getAgentArtifactHandle(staleArtifactId!)).toBeUndefined();
    expect(listAgentArtifacts({ jobId: submitted.jobId }).length).toBe(0);
  }, 15000);

  it('does not sweep a published concurrent worker artifact while the same generation is still draining', async () => {
    let releasePublished!: () => void;
    let releaseLate!: () => void;
    let publishedStarted!: () => void;
    let lateStarted!: () => void;
    const publishedGate = new Promise<void>((resolve) => {
      releasePublished = resolve;
    });
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const publishedStartedAt = new Promise<void>((resolve) => {
      publishedStarted = resolve;
    });
    const lateStartedAt = new Promise<void>((resolve) => {
      lateStarted = resolve;
    });

    let publishedArtifactId: string | undefined;
    let lateArtifactId: string | undefined;

    setAgentJobHandlerForTests('custom', async (item, _index, ctx) => {
      const record = item as { id?: string };
      if (record.id === 'keep') {
        const published = registerAgentArtifact({
          blob: new Blob(['keep-published'], { type: 'text/plain' }),
          mimeType: 'text/plain',
          fileName: 'keep-published.txt',
          jobId: ctx.jobId,
          inFlight: true,
          authoritative: true,
        });
        publishedArtifactId = published.artifactId;
        ctx.registerArtifact(published.artifactId);
        publishedStarted();
        await publishedGate;
        return;
      }
      lateStarted();
      await lateGate;
      const late = registerAgentArtifact({
        blob: new Blob(['late-sibling'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'late-sibling.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
      });
      lateArtifactId = late.artifactId;
      ctx.registerArtifact(late.artifactId);
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'keep' }, { id: 'late' }],
      concurrency: 2,
    });
    await publishedStartedAt;
    await lateStartedAt;
    expect(getAgentJob(submitted.jobId!)?.artifactIds).toEqual([publishedArtifactId]);
    expect(getAgentArtifactHandle(publishedArtifactId!)?.pinReason).toBe('in-flight');

    pauseAgentJob(submitted.jobId!);
    expect(getAgentJob(submitted.jobId!)?.status).toBe('paused');
    expect(getAgentArtifactHandle(publishedArtifactId!)?.pinReason).toBe('authoritative');
    expect(inspectAgentJobRunForTests(submitted.jobId!)?.hasActiveRun).toBe(true);

    releaseLate();
    const lateCreatedAt = Date.now();
    while (!lateArtifactId && Date.now() - lateCreatedAt < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(lateArtifactId).toBeTruthy();
    expect(getAgentArtifactHandle(lateArtifactId!)?.pinned).toBe(true);
    expect(getAgentJob(submitted.jobId!)?.artifactIds).toEqual([publishedArtifactId]);
    expect(getAgentArtifactHandle(publishedArtifactId!)?.pinReason).toBe('authoritative');

    releasePublished();
    await waitForJobGenerationDrain(submitted.jobId!);

    expect(getAgentJob(submitted.jobId!)?.artifactIds).toEqual([publishedArtifactId]);
    expect(getAgentArtifactHandle(publishedArtifactId!)?.pinReason).toBe('authoritative');
    expect(getAgentArtifactHandle(lateArtifactId!)).toBeUndefined();
  }, 15000);

  it('claims a late production render-shot handle and deletes it after cancel drain', async () => {
    let releaseRender!: () => void;
    let renderStarted!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderStartedAt = new Promise<void>((resolve) => {
      renderStarted = resolve;
    });
    let lateHandleId: string | undefined;

    setAgentRenderShotFrameImpl(async (input) => {
      renderStarted();
      await renderGate;
      const handle = registerAgentArtifact({
        blob: new Blob(['late-render-handle'], { type: 'image/png' }),
        mimeType: 'image/png',
        fileName: 'late-render.png',
        inFlight: true,
        authoritative: true,
      });
      lateHandleId = handle.artifactId;
      return {
        ok: true,
        status: 'completed',
        shotId: input.shotId,
        revisionId: 'rev_late',
        width: 8,
        height: 8,
        handle,
        diagnostics: [],
      };
    });

    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_late_render' }],
    });
    await renderStartedAt;
    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(true);
    releaseRender();
    await waitForJobGenerationDrain(submitted.jobId!);

    expect(getAgentJob(submitted.jobId!)?.status).toBe('cancelled');
    expect(getAgentJob(submitted.jobId!)?.artifactIds ?? []).toEqual([]);
    expect(lateHandleId).toBeTruthy();
    expect(getAgentArtifactHandle(lateHandleId!)).toBeUndefined();
  }, 15000);

  it('claims a late pass-matrix handle and deletes it after cancel drain', async () => {
    let releaseRender!: () => void;
    let renderStarted!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderStartedAt = new Promise<void>((resolve) => {
      renderStarted = resolve;
    });
    let lateHandleId: string | undefined;

    setAgentRenderShotFrameImpl(async (input) => {
      renderStarted();
      await renderGate;
      const handle = registerAgentArtifact({
        blob: new Blob(['late-pass-handle'], { type: 'image/png' }),
        mimeType: 'image/png',
        fileName: 'late-pass.png',
        inFlight: true,
        authoritative: true,
      });
      lateHandleId = handle.artifactId;
      return {
        ok: true,
        status: 'completed',
        shotId: input.shotId,
        revisionId: 'rev_late_pass',
        width: 8,
        height: 8,
        handle,
        diagnostics: [],
      };
    });

    const submitted = submitAgentJob({
      type: 'render-pass-matrix',
      jobs: [{ shotId: 'shot_late_pass', pass: 'clay' }],
    });
    await renderStartedAt;
    cancelAgentJob(submitted.jobId!);
    releaseRender();
    await waitForJobGenerationDrain(submitted.jobId!);

    expect(getAgentJob(submitted.jobId!)?.status).toBe('cancelled');
    expect(getAgentJob(submitted.jobId!)?.artifactIds ?? []).toEqual([]);
    expect(lateHandleId).toBeTruthy();
    expect(getAgentArtifactHandle(lateHandleId!)).toBeUndefined();
  }, 15000);

  it('preserves persisted and project-attached unpublished artifacts when sweeping a cancelled generation', async () => {
    let releaseStale!: () => void;
    let staleStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });
    let lateId: string | undefined;
    let persistedId: string | undefined;
    let attachedId: string | undefined;

    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      staleStarted();
      await staleGate;
      const late = registerAgentArtifact({
        blob: new Blob(['ephemeral-late'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'ephemeral-late.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
      });
      const persisted = registerAgentArtifact({
        blob: new Blob(['persisted-late'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'persisted-late.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
        persisted: true,
      });
      const attached = registerAgentArtifact({
        blob: new Blob(['attached-late'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'attached-late.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
        projectAssetId: 'asset_keep',
      });
      lateId = late.artifactId;
      persistedId = persisted.artifactId;
      attachedId = attached.artifactId;
      ctx.registerArtifact(late.artifactId);
      ctx.registerArtifact(persisted.artifactId);
      ctx.registerArtifact(attached.artifactId);
    });

    const submitted = submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'durable-late' }],
    });
    await staleStartedAt;
    cancelAgentJob(submitted.jobId!);
    releaseStale();
    await waitForJobGenerationDrain(submitted.jobId!);

    expect(getAgentJob(submitted.jobId!)?.artifactIds ?? []).toEqual([]);
    expect(getAgentArtifactHandle(lateId!)).toBeUndefined();
    expect(getAgentArtifactHandle(persistedId!)?.pinReason).toBe('persisted');
    expect(getAgentArtifactHandle(attachedId!)?.pinReason).toBe('project-attached');
    expect(getAgentArtifactHandle(persistedId!)?.pinned).toBe(true);
    expect(getAgentArtifactHandle(attachedId!)?.pinned).toBe(true);
  }, 15000);

  it('does not reject when jobs are reset while a late handler is still blocked', async () => {
    let releaseStale!: () => void;
    let staleStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleStartedAt = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });

    setAgentJobHandlerForTests('custom', async (_item, _index, ctx) => {
      staleStarted();
      await staleGate;
      const leftover = registerAgentArtifact({
        blob: new Blob(['after-reset'], { type: 'text/plain' }),
        mimeType: 'text/plain',
        fileName: 'after-reset.txt',
        jobId: ctx.jobId,
        inFlight: true,
        authoritative: true,
      });
      ctx.registerArtifact(leftover.artifactId);
    });

    submitAgentJob({
      type: 'custom',
      jobs: [{ id: 'reset-late' }],
    });
    await staleStartedAt;
    expect(() => resetAgentJobsForTests()).not.toThrow();
    releaseStale();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getAgentJob).not.toThrow();
  }, 15000);
});
