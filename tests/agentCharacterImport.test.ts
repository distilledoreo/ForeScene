import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  analyzeCharacterImport,
  importCharacter,
  resetCharacterImportAgentStateForTests,
} from '../src/engine/agent/characterImport';
import { setAgentShotVideoRenderActive } from '../src/engine/agent/videoRenderState';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { preservedRigGlb } from './fixtures/preservedRigGlb';

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
});
