/**
 * Machine-readable discovery for the ForeScene Agent API.
 */

import type { AgentControlMode } from './protocol';
import { FORESCENE_AGENT_API_VERSION } from './protocol';
import {
  AGENT_DEFERRED_COMMANDS,
  AGENT_INSPECT_COMMANDS,
  AGENT_MUTATE_COMMANDS,
  buildAgentCapabilities,
} from './capabilities';
import { AGENT_EXECUTABLE_OPS, AGENT_PLAN_LIMITS } from './constants';
import type {
  AgentOperationDescription,
  AgentSchemaDocument,
} from './protocol';

const OPERATION_DOCS: Record<string, AgentOperationDescription> = {
  setShotPanorama: {
    name: 'setShotPanorama',
    category: 'mutation',
    summary: 'Atomically set or clear a shot linked panorama and pano crop.',
    writeAccess: true,
    input: {
      shotId: 'string',
      panoId: 'string | null',
    },
    returns: 'AgentShotPanoramaResult',
  },
  downloadArtifact: {
    name: 'downloadArtifact',
    category: 'inspect',
    summary: 'Retrieve a previously registered render or export artifact by handle.',
    writeAccess: false,
    input: {
      artifactId: 'string',
      download: 'boolean (optional, default true)',
    },
    returns: 'AgentArtifactDownloadResult',
  },
  exportProjectBackup: {
    name: 'exportProjectBackup',
    category: 'mutation',
    summary: 'Build a verified portable project backup and return an artifact handle.',
    writeAccess: true,
    input: {
      download: 'boolean (optional, default false)',
    },
    returns: 'AgentProjectBackupResult',
  },
  inspectShotDiagnostics: {
    name: 'inspectShotDiagnostics',
    category: 'inspect',
    summary: 'Deterministic shot visibility, grounding, occlusion, and motion diagnostics.',
    writeAccess: false,
    input: {
      shotId: 'string',
      timeSeconds: 'number (optional)',
      subjectIds: 'string[] (optional — inspect any renderable object by id)',
    },
    returns: 'AgentShotDiagnostics',
  },
  snapObjectToFloor: {
    name: 'snapObjectToFloor',
    category: 'mutation',
    summary: 'Ground an upright object on the identified floor for one shot via objectOverrides.',
    writeAccess: true,
    input: { shotId: 'string', object: 'AgentEntityTarget' },
    returns: 'AgentSnapObjectToFloorResult',
  },
  placeObjectNearLandmark: {
    name: 'placeObjectNearLandmark',
    category: 'mutation',
    summary: 'Place an object relative to a landmark for one shot via objectOverrides.',
    writeAccess: true,
    input: {
      shotId: 'string',
      object: 'AgentEntityTarget',
      landmark: 'AgentEntityTarget',
      offset: '[x, y, z] (optional)',
    },
    returns: 'AgentPlaceObjectNearLandmarkResult',
  },
  frameSubjects: {
    name: 'frameSubjects',
    category: 'mutation',
    summary: 'Solve and apply a semantic camera framing for one or more subjects.',
    writeAccess: true,
    input: {
      shotId: 'string',
      subjectIds: 'string[]',
      composition: 'string (optional)',
      shotSize: 'string (optional)',
      padding: 'number (optional)',
    },
    returns: 'AgentFrameSubjectsResult',
  },
  orientObjectToward: {
    name: 'orientObjectToward',
    category: 'mutation',
    summary: 'Rotate an object to face another object for one shot via objectOverrides.',
    writeAccess: true,
    input: { shotId: 'string', object: 'AgentEntityTarget', target: 'AgentEntityTarget' },
    returns: 'AgentOrientObjectTowardResult',
  },
  trackSubjects: {
    name: 'trackSubjects',
    category: 'mutation',
    summary: 'Create start/end keyframes that frame subjects at their timeline positions.',
    writeAccess: true,
    input: {
      shotId: 'string',
      subjectIds: 'string[]',
      startTime: 'number (optional)',
      endTime: 'number (optional)',
      composition: 'string (optional)',
    },
    returns: 'AgentTrackSubjectsResult',
  },
  captureShotStateAsKeyframe: {
    name: 'captureShotStateAsKeyframe',
    category: 'mutation',
    summary: 'Capture the current shot staging as an explicit keyframe.',
    writeAccess: true,
    input: { shotId: 'string', timeSeconds: 'number' },
    returns: 'AgentCaptureKeyframeResult',
  },
  sampleShotState: {
    name: 'sampleShotState',
    category: 'inspect',
    summary: 'Sample camera and object overrides at a timeline time.',
    writeAccess: false,
    input: { shotId: 'string', timeSeconds: 'number' },
    returns: 'AgentShotTimeSample',
  },
  upsertObjectKeyframe: {
    name: 'upsertObjectKeyframe',
    category: 'mutation',
    summary: 'Create or update an object override at a timeline time.',
    writeAccess: true,
    input: {
      shotId: 'string',
      objectId: 'string',
      timeSeconds: 'number',
      preserveExplicitState: 'boolean (optional)',
    },
    returns: 'AgentUpsertObjectKeyframeResult',
  },
  describeCapabilities: {
    name: 'describeCapabilities',
    category: 'inspect',
    summary: 'Return machine-readable capability metadata and command catalog.',
    writeAccess: false,
    returns: 'AgentCapabilityDescription',
  },
  describeOperation: {
    name: 'describeOperation',
    category: 'inspect',
    summary: 'Return documentation for a single Agent API operation.',
    writeAccess: false,
    input: { operation: 'string' },
    returns: 'AgentOperationDescription',
  },
  getAgentSchema: {
    name: 'getAgentSchema',
    category: 'inspect',
    summary: 'Return a JSON-schema-like document for plan and result types.',
    writeAccess: false,
    returns: 'AgentSchemaDocument',
  },
  refreshRevision: {
    name: 'refreshRevision',
    category: 'mutation',
    summary: 'Flush persistence and return the latest verified revision id.',
    writeAccess: true,
    returns: 'AgentRevisionRefreshResult',
  },
};

export function describeAgentCapabilities(controlMode: AgentControlMode) {
  const capabilities = buildAgentCapabilities(controlMode);
  return {
    apiVersion: FORESCENE_AGENT_API_VERSION,
    controlMode,
    capabilities,
    operations: Object.keys(OPERATION_DOCS),
    commands: {
      inspect: [...AGENT_INSPECT_COMMANDS],
      mutate: [...AGENT_MUTATE_COMMANDS],
      deferred: [...AGENT_DEFERRED_COMMANDS],
    },
    renderResultContract: {
      status: ['completed', 'completed_with_warnings', 'failed', 'stale_revision', 'cancelled', 'busy'],
      artifactKinds: ['inline', 'handle'],
      okSemantics: 'ok is true when status is completed or completed_with_warnings',
    },
    revisionContract: {
      everyMutationReturnsRevisionId: true,
      staleRecovery: 'call refreshRevision() then retry, or use automatic render retry',
    },
  };
}

export function describeAgentOperation(operation: string): AgentOperationDescription | undefined {
  return OPERATION_DOCS[operation];
}

export function getAgentSchema(): AgentSchemaDocument {
  return {
    apiVersion: FORESCENE_AGENT_API_VERSION,
    plan: {
      version: 1,
      limits: AGENT_PLAN_LIMITS,
      executableOps: [...AGENT_EXECUTABLE_OPS, 'shot.setPanorama'],
    },
    results: {
      renderShotFrame: {
        status: 'AgentOperationStatus',
        artifact: 'AgentArtifactInline | undefined',
        diagnostics: 'AgentDiagnostic[]',
        legacy: ['ok', 'pngDataUrl', 'pixelStats'],
      },
      renderShotVideo: {
        status: 'AgentOperationStatus',
        artifact: 'AgentArtifactHandle | undefined',
        diagnostics: 'AgentDiagnostic[]',
        legacy: ['ok', 'fileName', 'assetId'],
      },
      exportPackage: {
        status: 'AgentOperationStatus',
        artifact: 'AgentArtifactHandle | undefined',
        diagnostics: 'AgentDiagnostic[]',
      },
      exportProjectBackup: {
        status: 'AgentOperationStatus',
        artifact: 'AgentArtifactHandle',
        diagnostics: 'AgentDiagnostic[]',
      },
    },
    diagnostics: {
      severities: ['info', 'warning', 'error'],
      commonCodes: [
        'write_access_required',
        'stale_revision',
        'target_not_found',
        'frame_zero_variance',
        'artifact_not_found',
      ],
    },
  };
}
