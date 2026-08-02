import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import { createProxyReplacementPlan, verifyProxyReplacement } from '../src/engine/agent/proxyReplacement';
import { resolveProjectForShot } from '../src/engine/shotSceneState';

function replacementProject() {
  const project = createDefaultProject();
  const proxy = createSceneObject('box', 1, [2, 1, -4]);
  proxy.name = 'Object proxy';
  proxy.transform.rotation = [0, 32, 0];
  proxy.transform.scale = [1.2, 1.2, 1.2];
  const replacement = createSceneObject('imported_model', 2, [-10, 0, 5]);
  replacement.name = 'Replacement object';
  replacement.modelAssetId = 'model_replacement_object';
  project.scene.objects.push(proxy, replacement);

  const shot = project.shots[0]!;
  shot.shotNumber = '08';
  shot.objectOverrides = {
    [proxy.id]: {
      visible: true,
      transform: {
        position: [4, 2, -5],
        rotation: [0, 48, 0],
        scale: [1.7, 1.7, 1.7],
      },
    },
  };
  shot.cameraKeyframes = [0, 2].map((timeSeconds) => ({
    id: `keyframe_reveal_${timeSeconds}`,
    label: timeSeconds === 1 ? 'Reveal' : 'Hold',
    timeSeconds,
    camera: structuredClone(shot.camera),
    objectOverrides: {
      [proxy.id]: {
        visible: true,
        transform: {
          position: [4 + timeSeconds, 1.5 + timeSeconds, -5 - timeSeconds],
          rotation: [0, 48 + timeSeconds * 12, 0],
          scale: [1.5 + timeSeconds / 2, 1.5 + timeSeconds / 2, 1.5 + timeSeconds / 2],
        },
      },
    },
  }));
  return { project, proxy, replacement, shot };
}

describe('proxy replacement planning', () => {
  it('assigns a poseable character only to its designated shot while other variants stay hidden', () => {
    const project = createDefaultProject();
    const placeholder = createSceneObject('human_dummy', 1, [1, 0, -3]);
    const intact = createSceneObject('human_dummy', 2, [-4, 0, 1]);
    const alternate = createSceneObject('human_dummy', 3, [-5, 0, 1]);
    intact.name = 'Subject variant A';
    alternate.name = 'Subject variant B';
    alternate.visible = false;
    project.scene.objects.push(placeholder, intact, alternate);
    const shot = project.shots[0]!;
    shot.objectOverrides = {
      [placeholder.id]: {
        visible: true,
        transform: { position: [3, 0, -4], rotation: [0, 20, 0], scale: [1, 1, 1] },
      },
    };

    const result = createProxyReplacementPlan({
      project,
      shotDocuments: project.shots.map((item) => structuredClone(item)),
      proxyObjectId: placeholder.id,
      replacementObjectId: intact.id,
      requestedShotIds: [shot.id],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepared = prepareAgentPlan(result.plan, {
      project, workspace: 'shots', selectedObjectIds: [], selectedShotId: shot.id,
    });
    if (!prepared.ok) throw new Error(prepared.diagnostics.map((item) => item.message).join('\n'));
    const resolved = resolveProjectForShot(prepared.prepared.nextProject, prepared.prepared.nextProject.shots[0]!);
    expect(resolved.scene.objects.find((object) => object.id === intact.id)?.visible).toBe(true);
    expect(resolved.scene.objects.find((object) => object.id === placeholder.id)?.visible).toBe(false);
    expect(resolved.scene.objects.find((object) => object.id === alternate.id)?.visible).toBe(false);
  });

  it('copies global, per-shot, and keyframe transforms while hiding the proxy', () => {
    const { project, proxy, replacement, shot } = replacementProject();
    const originalCamera = structuredClone(shot.camera);
    const result = createProxyReplacementPlan({
      project,
      shotDocuments: project.shots.map((item) => structuredClone(item)),
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      requestedShotIds: ['08'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.affectedShots).toEqual([{
      id: shot.id,
      shotNumber: '08',
      keyframeIds: ['keyframe_reveal_0', 'keyframe_reveal_2'],
    }]);

    const prepared = prepareAgentPlan(result.plan, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: shot.id,
    });
    if (!prepared.ok) throw new Error(prepared.diagnostics.map((item) => item.message).join('\n'));

    const next = prepared.prepared.nextProject;
    expect(next.id).toBe(project.id);
    expect(next.shots.map((item) => item.id)).toEqual(project.shots.map((item) => item.id));
    expect(next.panoRefs.map((item) => item.id)).toEqual(project.panoRefs.map((item) => item.id));
    expect(next.shots[0]!.camera).toEqual(originalCamera);

    const nextProxy = next.scene.objects.find((object) => object.id === proxy.id)!;
    const nextReplacement = next.scene.objects.find((object) => object.id === replacement.id)!;
    expect(nextProxy.visible).toBe(false);
    expect(nextReplacement.visible).toBe(false);
    expect(nextReplacement.transform).toEqual(proxy.transform);

    const direct = next.shots[0]!.objectOverrides!;
    expect(direct[replacement.id]).toMatchObject({
      transform: project.shots[0]!.objectOverrides![proxy.id]!.transform,
    });
    expect(direct[proxy.id]).toMatchObject({
      transform: project.shots[0]!.objectOverrides![proxy.id]!.transform,
    });
    const resolvedShot = resolveProjectForShot(next, next.shots[0]!);
    expect(resolvedShot.scene.objects.find((object) => object.id === replacement.id)?.visible).toBe(true);
    expect(resolvedShot.scene.objects.find((object) => object.id === proxy.id)?.visible).toBe(false);

    const keyframe = next.shots[0]!.cameraKeyframes[0]!;
    expect(keyframe.objectOverrides?.[replacement.id]).toMatchObject({
      transform: project.shots[0]!.cameraKeyframes[0]!.objectOverrides![proxy.id]!.transform,
    });
    expect(keyframe.objectOverrides?.[proxy.id]).toMatchObject({
      transform: project.shots[0]!.cameraKeyframes[0]!.objectOverrides![proxy.id]!.transform,
    });
    expect(verifyProxyReplacement({
      beforeProject: project,
      afterProject: next,
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      preparedShots: result.preparedShots,
      affectedShots: result.affectedShots,
    })).toEqual({ ok: true, errors: [] });
  });

  it('allows a batch to swap one intended proxy occurrence while preserving later occurrences', () => {
    const { project, proxy, replacement, shot } = replacementProject();
    const later = structuredClone(shot);
    later.id = 'shot_later';
    later.shotNumber = '09';
    later.cameraKeyframes = [];
    project.shots.push(later);

    const first = createProxyReplacementPlan({
      project,
      shotDocuments: project.shots.map((item) => structuredClone(item)),
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      intendedShotIds: [shot.id, later.id],
      requestedShotIds: [shot.id],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const preparedFirst = prepareAgentPlan(first.plan, {
      project, workspace: 'shots', selectedObjectIds: [], selectedShotId: shot.id,
    });
    if (!preparedFirst.ok) throw new Error(preparedFirst.diagnostics.map((item) => item.message).join('\n'));
    const afterFirst = preparedFirst.prepared.nextProject;
    expect(resolveProjectForShot(afterFirst, afterFirst.shots[0]!).scene.objects.find((object) => object.id === replacement.id)?.visible).toBe(true);
    expect(resolveProjectForShot(afterFirst, afterFirst.shots[1]!).scene.objects.find((object) => object.id === proxy.id)?.visible).toBe(true);
    expect(resolveProjectForShot(afterFirst, afterFirst.shots[1]!).scene.objects.find((object) => object.id === replacement.id)?.visible).toBe(false);

    const second = createProxyReplacementPlan({
      project: afterFirst,
      shotDocuments: afterFirst.shots.map((item) => structuredClone(item)),
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      intendedShotIds: [shot.id, later.id],
      requestedShotIds: [later.id],
      initializeVisibility: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const preparedSecond = prepareAgentPlan(second.plan, {
      project: afterFirst, workspace: 'shots', selectedObjectIds: [], selectedShotId: later.id,
    });
    if (!preparedSecond.ok) throw new Error(preparedSecond.diagnostics.map((item) => item.message).join('\n'));
    expect(resolveProjectForShot(preparedSecond.prepared.nextProject, preparedSecond.prepared.nextProject.shots[1]!).scene.objects.find((object) => object.id === replacement.id)?.visible).toBe(true);
  });

  it('rejects unknown and unstaged proxy occurrences before it creates a plan', () => {
    const { project, proxy, replacement, shot } = replacementProject();
    const missing = createProxyReplacementPlan({
      project,
      shotDocuments: project.shots.map((item) => structuredClone(item)),
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      requestedShotIds: ['missing'],
    });
    expect(missing).toEqual({ ok: false, errors: ['Unknown shot identifiers: missing.'] });

    shot.objectOverrides = undefined;
    shot.cameraKeyframes = [];
    const empty = createProxyReplacementPlan({
      project,
      shotDocuments: project.shots.map((item) => structuredClone(item)),
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
    });
    expect(empty).toEqual({ ok: false, errors: ['Proxy "Object proxy" is not staged or animated in any shot.'] });
  });

  it('rejects incomplete intended occurrence lists before globally hiding a proxy', () => {
    const { project, proxy, replacement, shot } = replacementProject();
    const omitted = structuredClone(shot);
    omitted.id = 'shot_omitted';
    omitted.shotNumber = '09';
    project.shots.push(omitted);

    expect(createProxyReplacementPlan({
      project,
      shotDocuments: project.shots.map((item) => structuredClone(item)),
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      requestedShotIds: [shot.id],
      intendedShotIds: [shot.id],
    })).toEqual({
      ok: false,
      errors: ['Intended shots omit existing proxy staging in: 09.'],
    });
  });

  it('supports a proxy that appears only in its animated keyframes', () => {
    const { project, proxy, replacement, shot } = replacementProject();
    shot.objectOverrides = undefined;
    const result = createProxyReplacementPlan({
      project,
      shotDocuments: project.shots.map((item) => structuredClone(item)),
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      requestedShotIds: ['08'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepared = prepareAgentPlan(result.plan, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: shot.id,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(verifyProxyReplacement({
      beforeProject: project,
      afterProject: prepared.prepared.nextProject,
      proxyObjectId: proxy.id,
      replacementObjectId: replacement.id,
      preparedShots: result.preparedShots,
      affectedShots: result.affectedShots,
    })).toEqual({ ok: true, errors: [] });
  });
});
