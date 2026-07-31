import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject, createShot, createCameraData } from '../src/domain/defaults';
import { applyHumanPosePreset } from '../src/engine/humanPosePresets';
import { resolveProjectForShot } from '../src/engine/shotSceneState';
import { prepareAgentPlan, previewAgentPlan } from '../src/engine/agent/planCompiler';
import { createExportPlan } from '../src/engine/exportPlan';

describe('agent shot staging', () => {
  it('stages transforms and poses without mutating Build objects', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    actor.name = 'Actor A';
    actor.transform.position = [-1, 0.875, 0];
    project.scene.objects.push(actor);
    const buildPosition = [...actor.transform.position];

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'shot.stageObject',
          shot: { id: project.shots[0]!.id },
          object: { id: actor.id },
          transform: {
            position: [2, 0.875, -1],
            rotation: [0, 30, 0],
            scale: [1, 1, 1],
          },
          posePreset: 'a-pose',
        },
      ],
    }, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]!.id,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const liveActor = project.scene.objects.find((object) => object.id === actor.id);
    expect(liveActor?.transform.position).toEqual(buildPosition);
    expect(liveActor?.humanPose).toBeUndefined();

    const nextShot = prepared.prepared.nextProject.shots[0]!;
    const override = nextShot.objectOverrides?.[actor.id];
    expect(override?.transform?.position).toEqual([2, 0.875, -1]);
    expect(override?.humanPose?.presetId).toBe('a-pose');

    const resolved = resolveProjectForShot(prepared.prepared.nextProject, nextShot);
    const resolvedActor = resolved.scene.objects.find((object) => object.id === actor.id);
    expect(resolvedActor?.transform.position).toEqual([2, 0.875, -1]);
    expect(resolvedActor?.humanPose?.presetId).toBe('a-pose');
  });

  it('clears pose while retaining staged position and visibility', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    project.scene.objects.push(actor);
    const shotId = project.shots[0]!.id;

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'shot.stageObject',
          shot: { id: shotId },
          object: { id: actor.id },
          transform: {
            position: [3, 0.875, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          visible: false,
          posePreset: 'sitting',
        },
        {
          op: 'shot.clearStaging',
          shot: { id: shotId },
          object: { id: actor.id },
          clearPoseOnly: true,
        },
      ],
    }, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: shotId,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const override = prepared.prepared.nextProject.shots[0]!.objectOverrides?.[actor.id];
    expect(override?.humanPose).toBeUndefined();
    expect(override?.visible).toBe(false);
    expect(override?.transform?.position).toEqual([3, 0.875, 0]);
  });

  it('applies the same absolute staging plan twice without duplicate overrides', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    project.scene.objects.push(actor);
    const shotId = project.shots[0]!.id;
    const plan = {
      version: 1 as const,
      commands: [
        {
          op: 'shot.stageObject' as const,
          shot: { id: shotId },
          object: { id: actor.id },
          transform: {
            position: [1.25, 0.875, -3] as [number, number, number],
            rotation: [0, 15, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          posePreset: 'neutral',
        },
      ],
    };

    const first = prepareAgentPlan(plan, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: shotId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = prepareAgentPlan(plan, {
      project: first.prepared.nextProject,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: shotId,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const firstKeys = Object.keys(first.prepared.nextProject.shots[0]!.objectOverrides ?? {});
    const secondKeys = Object.keys(second.prepared.nextProject.shots[0]!.objectOverrides ?? {});
    expect(secondKeys).toEqual(firstKeys);
    expect(second.prepared.nextProject.shots[0]!.objectOverrides?.[actor.id])
      .toEqual(first.prepared.nextProject.shots[0]!.objectOverrides?.[actor.id]);
  });

  it('renames, describes, selects, and copies staging to the next shot', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    project.scene.objects.push(actor);
    const firstShot = project.shots[0]!;
    const second = createShot({
      index: 2,
      camera: createCameraData([0, 1.6, 4], [0, 1.4, 0], 40),
      exportDefaults: project.exportConfiguration?.defaults,
    });
    project.shots.push(second);

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'shot.stageObject',
          shot: { id: firstShot.id },
          object: { id: actor.id },
          visible: false,
          humanPose: applyHumanPosePreset('pointing'),
        },
        { op: 'shot.rename', shot: { id: firstShot.id }, name: 'Wide establishing' },
        {
          op: 'shot.updateDescription',
          shot: { id: firstShot.id },
          description: 'Actors enter frame',
        },
        { op: 'shot.copyStagingToNext', shot: { id: firstShot.id } },
        { op: 'shot.select', shot: { id: second.id } },
      ],
    }, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: firstShot.id,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const nextFirst = prepared.prepared.nextProject.shots.find((shot) => shot.id === firstShot.id)!;
    const nextSecond = prepared.prepared.nextProject.shots.find((shot) => shot.id === second.id)!;
    expect(nextFirst.name).toBe('Wide establishing');
    expect(nextFirst.description).toBe('Actors enter frame');
    expect(nextSecond.objectOverrides?.[actor.id]?.visible).toBe(false);
    expect(nextSecond.objectOverrides?.[actor.id]?.humanPose?.presetId).toBe('pointing');
    expect(prepared.prepared.nextSelection.selectedShotId).toBe(second.id);
  });

  it('export planning sees staged visibility after preview preparation', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    project.scene.objects.push(actor);
    const preview = previewAgentPlan({
      version: 1,
      commands: [
        {
          op: 'shot.stageObject',
          shot: { id: project.shots[0]!.id },
          object: { id: actor.id },
          visible: false,
        },
      ],
    }, {
      project,
      workspace: 'export',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]!.id,
    });
    expect(preview.ok).toBe(true);

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'shot.stageObject',
          shot: { id: project.shots[0]!.id },
          object: { id: actor.id },
          visible: false,
        },
      ],
    }, {
      project,
      workspace: 'export',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]!.id,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const livePlan = createExportPlan(project, project.shots);
    const stagedPlan = createExportPlan(
      prepared.prepared.nextProject,
      prepared.prepared.nextProject.shots,
    );
    // Staged visibility changes character-pass inventory; plans remain valid either way.
    expect(stagedPlan.summary.shotCount).toBe(livePlan.summary.shotCount);
    expect(prepared.prepared.nextProject.shots[0]!.objectOverrides?.[actor.id]?.visible).toBe(false);
    expect(project.shots[0]!.objectOverrides?.[actor.id]).toBeUndefined();
  });
});
