import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { prepareAgentPlan, previewAgentPlan } from '../src/engine/agent/planCompiler';

function source(project: ReturnType<typeof createDefaultProject>) {
  return { project, workspace: 'shots' as const, selectedObjectIds: [], selectedShotId: project.shots[0]!.id };
}

describe('agent temporal plan commands', () => {
  it('previews a replacement timeline without mutating the live project', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    actor.name = 'Marcus';
    project.scene.objects.push(actor);
    const shotId = project.shots[0]!.id;
    const result = previewAgentPlan({
      version: 1,
      commands: [{
        op: 'shot.timeline.replace', shot: { id: shotId }, durationSeconds: 3.5,
        keyframes: [
          { ref: 'start', timeSeconds: 0, camera: { position: [0, 1.7, -4] }, objects: [{ object: { id: actor.id }, posePreset: 'guard' }] },
          { ref: 'mid', timeSeconds: 1.5, camera: { position: [1, 1.7, -3] }, objects: [{ object: { id: actor.id }, posePreset: 'reach' }] },
          { ref: 'end', timeSeconds: 3.5, camera: { position: [3, 1.8, -2] }, objects: [{ object: { id: actor.id }, posePreset: 'sword-raised' }] },
        ],
      }],
    }, source(project));

    expect(result.ok).toBe(true);
    expect(project.shots[0]!.cameraKeyframes).toHaveLength(0);
    expect(result.diff?.shotsUpdated).toEqual([shotId]);
  });

  it('resolves plan-local keyframe refs across create and stage commands', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    actor.name = 'Marcus';
    project.scene.objects.push(actor);
    const shotId = project.shots[0]!.id;
    const result = prepareAgentPlan({
      version: 1,
      commands: [
        { op: 'shot.keyframe.create', shot: { id: shotId }, ref: 'start', timeSeconds: 0, camera: {} },
        { op: 'shot.keyframe.create', shot: { id: shotId }, ref: 'end', timeSeconds: 2, camera: {} },
        { op: 'shot.keyframe.stageObject', shot: { id: shotId }, keyframe: { ref: 'end' }, object: { query: { name: 'Marcus', match: 'exact' } }, visible: false },
      ],
    }, source(project));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shot = result.prepared.nextProject.shots[0]!;
    expect(shot.cameraKeyframes).toHaveLength(2);
    expect(shot.cameraKeyframes.at(-1)!.objectOverrides?.[actor.id]?.visible).toBe(false);
  });

  it('aborts a plan when a final touched timeline remains incomplete', () => {
    const project = createDefaultProject();
    const result = prepareAgentPlan({
      version: 1,
      commands: [{ op: 'shot.keyframe.create', shot: { id: project.shots[0]!.id }, timeSeconds: 0, camera: {} }],
    }, source(project));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]!.message).toMatch(/at least two keyframes/i);
  });

  it('rejects an intermediate delete that would remove a timeline endpoint', () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    const result = prepareAgentPlan({
      version: 1,
      commands: [
        { op: 'shot.timeline.replace', shot: { id: shotId }, keyframes: [{ timeSeconds: 0, camera: {} }, { timeSeconds: 2, camera: {} }] },
        { op: 'shot.keyframe.delete', shot: { id: shotId }, keyframe: { id: 'missing' } },
      ],
    }, source(project));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]!.code).toBe('target_not_found');
  });
});
