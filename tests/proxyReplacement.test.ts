import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import { createProxyReplacementPlan, verifyProxyReplacement } from '../src/engine/agent/proxyReplacement';
import { resolveProjectForShot } from '../src/engine/shotSceneState';

function replacementProject() {
  const project = createDefaultProject();
  const proxy = createSceneObject('box', 1, [2, 1, -4]);
  proxy.name = 'Spider proxy';
  proxy.transform.rotation = [0, 32, 0];
  proxy.transform.scale = [1.2, 1.2, 1.2];
  const replacement = createSceneObject('imported_model', 2, [-10, 0, 5]);
  replacement.name = 'Hand Monster';
  replacement.modelAssetId = 'model_hand_monster';
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
      affectedShots: result.affectedShots,
    })).toEqual({ ok: true, errors: [] });
  });

  it('refuses partial or empty replacement coverage before it creates a plan', () => {
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
    expect(empty).toEqual({ ok: false, errors: ['Proxy "Spider proxy" is not staged or animated in any shot.'] });
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
      affectedShots: result.affectedShots,
    })).toEqual({ ok: true, errors: [] });
  });
});
