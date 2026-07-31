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
  'object.list',
  'object.find',
  'object.inspect',
  'shot.list',
  'shot.inspect',
  'landmark.list',
  'export.plan',
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
] as const;

export const AGENT_DEFERRED_COMMANDS = [
  'file.import',
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
    projectReplacement: false,
    commands: {
      inspect: [...AGENT_INSPECT_COMMANDS],
      mutate: [...AGENT_MUTATE_COMMANDS],
      deferred: [...AGENT_DEFERRED_COMMANDS],
    },
    runtime: {
      focusObjects: typeof runtime.focusObjects === 'function',
      focusShot: typeof runtime.focusShot === 'function',
      captureViewport: typeof runtime.captureViewport === 'function',
    },
  };
}
