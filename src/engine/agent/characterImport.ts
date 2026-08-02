import * as THREE from 'three';
import type { HumanJointId, PoseableCharacterOrientation } from '../../domain/types';
import { createId } from '../../utils/ids';
import {
  DEFAULT_POSEABLE_HEIGHT_METERS,
  defaultPoseableOrientation,
} from '../poseableRigNormalize';
import {
  analyzeRiggedCharacterImport,
  analyzeSavedRigCompatibility,
  cleanupPoseableCharacterImportResult,
  importPoseableCharacter,
  importPoseableCharacterWithSavedRig,
  type PoseableCharacterImportFormat,
  type SavedRigCharacterImportResult,
  type RiggedCharacterImportAnalysis,
} from '../poseableCharacterImport';
import { deleteModelAsset } from '../modelAssetStore';
import {
  ensureImportedRiggedCharactersForProject,
  hydrateImportedRiggedCharactersFromAssets,
} from '../importedRiggedPoseableCharacter';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { detectImportDeviceProfile, estimateModelImportBudget, type ImportGeometryStats } from '../modelImportBudget';
import { collectAgentBusyDiagnostics } from './busy';
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
  createdAt: number;
  lastUsedAt: number;
}

let activeAbortController: AbortController | undefined;
let progress: AgentCharacterImportProgress | null = null;
const analyses = new Map<string, StoredAnalysis>();
const ANALYSIS_TTL_MS = 5 * 60_000;
const MAX_ANALYSES = 2;
let activeAnalysisId: string | undefined;

function evictExpiredAnalyses(now = Date.now()): void {
  for (const [id, entry] of analyses) {
    if (now - entry.lastUsedAt > ANALYSIS_TTL_MS) analyses.delete(id);
  }
  while (analyses.size > MAX_ANALYSES) {
    const oldest = [...analyses.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!oldest) break;
    analyses.delete(oldest.id);
  }
}

function importBudget(analysis: RiggedCharacterImportAnalysis) {
  let loadedVertexCount = 0;
  let triangleCount = 0;
  let meshNodeCount = 0;
  let uniquePositionBytes = 0;
  let uniqueIndexBytes = 0;
  analysis.source.root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshNodeCount += 1;
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    loadedVertexCount += position?.count ?? 0;
    triangleCount += index ? index.count / 3 : (position?.count ?? 0) / 3;
    uniquePositionBytes += position?.array.byteLength ?? 0;
    uniqueIndexBytes += index?.array.byteLength ?? 0;
  });
  const stats: ImportGeometryStats = {
    loadedVertexCount,
    triangleCount,
    meshNodeCount,
    instanceCount: 1,
    expandedInstanceCount: 1,
    uniquePositionBytes,
    uniqueIndexBytes,
    outputPositionBytes: uniquePositionBytes,
    outputIndexBytes: uniqueIndexBytes,
    mode: 'separate',
  };
  return estimateModelImportBudget(stats, detectImportDeviceProfile());
}

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
  const budget = importBudget(analysis);
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
    estimatedMemoryBytes: budget.estimatedPeakHeapBytes,
    requiresConsent: budget.tier === 'heavy' || budget.tier === 'extreme',
    warnings: [
      ...analysis.warnings,
      ...(budget.tier === 'heavy' || budget.tier === 'extreme' ? ['This import is above the standard memory tier and requires explicit consent.'] : []),
      ...(budget.tier === 'reject' ? [`Import exceeds the device-aware safety budget: ${budget.exceeded.join(', ')}.`] : []),
    ],
  };
}

export async function analyzeCharacterImport(input: AgentCharacterImportInput): Promise<AgentCharacterImportAnalysis> {
  evictExpiredAnalyses();
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
    const now = Date.now();
    analyses.set(id, {
      id,
      file: input.file,
      analysis,
      orientation: input.orientation ?? defaultPoseableOrientation(),
      approximateHeightMeters: input.approximateHeightMeters ?? DEFAULT_POSEABLE_HEIGHT_METERS,
      mode: input.mode ?? 'auto',
      createdAt: now,
      lastUsedAt: now,
    });
    evictExpiredAnalyses(now);
    const result = publicAnalysis(id, analysis);
    finishOperation();
    return result;
  } catch (error) {
    finishOperation();
    throw error;
  }
}

export async function analyzeSavedRigCharacter(input: {
  sourceFile: File;
  rigPackageFile: File;
  approximateHeightMeters?: number;
}) {
  const controller = startOperation();
  try {
    setProgress({ active: true, phase: 'reading', message: `Reading ${input.rigPackageFile.name}…` });
    const result = await analyzeSavedRigCompatibility({
      sourceFile: input.sourceFile,
      rigPackageFile: input.rigPackageFile,
      approximateHeightMeters: input.approximateHeightMeters,
    });
    if (result.diagnostics.length > 0) {
      setProgress({ active: true, phase: 'validating', message: 'Saved rig compatibility failed.' });
    }
    finishOperation();
    return result;
  } catch (error) {
    finishOperation();
    throw error;
  }
}

export async function importSavedRigCharacter(input: {
  sourceFile: File;
  rigPackageFile: File;
  name: string;
  approximateHeightMeters?: number;
}): Promise<AgentCharacterImportResult> {
  const projectState = useProjectStore.getState();
  if (!projectState.project?.id) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.projectNotLoaded, 'No project is loaded.')] };
  }
  if (useProjectSafetyStore.getState().criticalWrite) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is busy.')] };
  }
  const busy = collectAgentBusyDiagnostics();
  if (busy.length > 0) return { ok: false, warnings: [], diagnostics: busy };

  let controller: AbortController;
  try {
    controller = startOperation();
  } catch (error) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, error instanceof Error ? error.message : 'Another character import is already in progress.')] };
  }

  let result: SavedRigCharacterImportResult | undefined;
  try {
    setProgress({ active: true, phase: 'reading', message: `Reading ${input.sourceFile.name}…` });
    const sourceAnalysis = await analyzeRiggedCharacterImport({
      file: input.sourceFile,
      signal: controller.signal,
      onProgress: (message) => setProgress({ active: true, phase: phaseForMessage(message), message }),
    });
    const budget = importBudget(sourceAnalysis);
    if (budget.tier === 'reject') {
      throw new Error(`Character import exceeds the device-aware safety budget: ${budget.exceeded.join(', ')}.`);
    }
    setProgress({ active: true, phase: 'validating', message: 'Validating saved rig compatibility…' });
    const analysis = await analyzeSavedRigCompatibility({
      sourceFile: input.sourceFile,
      rigPackageFile: input.rigPackageFile,
      approximateHeightMeters: input.approximateHeightMeters,
    });
    if (!analysis.ok) {
      throw new Error(analysis.diagnostics.map((item) => item.message).join(' '));
    }
    result = await importPoseableCharacterWithSavedRig({
      sourceFile: input.sourceFile,
      rigPackageFile: input.rigPackageFile,
      name: input.name,
      approximateHeightMeters: input.approximateHeightMeters,
      signal: controller.signal,
      onProgress: (message) => setProgress({ active: true, phase: phaseForMessage(message), message }),
    });
    const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
    if (!runDestructive) throw new Error('Local project recovery is still starting.');
    setProgress({ active: true, phase: 'saving', message: 'Saving a verified project revision…' });
    const verified = await runDestructive('Before importing a saved-rig character through the Agent API', () => {
      useProjectStore.getState().addPoseableCharacterImport({
        sourceAsset: result!.sourceAsset,
        rigAsset: result!.rigAsset,
        object: result!.object,
      });
      useProjectStore.setState((current) => ({
        project: {
          ...current.project,
          assets: {
            assets: {
              ...current.project.assets.assets,
              ...(result!.packageAssets.sourceAsset
                ? { [result!.packageAssets.sourceAsset.id]: result!.packageAssets.sourceAsset }
                : {}),
              ...(result!.packageAssets.skinAsset
                ? { [result!.packageAssets.skinAsset.id]: result!.packageAssets.skinAsset }
                : {}),
              ...(result!.packageAssets.regionAsset
                ? { [result!.packageAssets.regionAsset.id]: result!.packageAssets.regionAsset }
                : {}),
            },
          },
        },
      }));
    });
    hydrateImportedRiggedCharactersFromAssets(useProjectStore.getState().project.assets);
    const { ensureAutoriggedCharactersForProject } = await import('../autoriggedPoseableCharacter');
    await ensureAutoriggedCharactersForProject(useProjectStore.getState().project);
    await ensureImportedRiggedCharactersForProject(useProjectStore.getState().project);
    finishOperation();
    return {
      ok: true,
      objectId: result.object.id,
      objectRef: { kind: 'object', id: result.object.id, name: result.object.name },
      sourceAssetId: result.sourceAsset.id,
      rigAssetId: result.rigAsset.id,
      poseable: true,
      importedRigPreserved: Boolean(result.rig.importedRigBinding),
      appliedSavedRig: true,
      topologyVerified: result.topologyVerified,
      ...(verified?.revision.id ? { verifiedRevisionId: verified.revision.id } : {}),
      warnings: [...result.warnings, 'Attached saved rig — skipping the rigging wizard.'],
    };
  } catch (error) {
    if (result) await cleanupPoseableCharacterImportResult(result);
    finishOperation();
    return {
      ok: false,
      warnings: result?.warnings ?? [],
      diagnostics: [agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        error instanceof Error ? error.message : 'Saved-rig character import failed.',
      )],
    };
  }
}

export async function importCharacter(input: AgentCharacterImportCommitInput): Promise<AgentCharacterImportResult> {
  evictExpiredAnalyses();
  const stored = analyses.get(input.analysisId);
  if (!stored) {
    return {
      ok: false,
      warnings: [],
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, `Character analysis "${input.analysisId}" is missing or expired.`, { path: 'analysisId' })],
    };
  }
  stored.lastUsedAt = Date.now();
  const budget = importBudget(stored.analysis);
  if (budget.tier === 'reject') {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, `Character import exceeds the device-aware safety budget: ${budget.exceeded.join(', ')}.`)] };
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
  if ((budget.tier === 'heavy' || budget.tier === 'extreme') && !input.consentToken) {
    return { ok: false, warnings: [], diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'This character import requires explicit consent because it exceeds the standard memory tier.', { path: 'consentToken' })] };
  }

  const busy = collectAgentBusyDiagnostics();
  if (busy.length > 0) {
    return { ok: false, warnings: [], diagnostics: busy };
  }

  let controller: AbortController;
  try {
    controller = startOperation(input.analysisId);
    activeAnalysisId = input.analysisId;
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
    activeAnalysisId = undefined;
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
    analyses.delete(input.analysisId);
    activeAnalysisId = undefined;
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

export function isCharacterImportActive(): boolean {
  return Boolean(activeAbortController);
}

export function discardCharacterImportAnalysis(analysisId: string): { ok: boolean; discarded: boolean } {
  return { ok: true, discarded: analyses.delete(analysisId) };
}

export function cancelCharacterImport(): { ok: boolean; cancelled: boolean } {
  if (!activeAbortController) return { ok: true, cancelled: false };
  activeAbortController.abort();
  if (activeAnalysisId) analyses.delete(activeAnalysisId);
  return { ok: true, cancelled: true };
}

export function resetCharacterImportAgentStateForTests(): void {
  activeAbortController?.abort();
  activeAbortController = undefined;
  activeAnalysisId = undefined;
  progress = null;
  analyses.clear();
}
