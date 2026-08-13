import { describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference } from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { createProjectPackage, readProjectFile } from '../src/engine/projectIO';
import {
  forceLinkAllShotsToCanonicalPano,
  isShotPanoramaExplicitlyUnlinked,
  linkAllShotsToCanonicalPano,
  relinkCanonicalFollowers,
  unlinkShotPano,
} from '../src/engine/sync';
import { parseForeSceneAgentPlan } from '../src/engine/agent/validation';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import { useProjectStore } from '../src/state/useProjectStore';
import { touchProject } from '../src/state/slices/touchProject';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function projectWithCanonicalPano(): LocationProject {
  const project = createDefaultProject();
  const asset = createPanoAsset({
    name: 'canonical.png',
    uri: TINY_PNG,
    width: 16,
    height: 8,
  });
  const pano = createPanoReference({
    name: 'Canonical',
    assetId: asset.id,
    type: 'ai_global_reference',
    origin: project.scene.panoOrigin,
    width: 16,
    height: 8,
    isCanonical: true,
  });
  return {
    ...project,
    assets: { assets: { ...project.assets.assets, [asset.id]: asset } },
    panoRefs: [pano],
    shots: project.shots.map((shot) => ({ ...shot, linkedPanoId: pano.id })),
  };
}

describe('durable panorama unlink application paths', () => {
  it('does not relink an explicit null through linkAllShotsToCanonicalPano', () => {
    const project = projectWithCanonicalPano();
    project.shots[0] = unlinkShotPano(project.shots[0]!);
    expect(isShotPanoramaExplicitlyUnlinked(project.shots[0]!)).toBe(true);
    const linked = linkAllShotsToCanonicalPano(project);
    expect(linked.shots[0]?.linkedPanoId).toBeNull();
  });

  it('force-relinks only through the explicit force operation', () => {
    const project = projectWithCanonicalPano();
    project.shots[0] = unlinkShotPano(project.shots[0]!);
    const forced = forceLinkAllShotsToCanonicalPano(project);
    expect(forced.shots[0]?.linkedPanoId).toBe(project.panoRefs[0]!.id);
  });

  it('does not overwrite an explicit non-canonical pano assignment', () => {
    const project = projectWithCanonicalPano();
    const extraAsset = createPanoAsset({
      name: 'secondary.png',
      uri: TINY_PNG,
      width: 16,
      height: 8,
    });
    const extra = createPanoReference({
      name: 'Secondary',
      assetId: extraAsset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 16,
      height: 8,
      isCanonical: false,
    });
    project.assets.assets[extraAsset.id] = extraAsset;
    project.panoRefs.push(extra);
    project.shots[0] = { ...project.shots[0]!, linkedPanoId: extra.id };
    const linked = linkAllShotsToCanonicalPano(project);
    expect(linked.shots[0]?.linkedPanoId).toBe(extra.id);
    const replaced = relinkCanonicalFollowers(linked, project.panoRefs[0]!.id);
    expect(replaced.shots[0]?.linkedPanoId).toBe(extra.id);
  });

  it('preserves explicit unlink when opening the shots workspace', () => {
    const project = projectWithCanonicalPano();
    project.shots[0] = unlinkShotPano(project.shots[0]!);
    useProjectStore.setState({
      project: touchProject(project),
      workspace: 'build',
      selectedShotId: project.shots[0]!.id,
      activePanoId: project.panoRefs[0]!.id,
    });
    useProjectStore.getState().setWorkspace('shots');
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBeNull();
  });

  it('preserves an explicit secondary pano when opening the shots workspace', () => {
    const project = projectWithCanonicalPano();
    const extraAsset = createPanoAsset({
      name: 'secondary.png',
      uri: TINY_PNG,
      width: 16,
      height: 8,
    });
    const extra = createPanoReference({
      name: 'Secondary',
      assetId: extraAsset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 16,
      height: 8,
      isCanonical: false,
    });
    project.assets.assets[extraAsset.id] = extraAsset;
    project.panoRefs.push(extra);
    project.shots[0] = { ...project.shots[0]!, linkedPanoId: extra.id };
    useProjectStore.setState({
      project: touchProject(project),
      workspace: 'build',
      selectedShotId: project.shots[0]!.id,
      activePanoId: extra.id,
    });
    useProjectStore.getState().setWorkspace('shots');
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBe(extra.id);
  });

  it('preserves explicit unlink when importing a replacement canonical pano', () => {
    const project = projectWithCanonicalPano();
    project.shots[0] = unlinkShotPano(project.shots[0]!);
    useProjectStore.setState({
      project: touchProject(project),
      workspace: 'reference',
      selectedShotId: project.shots[0]!.id,
      activePanoId: project.panoRefs[0]!.id,
    });
    useProjectStore.getState().importCanonicalPano({
      name: 'replacement.png',
      dataUrl: TINY_PNG,
      width: 16,
      height: 8,
    });
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBeNull();
  });

  it('preserves an explicit secondary pano when importing a replacement canonical pano', () => {
    const project = projectWithCanonicalPano();
    const extraAsset = createPanoAsset({
      name: 'secondary.png',
      uri: TINY_PNG,
      width: 16,
      height: 8,
    });
    const extra = createPanoReference({
      name: 'Secondary',
      assetId: extraAsset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 16,
      height: 8,
      isCanonical: false,
    });
    project.assets.assets[extraAsset.id] = extraAsset;
    project.panoRefs.push(extra);
    project.shots[0] = { ...project.shots[0]!, linkedPanoId: extra.id };
    useProjectStore.setState({
      project: touchProject(project),
      workspace: 'reference',
      selectedShotId: project.shots[0]!.id,
      activePanoId: extra.id,
    });
    useProjectStore.getState().importCanonicalPano({
      name: 'replacement.png',
      dataUrl: TINY_PNG,
      width: 16,
      height: 8,
    });
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBe(extra.id);
  });

  it('preserves explicit unlink when adding and removing another panorama', () => {
    const project = projectWithCanonicalPano();
    const extraAsset = createPanoAsset({
      name: 'secondary.png',
      uri: TINY_PNG,
      width: 16,
      height: 8,
    });
    const extra = createPanoReference({
      name: 'Secondary',
      assetId: extraAsset.id,
      type: 'ai_global_reference',
      origin: project.scene.panoOrigin,
      width: 16,
      height: 8,
      isCanonical: false,
    });
    project.assets.assets[extraAsset.id] = extraAsset;
    project.panoRefs.push(extra);
    project.shots[0] = unlinkShotPano(project.shots[0]!);
    useProjectStore.setState({
      project: touchProject(project),
      workspace: 'reference',
      selectedShotId: project.shots[0]!.id,
      activePanoId: project.panoRefs[0]!.id,
    });
    useProjectStore.getState().removePanoReference(extra.id);
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBeNull();
  });

  it('preserves explicit unlink through workspace.open plan compilation', () => {
    const project = projectWithCanonicalPano();
    project.shots[0] = unlinkShotPano(project.shots[0]!);
    const parsed = parseForeSceneAgentPlan({
      version: 1,
      commands: [{ op: 'workspace.open', workspace: 'shots' }],
    });
    expect(parsed.errors).toEqual([]);
    const prepared = prepareAgentPlan(parsed.plan!, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]!.id,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.nextProject.shots[0]?.linkedPanoId).toBeNull();
  });

  it('preserves explicit unlink through export and import', async () => {
    const project = projectWithCanonicalPano();
    project.shots[0] = unlinkShotPano(project.shots[0]!);
    const blob = await createProjectPackage(project);
    const imported = await readProjectFile(new File([blob], 'unlink.fsp'));
    expect(imported.shots[0]?.linkedPanoId).toBeNull();
    useProjectStore.getState().setProject(imported);
    expect(useProjectStore.getState().project.shots[0]?.linkedPanoId).toBeNull();
  });
});
