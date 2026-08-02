import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  analyzeCharacterImport,
  analyzeSavedRigCharacter,
  importCharacter,
  resetCharacterImportAgentStateForTests,
} from '../src/engine/agent/characterImport';
import { setAgentShotVideoRenderActive } from '../src/engine/agent/videoRenderState';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { preservedRigGlb } from './fixtures/preservedRigGlb';
import { savedRigFsrig } from './fixtures/savedRigFsrig';

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
    expect(analysis.diagnostics).toEqual([]);
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
});
