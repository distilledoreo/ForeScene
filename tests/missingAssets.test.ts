import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDefaultProject, createTransform } from '../src/domain/defaults';
import { createImportedMeshNode, MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMesh';
import { buildScene } from '../src/engine/sceneObjects';
import { parseProject } from '../src/engine/projectIO';
import { matchMissingAssetCandidates } from '../src/engine/assetRelinking';
import { listMissingProjectAssetWarnings } from '../src/engine/projectAssetRecovery';

describe('missing asset recovery', () => {
  it('migrates a registry entry without an id into a stable logical asset reference', () => {
    const project = createDefaultProject();
    const raw = structuredClone(project) as unknown as Record<string, unknown>;
    const assets = (raw.assets as { assets: Record<string, unknown> }).assets;
    assets.legacyMesh = {
      type: 'model',
      name: 'Temple.glb',
      uri: `${MODEL_ASSET_URI_PREFIX}legacy/temple`,
      createdAt: new Date(0).toISOString(),
    };
    (raw.scene as { objects: unknown[] }).objects.push({
      id: 'missing-object', name: 'Temple', type: 'imported_model', transform: createTransform(),
      dimensions: [2, 2, 2], category: 'architecture', locked: false, visible: true, modelAssetId: 'legacyMesh',
    });
    const opened = parseProject(JSON.stringify(raw));
    const object = opened.scene.objects.find((candidate) => candidate.id === 'missing-object')!;
    expect(opened.schemaVersion).toBe('1.1');
    expect(object.modelAssetId).not.toBe('legacyMesh');
    expect(opened.assets.assets[object.modelAssetId!]?.originalFileName).toBe('Temple.glb');
  });

  it('builds a stable selectable placeholder and omits it from final render scenes', () => {
    const project = createDefaultProject();
    project.assets.assets.mesh = {
      id: 'mesh', type: 'model', name: 'missing.panoref-mesh', originalFileName: 'missing.glb',
      uri: 'panoref-missing:mesh', resolutionStatus: 'missing', createdAt: new Date(0).toISOString(),
    };
    project.scene.objects.push({ id: 'missing-object', name: 'Missing model', type: 'imported_model', transform: createTransform(), dimensions: [2, 3, 4], category: 'architecture', locked: false, visible: true, modelAssetId: 'mesh' });
    const node = createImportedMeshNode(project.scene.objects.at(-1)!, project.assets, new THREE.MeshStandardMaterial());
    expect(node.type).toBe('Group');
    expect(node.userData.missingAssetPlaceholder).toBe(true);
    expect(node.children[0]?.userData.missingAssetPlaceholder).toBe(true);
    expect(buildScene(project).children.some((child) => child.userData.sceneObjectId === 'missing-object')).toBe(true);
    expect(buildScene(project, { showMissingPlaceholders: false }).children.some((child) => child.userData.sceneObjectId === 'missing-object')).toBe(false);
  });

  it('matches a source file by stable filename and byte size', async () => {
    const asset = { id: 'mesh', type: 'model' as const, name: 'Temple.panoref-mesh', originalFileName: 'Temple.glb', byteSize: 4, uri: 'panoref-missing:mesh', resolutionStatus: 'missing' as const, createdAt: new Date(0).toISOString() };
    const matches = await matchMissingAssetCandidates(asset, [new File([new Uint8Array([1, 2, 3, 4])], 'Temple.glb')]);
    expect(matches[0]?.confidence).toBe('name-and-size');
    expect(listMissingProjectAssetWarnings({ ...createDefaultProject(), assets: { assets: { mesh: asset } } })[0]?.assetId).toBe('mesh');
  });
});
