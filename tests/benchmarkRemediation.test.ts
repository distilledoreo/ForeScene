import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoReference, createSceneObject, createShot } from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { createId } from '../src/utils/ids';
import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';
import { parseForeSceneAgentPlan } from '../src/engine/agent/validation';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import { resolveShotTarget } from '../src/engine/agent/targetResolver';
import { inspectShotVisualPreflight } from '../src/engine/agent/visualPreflight';
import {
  beginShotRepairSession,
  commitBestShotRepairCandidate,
  evaluateShotRepairCandidate,
  resetShotRepairSessionsForTests,
} from '../src/engine/agent/repairCandidates';
import { inspectAssetPoseContract } from '../src/engine/agent/assetPoseContract';
import { resolveHumanPosePresetId } from '../src/engine/humanPosePresets';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { touchProject } from '../src/state/slices/touchProject';
import { setAgentShotPanorama } from '../src/engine/agent/shotPanorama';
import { orientAgentObjectToward, snapAgentObjectToFloor } from '../src/engine/agent/spatialPrimitives';
import { getShotEffectiveState } from '../src/engine/agent/spatialShotState';
import { mergeFrameValidationWithVisualPreflight } from '../src/engine/previs/frameValidation';

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

function projectWithPano(): LocationProject {
  const project = createDefaultProject();
  const assetId = createId('asset');
  const pano = createPanoReference({
    name: 'Test Pano',
    assetId,
    type: 'ai_global_reference',
    origin: [0, 1.6, 0],
    rotation: [0, 0, 0],
    width: 1024,
    height: 512,
    isCanonical: true,
  });
  return {
    ...project,
    assets: {
      assets: {
        ...project.assets.assets,
        [assetId]: {
          id: assetId,
          name: 'Test Pano Asset',
          type: 'image',
          mimeType: 'image/png',
          uri: 'data:image/png;base64,test',
          width: 1024,
          height: 512,
          resolutionStatus: 'available',
          createdAt: new Date().toISOString(),
        },
      },
    },
    panoRefs: [pano],
    shots: project.shots.map((shot, index) => ({
      ...shot,
      shotNumber: String(index + 1).padStart(2, '0'),
      linkedPanoId: pano.id,
    })),
  };
}

describe('benchmark remediation', () => {
  beforeEach(() => {
    resetShotRepairSessionsForTests();
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const project = projectWithPano();
    useProjectStore.setState({
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
      activePanoId: project.panoRefs[0]?.id,
      isRenderingGraybox: false,
      isExportingPackage: false,
    });
    useProjectSafetyStore.setState({ criticalWrite: false, status: 'saved', activeRevisionId: 'rev_test' });
    installMockDestructiveMutation();
  });

  afterEach(() => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(undefined);
    resetShotRepairSessionsForTests();
  });

  it('unlinks a shot via shot.setPanorama null and keeps it unlinked after hydrate', () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const parsed = parseForeSceneAgentPlan({
      version: 1,
      commands: [{ op: 'shot.setPanorama', shot: { shotNumber: shot.shotNumber }, pano: null }],
    });
    expect(parsed.errors).toEqual([]);
    const prepared = prepareAgentPlan(parsed.plan!, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: shot.id,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.nextProject.shots[0]?.linkedPanoId).toBeNull();

    useProjectStore.getState().setProject(prepared.prepared.nextProject);
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBeNull();
  });

  it('resolves shot targets by shotNumber', () => {
    const project = useProjectStore.getState().project;
    const resolved = resolveShotTarget(project, { shotNumber: '01' }, {});
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.id).toBe(project.shots[0]!.id);
  });

  it('samples a shot without throwing when the target is missing', () => {
    const api = createForeSceneBrowserApi();
    expect(() => api.sampleShotAtTime({ timeSeconds: 1.5 } as never)).toThrow(/shot, shotId, or shotNumber/);
    const sample = api.sampleShotAtTime({ shotNumber: '01', timeSeconds: 0 });
    expect(sample.camera).toBeTruthy();
  });

  it('orients an object toward a world position', async () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [10, 0.1, 10];
    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    actor.name = 'Actor';
    const shot = createShot({ index: 1, camera: {
      position: [0, 1.6, 6],
      target: [0, 1.4, 0],
      fovDegrees: 50,
      aspectRatio: 16 / 9,
      near: 0.1,
      far: 100,
    } });
    useProjectStore.setState({
      project: touchProject({
        ...createDefaultProject(),
        scene: { ...createDefaultProject().scene, objects: [floor, actor] },
        shots: [shot],
      }),
      selectedShotId: shot.id,
    });

    const result = await orientAgentObjectToward({
      shot: { id: shot.id },
      object: { id: actor.id },
      target: [4, 0.875, 0],
    });
    expect(result.ok).toBe(true);
    expect(result.rotation?.[1]).toBeGreaterThan(80);
    expect(result.rotation?.[1]).toBeLessThan(110);
  });

  it('snaps to the shot-effective floor rather than the base-scene origin', async () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [10, 0.1, 10];
    floor.transform.position = [0, 0, 0];
    const actor = createSceneObject('human_dummy', 1, [0, 3, 0]);
    const shot = createShot({ index: 1, camera: {
      position: [0, 1.6, 6],
      target: [0, 1.4, 0],
      fovDegrees: 50,
      aspectRatio: 16 / 9,
      near: 0.1,
      far: 100,
    } });
    shot.objectOverrides = {
      [floor.id]: { transform: { ...floor.transform, position: [0, 1, 0] } },
    };
    useProjectStore.setState({
      project: touchProject({
        ...createDefaultProject(),
        scene: { ...createDefaultProject().scene, objects: [floor, actor] },
        shots: [shot],
      }),
      selectedShotId: shot.id,
    });

    const result = await snapAgentObjectToFloor({ shot: { shotNumber: shot.shotNumber }, object: { id: actor.id } });
    expect(result.ok).toBe(true);
    const state = getShotEffectiveState(useProjectStore.getState().project, shot.id);
    const grounded = state?.objects.find((object) => object.id === actor.id);
    expect(grounded).toBeTruthy();
    expect(grounded!.transform.position[1]).toBeGreaterThan(1);
  });

  it('treats an explicit environment-only shot as supported without a fake subject score', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const wall = createSceneObject('wall', 1);
    wall.dimensions = [8, 3, 0.2];
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 8],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    shot.metadata = { environmentOnly: true };
    const project: LocationProject = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, wall] },
      shots: [shot],
    });
    const result = inspectShotVisualPreflight({ project, shotId: shot.id });
    expect(result.environmentOnly).toBe(true);
    expect(result.subjectPolicy).toBe('environment_only');
    expect(result.ok).toBe(true);
    expect(result.subjects).toEqual([]);
    expect(result.checks.find((check) => check.id === 'subject_visibility')?.status).toBe('passed');
    expect(result.checks.find((check) => check.id === 'subject_visibility')?.message).toMatch(/Environment-only/);

    const unmarked = inspectShotVisualPreflight({
      project: {
        ...project,
        shots: [{ ...shot, metadata: undefined }],
      },
      shotId: shot.id,
    });
    expect(unmarked.environmentOnly).toBe(false);
    expect(unmarked.subjectPolicy).toBe('subjects_expected');
    expect(unmarked.ok).toBe(false);
    expect(unmarked.gateStatus).toBe('warning');
    expect(unmarked.checks.find((check) => check.id === 'subject_visibility')?.status).toBe('warning');
    expect(unmarked.checks.find((check) => check.id === 'subject_visibility')?.message).toMatch(/explicit intent/);
  });

  it('does not classify a visible imported model or prop as environment-only', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const monster = createSceneObject('imported_model', 1, [0, 0.5, 0]);
    monster.name = 'Imported monster';
    monster.category = 'architecture';
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 6],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    const project = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, monster] },
      shots: [shot],
    });
    const result = inspectShotVisualPreflight({ project, shotId: shot.id });
    expect(result.environmentOnly).toBe(false);
    expect(result.subjectPolicy).toBe('subjects_expected');
    expect(result.candidateSubjectIds).toEqual([]);
    expect(result.unresolvedVisibleObjectIds).toContain(monster.id);
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'subject_visibility')?.status).toBe('failed');
    expect(result.checks.find((check) => check.id === 'subject_visibility')?.message).toMatch(/Visible renderable content/);
    expect(result.score).toBeLessThan(100);
  });

  it('does not perfectly pass a scored human while silently ignoring a visible imported model', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    actor.name = 'On-camera actor';
    const prop = createSceneObject('imported_model', 1, [1.4, 0.5, 0]);
    prop.name = 'Imported monster';
    prop.category = 'architecture';
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 6],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    const project = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, actor, prop] },
      shots: [shot],
    });
    const result = inspectShotVisualPreflight({ project, shotId: shot.id });
    expect(result.environmentOnly).toBe(false);
    expect(result.subjectPolicy).toBe('subjects_expected');
    expect(result.candidateSubjectIds).toContain(actor.id);
    expect(result.candidateSubjectIds).not.toContain(prop.id);
    expect(result.subjects.some((subject) => subject.objectId === actor.id)).toBe(true);
    expect(result.subjects.some((subject) => subject.objectId === prop.id)).toBe(false);
    expect(result.unresolvedVisibleObjectIds).toContain(prop.id);
    const visibility = result.checks.find((check) => check.id === 'subject_visibility');
    expect(visibility?.status).toBe('failed');
    expect(visibility?.message).toMatch(/not identified as a subject/i);
    expect(result.ok).toBe(false);
    expect(result.gateStatus).toBe('failed');
    expect(result.checks.every((check) => check.status === 'passed')).toBe(false);
    expect(result.score).toBeLessThan(100);

    const requested = inspectShotVisualPreflight({
      project,
      shotId: shot.id,
      subjectIds: [actor.id, prop.id],
    });
    expect(requested.unresolvedVisibleObjectIds ?? []).not.toContain(prop.id);
    expect(requested.candidateSubjectIds).toContain(prop.id);

    const optedIn = inspectShotVisualPreflight({
      project: {
        ...project,
        shots: [{
          ...shot,
          metadata: { ...shot.metadata, allowUnresolvedSetDressing: true },
        }],
      },
      shotId: shot.id,
    });
    expect(optedIn.allowUnresolvedSetDressing).toBe(true);
    expect(optedIn.subjectPolicy).toBe('set_dressing_allowed');
    expect(optedIn.unresolvedVisibleObjectIds).toContain(prop.id);
    expect(optedIn.ok).toBe(false);
    expect(optedIn.gateStatus).toBe('warning');
    expect(optedIn.checks.find((check) => check.id === 'subject_visibility')?.status).toBe('warning');
  });

  it('scores persisted production groups as one subject and excludes their bound location set', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const actor = createSceneObject('human_dummy', 1, [-0.8, 0.875, 0]);
    const partA = createSceneObject('imported_model', 1, [0.7, 0.25, 0]);
    const partB = createSceneObject('imported_model', 2, [1.1, 0.25, 0]);
    partA.dimensions = [0.5, 0.5, 0.5];
    partB.dimensions = [0.5, 0.5, 0.5];
    partA.category = 'helper';
    partB.category = 'helper';
    const setPiece = createSceneObject('imported_model', 3, [0, 1, -2]);
    setPiece.category = 'architecture';
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.5, 6],
        target: [0, 0.9, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    shot.objectOverrides = {
      [actor.id]: {
        humanPose: { version: 1, joints: {}, presetId: 'neutral' },
      },
    };
    const project: LocationProject = touchProject({
      ...createDefaultProject(),
      scene: {
        ...createDefaultProject().scene,
        objects: [floor, actor, partA, partB, setPiece],
        objectGroups: {
          creature: { id: 'creature', name: 'Creature', objectIds: [partA.id, partB.id] },
        },
      },
      shots: [shot],
      workflow: {
        ...createDefaultProject().workflow,
        production: {
          schemaVersion: 1,
          bindings: {
            actor: { kind: 'object', objectId: actor.id },
            monster: { kind: 'group', groupId: 'creature' },
            corridor: { kind: 'location', locationId: 'corridor' },
          },
          locations: {
            corridor: {
              id: 'corridor',
              objectIds: [floor.id, setPiece.id],
              objectGroupIds: [],
              anchors: {},
              blockerObjectIds: [],
            },
          },
          shotContracts: {
            [shot.id]: {
              presence: {
                expectedVisibleObjectIds: [actor.id],
                expectedVisibleGroupIds: ['creature'],
                allowUnspecifiedDynamicObjects: false,
              },
              environment: { locationId: 'corridor' },
              actions: [{
                actionId: 'shot-1:actor:static-pose',
                entityId: 'actor',
                mode: 'static_pose',
                durationSeconds: 0,
                samples: [{
                  timeSeconds: 0,
                  requestedPose: 'standing-neutral',
                  resolvedPose: 'neutral',
                }],
              }],
            },
          },
        },
      },
    });

    const result = inspectShotVisualPreflight({ project, shotId: shot.id });

    expect(result.subjects.map((subject) => subject.objectId)).toEqual([actor.id, 'creature']);
    expect(result.unresolvedVisibleObjectIds).toEqual([]);
    expect(result.checks.find((check) => check.id === 'subject_visibility')?.status).toBe('passed');
    expect(result.checks.find((check) => check.id === 'ground_contact')?.status).toBe('passed');
    expect(result.checks.find((check) => check.id === 'action_continuity')?.status).toBe('passed');

    project.workflow.production!.shotContracts[shot.id]!.actions![0]!.samples[0]!.resolvedPose = 'elbows-bent';
    const mismatch = inspectShotVisualPreflight({ project, shotId: shot.id });
    expect(mismatch.checks.find((check) => check.id === 'action_continuity')?.status).toBe('failed');

    project.workflow.production!.shotContracts[shot.id]!.actions![0]!.samples[0] = {
      timeSeconds: 0,
      requestedPose: 'standing-neutral',
      resolvedPose: 'neutral',
      poseRelationship: 'approximate',
      requiresReview: true,
    };
    const unapproved = inspectShotVisualPreflight({ project, shotId: shot.id });
    expect(unapproved.checks.find((check) => check.id === 'action_continuity')).toMatchObject({
      status: 'failed',
      measured: { reviewRequiredCount: 1 },
    });
    const merged = mergeFrameValidationWithVisualPreflight({
      shotNumber: shot.shotNumber,
      status: 'passed',
      issues: [],
    }, unapproved);
    expect(merged.status).toBe('failed');
    expect(merged.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'visual_preflight_action_continuity' }),
    ]));
    expect(merged.visualPreflight).toBe(unapproved);
  });

  it('fails an ordinary shot that has candidate subjects but infers none', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    actor.name = 'Hidden actor';
    actor.visible = false;
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 6],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    const project = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, actor] },
      shots: [shot],
    });
    const result = inspectShotVisualPreflight({ project, shotId: shot.id });
    expect(result.environmentOnly).toBe(false);
    expect(result.subjectPolicy).toBe('subjects_expected');
    expect(result.candidateSubjectIds).toContain(actor.id);
    expect(result.subjects).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'subject_visibility')?.status).toBe('failed');
    expect(result.checks.find((check) => check.id === 'framing_coverage')?.status).toBe('failed');
    expect(result.score).toBeLessThan(100);
  });

  it('emits visual preflight checks and a numeric score', () => {
    const project = useProjectStore.getState().project;
    const result = inspectShotVisualPreflight({ project, shotId: project.shots[0]!.id });
    expect(result.checks.map((check) => check.id)).toEqual([
      'subject_visibility',
      'framing_coverage',
      'ground_contact',
      'camera_direction',
      'cropping',
      'motion_continuity',
    ]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('fails visual preflight when a requested subject is missing', () => {
    const project = useProjectStore.getState().project;
    const result = inspectShotVisualPreflight({
      project,
      shotId: project.shots[0]!.id,
      subjectIds: ['missing-requested-subject'],
    });
    expect(result.ok).toBe(false);
    expect(result.missingSubjectIds).toContain('missing-requested-subject');
    expect(result.checks.find((check) => check.id === 'subject_visibility')?.status).toBe('failed');
  });

  it('uses shot-effective object positions for camera-direction checks', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    actor.name = 'Actor';
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 6],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    shot.objectOverrides = {
      [actor.id]: { transform: { ...actor.transform, position: [0, 0.875, 20] } },
    };
    const project = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, actor] },
      shots: [shot],
    });
    const result = inspectShotVisualPreflight({
      project,
      shotId: shot.id,
      subjectIds: [actor.id],
    });
    expect(result.checks.find((check) => check.id === 'camera_direction')?.status).toBe('failed');
    expect(result.ok).toBe(false);
  });

  it('samples camera keyframe times and reports per-sample failures', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 6],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    shot.cameraKeyframes = [
      {
        id: 'kf-start',
        label: 'Start',
        timeSeconds: 0,
        camera: shot.camera,
        easing: 'linear',
      },
      {
        id: 'kf-end',
        label: 'End',
        timeSeconds: 2,
        camera: {
          ...shot.camera,
          position: [0, 1.6, 6],
          target: [0, 1.4, 12],
        },
        easing: 'linear',
      },
    ];
    const project = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, actor] },
      shots: [shot],
    });
    const result = inspectShotVisualPreflight({
      project,
      shotId: shot.id,
      subjectIds: [actor.id],
    });
    expect(result.samples?.length).toBeGreaterThanOrEqual(2);
    expect(result.sampleTimesSeconds?.some((time) => time === 0)).toBe(true);
    expect(result.sampleTimesSeconds?.some((time) => time === 2)).toBe(true);
    expect(result.samples?.some((sample) => !sample.ok && sample.failedCheckIds.length > 0)).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('keeps the better repair candidate when a later mutation scores worse', async () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const started = beginShotRepairSession({ shotId: shot.id, label: 'baseline' });
    expect(started.ok).toBe(true);
    const baselineScore = started.bestScore;

    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        shots: state.project.shots.map((item) => (
          item.id === shot.id
            ? {
              ...item,
              camera: {
                ...item.camera,
                position: [80, 40, 80] as [number, number, number],
                target: [80, 40, 81] as [number, number, number],
              },
            }
            : item
        )),
      },
    }));
    const evaluated = evaluateShotRepairCandidate({ shotId: shot.id, label: 'worse' });
    expect(evaluated.kept).toBe(false);
    expect(evaluated.bestScore).toBe(baselineScore);

    const committed = await commitBestShotRepairCandidate({ shotId: shot.id });
    expect(committed.ok).toBe(true);
    expect(useProjectStore.getState().project.shots[0]?.camera.position).toEqual(shot.camera.position);
  });

  it('keeps an accepted candidate when keepWhenAccepted is set even if visual score did not rise', async () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const started = beginShotRepairSession({ shotId: shot.id, label: 'baseline' });
    expect(started.ok).toBe(true);

    const worseCamera = {
      ...shot.camera,
      position: [80, 40, 80] as [number, number, number],
      target: [80, 40, 81] as [number, number, number],
    };
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        shots: state.project.shots.map((item) => (
          item.id === shot.id ? { ...item, camera: worseCamera } : item
        )),
      },
    }));

    const withoutFlag = evaluateShotRepairCandidate({
      shotId: shot.id,
      label: 'worse-visual',
      restoreIfWorse: true,
    });
    expect(withoutFlag.kept).toBe(false);
    expect(useProjectStore.getState().project.shots[0]?.camera.position).toEqual(shot.camera.position);

    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        shots: state.project.shots.map((item) => (
          item.id === shot.id ? { ...item, camera: worseCamera } : item
        )),
      },
    }));
    const withFlag = evaluateShotRepairCandidate({
      shotId: shot.id,
      label: 'geometry-rank-improved',
      accepted: true,
      keepWhenAccepted: true,
      restoreIfWorse: true,
    });
    expect(withFlag.kept).toBe(true);
    expect(useProjectStore.getState().project.shots[0]?.camera.position).toEqual(worseCamera.position);
  });

  it('rejects a worse full-shot repair and restores camera, keyframes, overrides, and pano', async () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    const originalKeyframes = [
      { id: 'kf-a', label: 'Start', timeSeconds: 0, camera: structuredClone(shot.camera), easing: 'linear' as const },
      {
        id: 'kf-b',
        label: 'End',
        timeSeconds: 1,
        camera: { ...shot.camera, position: [1, 1.6, 5] as [number, number, number] },
        easing: 'linear' as const,
      },
    ];
    const originalOverrides = { [actor.id]: { visible: true } };
    useProjectStore.setState((state) => ({
      project: touchProject({
        ...state.project,
        scene: { ...state.project.scene, objects: [...state.project.scene.objects, actor] },
        shots: state.project.shots.map((item) => (
          item.id === shot.id
            ? {
              ...item,
              cameraKeyframes: originalKeyframes,
              objectOverrides: originalOverrides,
              linkedPanoId: state.project.panoRefs[0]!.id,
            }
            : item
        )),
      }),
    }));

    const started = beginShotRepairSession({ shotId: shot.id, label: 'baseline' });
    expect(started.ok).toBe(true);

    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        shots: state.project.shots.map((item) => (
          item.id === shot.id
            ? {
              ...item,
              camera: {
                ...item.camera,
                position: [90, 40, 90] as [number, number, number],
                target: [90, 40, 91] as [number, number, number],
              },
              cameraKeyframes: [],
              objectOverrides: { [actor.id]: { visible: false } },
              linkedPanoId: null,
              panoCrop: undefined,
            }
            : item
        )),
      },
    }));

    const evaluated = evaluateShotRepairCandidate({ shotId: shot.id, label: 'worse-full-shot' });
    expect(evaluated.kept).toBe(false);

    const committed = await commitBestShotRepairCandidate({ shotId: shot.id });
    expect(committed.ok).toBe(true);
    const restored = useProjectStore.getState().project.shots[0]!;
    expect(restored.camera.position).toEqual(shot.camera.position);
    expect(restored.cameraKeyframes).toHaveLength(2);
    expect(restored.objectOverrides?.[actor.id]?.visible).toBe(true);
    expect(restored.linkedPanoId).toBe(project.panoRefs[0]!.id);
  });

  it('restores the complete prior shot when a caller rejects a higher-scoring candidate', async () => {
    const project = useProjectStore.getState().project;
    const shot = project.shots[0]!;
    const started = beginShotRepairSession({ shotId: shot.id, label: 'baseline' });
    expect(started.ok).toBe(true);

    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        shots: state.project.shots.map((item) => (
          item.id === shot.id
            ? {
              ...item,
              status: 'exported' as const,
              camera: {
                ...item.camera,
                position: [0, 1.6, 5] as [number, number, number],
                target: [0, 1.4, 0] as [number, number, number],
              },
              assets: { ...item.assets, cameraMoveVideoAssetId: 'video-should-not-stick' },
            }
            : item
        )),
      },
    }));

    const evaluated = evaluateShotRepairCandidate({
      shotId: shot.id,
      label: 'visually-better-but-rejected',
      accepted: false,
      restoreIfWorse: true,
    });
    expect(evaluated.kept).toBe(false);

    const committed = await commitBestShotRepairCandidate({ shotId: shot.id });
    expect(committed.ok).toBe(true);
    const restored = useProjectStore.getState().project.shots[0]!;
    expect(restored.camera.position).toEqual(shot.camera.position);
    expect(restored.status).toBe(shot.status);
    expect(restored.assets.cameraMoveVideoAssetId).toBe(shot.assets.cameraMoveVideoAssetId);
  });

  it('reports asset inclusion and pose alias mapping in a machine-readable contract', () => {
    const project = useProjectStore.getState().project;
    const contract = inspectAssetPoseContract(project);
    expect(contract.shots[0]?.shotNumber).toBe('01');
    expect(contract.shots[0]?.panoramaResolved).toBe(true);
    expect(resolveHumanPosePresetId('running')).toEqual({
      requestedId: 'running',
      resolvedId: 'walk-contact-left',
      aliased: true,
    });
  });

  it('includes provenance on getStatus and unlinks by shotNumber', async () => {
    const api = createForeSceneBrowserApi();
    const status = api.getStatus();
    expect(status.provenance?.productName).toBe('ForeScene');
    expect(status.provenance?.agentApiVersion).toBe(1);
    expect(status.provenance?.revisionId).toBe('rev_test');
    expect(status.provenance?.cache).toMatchObject({
      renderEntries: expect.any(Number),
      readyEntries: expect.any(Number),
      invalidatedEntries: expect.any(Number),
    });
    expect(status.provenance?.cache).not.toHaveProperty('renderHits');
    expect(status.provenance?.cache).not.toHaveProperty('renderMisses');
    expect(Array.isArray(status.provenance?.cache?.operations)).toBe(true);
    expect(status.provenance?.timings?.provenanceBuiltAt).toBeTruthy();

    const unlinked = await setAgentShotPanorama({ shot: { shotNumber: '01' }, panoId: null });
    expect(unlinked.ok).toBe(true);
    expect(unlinked.linkedPanoId).toBeNull();
  });
});
