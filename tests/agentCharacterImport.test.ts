import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  analyzeCharacterImport,
  analyzeSavedRigCharacter,
  importCharacter,
  importSavedRigCharacter,
  resetCharacterImportAgentStateForTests,
} from '../src/engine/agent/characterImport';
import { setAgentShotVideoRenderActive } from '../src/engine/agent/videoRenderState';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { preservedRigGlb } from './fixtures/preservedRigGlb';
import { savedRigFsrig } from './fixtures/savedRigFsrig';
import { unriggedHumanoidGlb } from './fixtures/unriggedHumanoidGlb';

describe('agent character import busy protection', () => {
  beforeEach(() => {
    resetCharacterImportAgentStateForTests();
    setAgentShotVideoRenderActive(false);
    useProjectStore.setState({
      project: createDefaultProject(),
      isExportingPackage: false,
      isRenderingGraybox: false,
    });
    useProjectSafetyStore.setState({ criticalWrite: false });
    useProjectSafetyStore.setState({
      runDestructiveProjectMutation: async (_reason, mutate) => {
        await mutate();
        return { revision: { id: 'rev-character-import' } } as never;
      },
    });
  });

  it.each([
    ['package export', () => useProjectStore.setState({ isExportingPackage: true })],
    ['graybox rendering', () => useProjectStore.setState({ isRenderingGraybox: true })],
    ['video rendering', () => setAgentShotVideoRenderActive(true)],
  ])('refuses to start while %s is active', async (_label, setBusy) => {
    const analysis = await analyzeCharacterImport({
      file: new File([preservedRigGlb()], 'preserved.glb', { type: 'model/gltf-binary' }),
      mode: 'preserveExistingRig',
    });
    setBusy();

    const result = await importCharacter({
      analysisId: analysis.analysisId,
      mode: 'preserveExistingRig',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics?.[0]?.code).toBe('busy');
    expect(result.diagnostics?.[0]?.message).toContain('in progress');
  });

  it('preflights a saved-rig source/package pair without writing project assets', async () => {
    const analysis = await analyzeSavedRigCharacter({
      sourceFile: new File([preservedRigGlb()], 'preserved.glb', { type: 'model/gltf-binary' }),
      rigPackageFile: new File([await savedRigFsrig()], 'preserved.fsrig', { type: 'application/zip' }),
    });

    expect(analysis.ok, JSON.stringify(analysis)).toBe(true);
    expect(analysis.topologyVerified).toBe(true);
    expect(analysis.sourceVertexCount).toBe(6);
    expect(analysis.packageVertexCount).toBe(6);
    expect(analysis.glbFingerprint).toMatch(/^sha256:/);
    expect(analysis.rigPackageFingerprint).toMatch(/^sha256:/);
    expect(analysis.importFingerprint).toMatch(/^sha256:/);
    expect(analysis.importBudget?.tier).toBe('standard');
    expect(analysis.consent).toEqual({ required: false, provided: false, authorized: true });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('recognizes an unrigged humanoid source so the saved package supplies the rig', async () => {
    const analysis = await analyzeCharacterImport({
      file: new File([unriggedHumanoidGlb()], 'unrigged-humanoid.glb', { type: 'model/gltf-binary' }),
      mode: 'auto',
    });

    expect(analysis.hasSkeleton).toBe(false);
    expect(analysis.hasSkinning).toBe(false);
    expect(analysis.boneCount).toBe(0);
    expect(analysis.skinnedMeshCount).toBe(0);
  });

  it('returns an actionable diagnostic for a corrupt saved-rig package', async () => {
    const analysis = await analyzeSavedRigCharacter({
      sourceFile: new File([preservedRigGlb()], 'preserved.glb', { type: 'model/gltf-binary' }),
      rigPackageFile: new File([new Uint8Array([1, 2, 3])], 'broken.fsrig', { type: 'application/zip' }),
    });

    expect(analysis.ok).toBe(false);
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'corrupt_rig_package', severity: 'error' }),
    ]));
  });

  it('imports a matching unrigged GLB + saved rig without changing the existing project, shots, or panoramas', async () => {
    const before = structuredClone(useProjectStore.getState().project);
    const result = await importSavedRigCharacter({
      sourceFile: new File([unriggedHumanoidGlb()], 'joseph.glb', { type: 'model/gltf-binary' }),
      rigPackageFile: new File([await savedRigFsrig()], 'joseph.fsrig', { type: 'application/zip' }),
      name: 'Joseph — Intact',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.objectId).toBeTruthy();
    expect(result.appliedSavedRig).toBe(true);
    expect(result.topologyVerified).toBe(true);
    expect(result.glbFingerprint).toMatch(/^sha256:/);
    expect(result.rigPackageFingerprint).toMatch(/^sha256:/);
    expect(result.importFingerprint).toMatch(/^sha256:/);
    expect(result.importBudget?.tier).toBe('standard');
    expect(result.consent).toEqual({ required: false, provided: false, authorized: true });

    const after = useProjectStore.getState().project;
    expect(after.id).toBe(before.id);
    expect(after.shots).toEqual(before.shots);
    expect(after.panoRefs).toEqual(before.panoRefs);
    expect(after.scene.objects).toHaveLength(before.scene.objects.length + 1);
    expect(after.scene.objects.at(-1)?.metadata?.agentSavedRigImport).toMatchObject({
      importFingerprint: result.importFingerprint,
      topologyVerified: true,
    });
  });

  it('does not write project state for mismatched or corrupt saved-rig packages', async () => {
    const sourceFile = new File([unriggedHumanoidGlb()], 'joseph.glb', { type: 'model/gltf-binary' });
    const beforeMismatch = structuredClone(useProjectStore.getState().project);
    const mismatch = await importSavedRigCharacter({
      sourceFile,
      rigPackageFile: new File([await savedRigFsrig({ vertexCount: 7 })], 'wrong.fsrig', { type: 'application/zip' }),
      name: 'Joseph — Wrong',
    });
    expect(mismatch.ok).toBe(false);
    expect(useProjectStore.getState().project).toEqual(beforeMismatch);

    const beforeCorrupt = structuredClone(useProjectStore.getState().project);
    const corrupt = await importSavedRigCharacter({
      sourceFile,
      rigPackageFile: new File([new Uint8Array([1, 2, 3])], 'broken.fsrig', { type: 'application/zip' }),
      name: 'Joseph — Broken',
    });
    expect(corrupt.ok).toBe(false);
    expect(useProjectStore.getState().project).toEqual(beforeCorrupt);
  });

  it('requires consent for heavy saved-rig imports and reports the authorization state', async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'deviceMemory');
    Object.defineProperty(globalThis.navigator, 'deviceMemory', {
      configurable: true,
      value: 0.000003,
    });
    try {
      const sourceFile = new File([unriggedHumanoidGlb()], 'joseph.glb', { type: 'model/gltf-binary' });
      const rigPackageFile = new File([await savedRigFsrig()], 'joseph.fsrig', { type: 'application/zip' });
      const withoutConsent = await importSavedRigCharacter({ sourceFile, rigPackageFile, name: 'Joseph — Heavy' });
      expect(withoutConsent.ok).toBe(false);
      expect(withoutConsent.importBudget?.tier).toBe('heavy');
      expect(withoutConsent.consent).toEqual({ required: true, provided: false, authorized: false });
      expect(useProjectStore.getState().project.scene.objects.some((item) => item.name === 'Joseph — Heavy')).toBe(false);

      const withConsent = await importSavedRigCharacter({
        sourceFile,
        rigPackageFile,
        name: 'Joseph — Heavy',
        consentToken: 'test-explicit-consent',
      });
      expect(withConsent.ok, JSON.stringify(withConsent)).toBe(true);
      expect(withConsent.consent).toEqual({ required: true, provided: true, authorized: true });
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis.navigator, 'deviceMemory', navigatorDescriptor);
      else Reflect.deleteProperty(globalThis.navigator, 'deviceMemory');
    }
  });

  it('reuses an exact saved-rig pair but imports again when either binary changes', async () => {
    const source = new File([unriggedHumanoidGlb()], 'joseph.glb', { type: 'model/gltf-binary' });
    const rigPackage = new File([await savedRigFsrig()], 'joseph.fsrig', { type: 'application/zip' });
    const first = await importSavedRigCharacter({ sourceFile: source, rigPackageFile: rigPackage, name: 'Joseph — Intact' });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    const repeated = await importSavedRigCharacter({ sourceFile: source, rigPackageFile: rigPackage, name: 'Joseph — Duplicate' });
    expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
    expect(repeated.reused).toBe(true);
    expect(repeated.objectId).toBe(first.objectId);
    expect(useProjectStore.getState().project.scene.objects.filter((item) => item.metadata?.agentSavedRigImport).length).toBe(1);

    const changedPackage = await importSavedRigCharacter({
      sourceFile: source,
      rigPackageFile: new File([await savedRigFsrig({ characterName: 'Joseph v2' })], 'joseph-v2.fsrig', { type: 'application/zip' }),
      name: 'Joseph — Package v2',
    });
    expect(changedPackage.ok, JSON.stringify(changedPackage)).toBe(true);
    expect(changedPackage.importFingerprint).not.toBe(first.importFingerprint);
    expect(changedPackage.objectId).not.toBe(first.objectId);

    const changedSource = await importSavedRigCharacter({
      sourceFile: new File([unriggedHumanoidGlb({ nodeName: 'JosephV2' })], 'joseph-v2.glb', { type: 'model/gltf-binary' }),
      rigPackageFile: rigPackage,
      name: 'Joseph — Source v2',
    });
    expect(changedSource.ok, JSON.stringify(changedSource)).toBe(true);
    expect(changedSource.importFingerprint).not.toBe(first.importFingerprint);
    expect(changedSource.objectId).not.toBe(first.objectId);
  });
});
