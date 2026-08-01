import type { HumanJointId, PoseableCharacterOrientation } from '../../domain/types';
import { createId } from '../../utils/ids';
import {
  DEFAULT_POSEABLE_HEIGHT_METERS,
  defaultPoseableOrientation,
} from '../poseableRigNormalize';
import {
  analyzeRiggedCharacterImport,
  importPoseableCharacter,
  type PoseableCharacterImportFormat,
  type RiggedCharacterImportAnalysis,
} from '../poseableCharacterImport';
import { deleteModelAsset } from '../modelAssetStore';
import { ensureImportedRiggedCharactersForProject } from '../importedRiggedPoseableCharacter';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import type {
  AgentCharacterImportAnalysis,
  AgentCharacterImportCommitInput,
  AgentCharacterImportInput,
  AgentCharacterImportMode,
  AgentCharacterImportPhase,
  AgentCharacterImportProgress,
  AgentCharacterImportResult,
} from './protocol';
import { AGENT_DIAGNOSTIC_CODES, agentError } from './diagnostics';

interface StoredAnalysis {
  id: string;
  file: File;
  analysis: RiggedCharacterImportAnalysis;
  orientation: PoseableCharacterOrientation;
  approximateHeightMeters: number;
  mode: AgentCharacterImportMode;
}

let activeAbortController: AbortController | undefined;
let progress: AgentCharacterImportProgress | null = null;
const analyses = new Map<string, StoredAnalysis>();

function phaseForMessage(message: string): AgentCharacterImportPhase {
  const normalized = message.toLowerCase();
  if (normalized.includes('read')) return 'reading';
  if (normalized.includes('load') || normalized.includes('parse')) return 'parsing';
  if (normalized.includes('analy')) return 'analyzing';
  if (normalized.includes('mapping')) return 'mapping';
  if (normalized.includes('valid')) return 'validating';
  if (normalized.includes('writ')) return 'writing';
  return progress?.phase ?? 'analyzing';
}

function setProgress(update: Partial<AgentCharacterImportProgress> & { active: boolean }): void {
  progress = { ...progress, ...update };
}

function startOperation(analysisId?: string): AbortController {
  if (activeAbortController) throw new Error('Another character import is already in progress.');
  const controller = new AbortController();
  activeAbortController = controller;
  setProgress({ active: true, ...(analysisId ? { analysisId } : {}) });
  return controller;
}

function finishOperation(phase: AgentCharacterImportPhase = 'complete'): void {
  setProgress({ active: false, phase });
  activeAbortController = undefined;
}

function formatOf(file: File): PoseableCharacterImportFormat {
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension !== 'glb' && extension !== 'gltf' && extension !== 'fbx') {
    throw new Error('Character import accepts GLB, embedded glTF, or FBX files.');
  }
  return extension;
}

function publicAnalysis(id: string, analysis: RiggedCharacterImportAnalysis): AgentCharacterImportAnalysis {
  const hasSkeleton = analysis.source.bones.length > 0;
  const hasSkinning = analysis.source.skinnedMeshes.length > 0;
  return {
    analysisId: id,
    sourceFormat: analysis.sourceFormat,
    hasSkeleton,
    hasSkinning,
    ...(hasSkeleton ? {
      detectedProfile: analysis.mapping.detectedProfile,
      mappingConfidence: analysis.mapping.confidence,
    } : {}),
    requiredMapped: [...analysis.mapping.requiredMapped],
    requiredMissing: [...analysis.mapping.requiredMissing],
    ambiguousMappings: analysis.mapping.ambiguous,
    skinnedMeshCount: analysis.source.skinnedMeshes.length,
    boneCount: analysis.source.bones.length,
    animationClips: analysis.source.animationClips.map((clip) => ({ name: clip.name, durationSeconds: clip.duration })),
    estimatedMemoryBytes: analysis.sourceBytes.byteLength,
    requiresConsent: false,
    warnings: [...analysis.warnings],
  };
}

export async function analyzeCharacterImport(input: AgentCharacterImportInput): Promise<AgentCharacterImportAnalysis> {
  const format = formatOf(input.file);
  const controller = startOperation();
  const id = createId('character_analysis');
  try {
    setProgress({ active: true, analysisId: id, phase: 'reading', message: `Reading ${input.file.name}…` });
    const analysis = await analyzeRiggedCharacterImport({
      file: input.file,
      orientation: input.orientation ?? defaultPoseableOrientation(),
      signal: controller.signal,
      onProgress: (message) => setProgress({ active: true, analysisId: id, phase: phaseForMessage(message), message }),
    });
    if (analysis.sourceFormat !== format) throw new Error('Character source format could not be determined.');
    analyses.set(id, {
      id,
      file: input.file,
      analysis,
      orientation: input.orientation ?? defaultPoseableOrientation(),
      approximateHeightMeters: input.approximateHeightMeters ?? DEFAULT_POSEABLE_HEIGHT_METERS,
      mode: input.mode ?? 'auto',
    });
    const result = publicAnalysis(id, analysis);
    finishOperation();
    return result;
  } catch (error) {
    finishOperation();
    throw error;
  }
}

export async function importCharacter(input: AgentCharacterImportCommitInput): Promise<AgentCharacterImportResult> {
  const stored = analyses.get(input.analysisId);
  if (!stored) {
    return {
      ok: false,
      warnings: [],
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, `Character analysis "${input.analysisId}" is missing or expired.`, { path: 'analysisId' })],
    };
  }
  const projectState = useProjectStore.getState();
  if (!projectState.project?.id) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.projectNotLoaded, 'No project is loaded.')] };
  }
  if (useProjectSafetyStore.getState().criticalWrite) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is busy.')] };
  }
  if (input.consentToken && input.consentToken.length === 0) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'consentToken must not be empty.', { path: 'consentToken' })] };
  }

  let controller: AbortController;
  try {
    controller = startOperation(input.analysisId);
  } catch (error) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, error instanceof Error ? error.message : 'Another character import is already in progress.')] };
  }

  let result: Awaited<ReturnType<typeof importPoseableCharacter>> | undefined;
  try {
    const effectiveMode = input.mode;
    setProgress({ active: true, analysisId: input.analysisId, phase: 'validating', message: 'Validating character mapping…' });
    result = await importPoseableCharacter({
      file: stored.file,
      orientation: stored.orientation,
      approximateHeightMeters: stored.approximateHeightMeters,
      mode: effectiveMode,
      mappingOverrides: input.mappingOverrides,
      signal: controller.signal,
      onProgress: (message) => setProgress({ active: true, analysisId: input.analysisId, phase: phaseForMessage(message), message }),
    });
    setProgress({ active: true, analysisId: input.analysisId, phase: 'registering', message: 'Registering imported character…' });
    const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
    if (!runDestructive) throw new Error('Local project recovery is still starting.');
    setProgress({ active: true, analysisId: input.analysisId, phase: 'saving', message: 'Saving a verified project revision…' });
    const verified = await runDestructive('Before importing a character through the Agent API', () => {
      const object = input.name?.trim()
        ? { ...result!.object, name: input.name.trim() }
        : result!.object;
      useProjectStore.getState().addPoseableCharacterImport({
        sourceAsset: result!.sourceAsset,
        rigAsset: result!.rigAsset,
        object,
      });
      result!.object = object;
    });
    await ensureImportedRiggedCharactersForProject(useProjectStore.getState().project);
    finishOperation();
    analyses.delete(input.analysisId);
    return {
      ok: true,
      objectId: result.object.id,
      objectRef: { kind: 'object', id: result.object.id, name: result.object.name },
      sourceAssetId: result.sourceAsset.id,
      rigAssetId: result.rigAsset.id,
      poseable: true,
      importedRigPreserved: effectiveMode === 'preserveExistingRig',
      ...(verified?.revision.id ? { verifiedRevisionId: verified.revision.id } : {}),
      warnings: [...result.warnings],
    };
  } catch (error) {
    if (result?.sourceAsset.storageKey) await deleteModelAsset(result.sourceAsset.storageKey).catch(() => undefined);
    finishOperation();
    return {
      ok: false,
      warnings: result?.warnings ?? [],
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, error instanceof Error ? error.message : 'Character import failed.')],
    };
  }
}

export function getCharacterImportProgress(): AgentCharacterImportProgress | null {
  return progress ? { ...progress } : null;
}

export function cancelCharacterImport(): { ok: boolean; cancelled: boolean } {
  if (!activeAbortController) return { ok: true, cancelled: false };
  activeAbortController.abort();
  return { ok: true, cancelled: true };
}

export function resetCharacterImportAgentStateForTests(): void {
  activeAbortController?.abort();
  activeAbortController = undefined;
  progress = null;
  analyses.clear();
}
