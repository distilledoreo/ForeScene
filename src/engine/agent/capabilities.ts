/**
 * Capability reporting for the ForeScene Agent API.
 */

import type { AgentControlMode, ForeSceneAgentCapabilities } from './protocol';
import { FORESCENE_AGENT_API_VERSION } from './protocol';
import { getForeSceneRuntimeServices } from './runtimeRegistry';

/** Inspection commands available in PR1. */
export const AGENT_INSPECT_COMMANDS = [
  'app.status',
  'app.capabilities',
  'project.inspect',
  'project.document',
  'shot.document',
  'object.list',
  'object.find',
  'object.inspect',
  'shot.list',
  'shot.inspect',
  'shot.timeline.inspect',
  'shot.timeline.sample',
  'landmark.list',
  'export.plan',
  'viewport.waitReady',
  'shot.renderFrame',
  'character.analyze',
  'character.analyzeSavedRig',
  'character.progress',
] as const;

/** Mutation / plan commands available when write access is enabled. */
export const AGENT_MUTATE_COMMANDS = [
  'project.updateInfo',
  'object.create',
  'object.update',
  'object.transform.set',
  'object.duplicate',
  'object.delete',
  'object.setVisible',
  'object.setLocked',
  'selection.setObjects',
  'workspace.open',
  'shot.create',
  'shot.rename',
  'shot.updateDescription',
  'shot.camera.set',
  'shot.select',
  'shot.copyStagingToNext',
  'shot.stageObject',
  'shot.clearObjectPose',
  'shot.clearObjectStaging',
  'shot.timeline.replace',
  'shot.timeline.clear',
  'shot.timeline.setDuration',
  'shot.keyframe.create',
  'shot.keyframe.update',
  'shot.keyframe.delete',
  'shot.keyframe.stageObject',
  'shot.keyframe.clearStaging',
  'shot.delete',
  'landmark.create',
  'landmark.update',
  'landmark.delete',
  'landmark.linkObject',
  'export.sceneDefaults.patch',
  'export.shotOverrides.patch',
  'export.shotOverrides.reset',
  'export.shotOverrides.copy',
  'export.shotOverrides.promote',
  'export.package',
  'project.reset',
  'character.import',
  'character.importSavedRig',
  'model.import',
] as const;

export const AGENT_DEFERRED_COMMANDS = [
  'file.import',
  'character.cancel',
] as const;

export const AGENT_RUNTIME_COMMANDS = [
  'viewport.waitReady',
  'shot.renderFrame',
  'viewport.capture',
] as const;

export function buildAgentCapabilities(
  controlMode: AgentControlMode,
): ForeSceneAgentCapabilities {
  const runtime = getForeSceneRuntimeServices();
  const writeAccess = controlMode === 'read-write';
  return {
    apiVersion: FORESCENE_AGENT_API_VERSION,
    controlMode,
    inspection: controlMode !== 'off',
    mutations: writeAccess,
    packageExport: true,
    characterImport: true,
    projectReplacement: writeAccess,
    timelineInspection: controlMode !== 'off',
    timelineSampling: controlMode !== 'off',
    commands: {
      inspect: [...AGENT_INSPECT_COMMANDS],
      mutate: [...AGENT_MUTATE_COMMANDS],
      deferred: [...AGENT_DEFERRED_COMMANDS],
    },
    runtime: {
      focusObjects: typeof runtime.focusObjects === 'function',
      focusShot: typeof runtime.focusShot === 'function',
      captureViewport: typeof runtime.captureViewport === 'function',
      renderShotFrame: true,
      waitForViewportReady: true,
    },
  };
}
