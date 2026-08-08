import type { LocationProject, Shot } from '../../domain/types';
import { downloadBlob } from '../fileTransfers';
import {
  createProjectAssetStorageKey,
  deleteProjectAssetBlob,
} from '../projectAssetStore';
import { pruneUnreferencedProjectAssets } from '../projectAssets';
import { prepareVideoArtifact } from '../prepareVideoArtifact';
import { renderWorkCoordinator } from '../renderWorkCoordinator';
import type { CameraMoveExportProgress } from '../renderers';
import { resolveVideoPreset } from '../videoPresets';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { awaitAgentNotBusy } from './busy';
import { fingerprintShotTimeline } from '../shotTimeline';
import { registerAgentArtifact } from './artifactRegistry';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';
import {
  isAgentShotVideoRenderActive,
  setAgentShotVideoRenderActive,
} from './videoRenderState';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
  type AgentDiagnostic,
} from './diagnostics';
import type {
  AgentShotVideoProgress,
  AgentShotVideoRenderInput,
  AgentShotVideoRenderResult,
} from './protocol';

let abortController: AbortController | null = null;
let latestProgress: AgentShotVideoProgress | null = null;

export { isAgentShotVideoRenderActive } from './videoRenderState';

export function getAgentShotVideoRenderProgress(): AgentShotVideoProgress | null {
  return latestProgress;
}

export function cancelAgentShotVideoRender(): AgentShotVideoRenderResult {
  if (!abortController) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'No shot video render is in progress.')],
      progress: latestProgress ?? undefined,
    };
  }
  abortController.abort();
  latestProgress = {
    phase: 'cancelled',
    progress: latestProgress?.progress ?? 0,
    shotId: latestProgress?.shotId ?? '',
    message: 'Video render cancelled.',
    completedFrames: latestProgress?.completedFrames,
    totalFrames: latestProgress?.totalFrames,
  };
  return { ok: true, status: 'cancelled', shotId: latestProgress.shotId, diagnostics: [], progress: latestProgress };
}

function requireWriteAccess(): AgentDiagnostic[] | null {
  return useAgentControlStore.getState().controlMode === 'read-write'
    ? null
    : [writeAccessRequiredDiagnostic('renderShotVideo')];
}

function toProgress(shotId: string, progress: number | CameraMoveExportProgress): AgentShotVideoProgress {
  if (typeof progress === 'number') {
    return { phase: 'rendering', progress, shotId, message: `Rendered ${Math.round(progress * 100)}%.` };
  }
  const phase: AgentShotVideoProgress['phase'] = progress.phase === 'preparing'
    ? 'preparing'
    : progress.phase === 'rendering'
      ? 'rendering'
      : progress.phase === 'finalizing'
        ? 'encoding'
        : 'complete';
  return {
    phase,
    progress: progress.progress,
    completedFrames: progress.completedFrames,
    totalFrames: progress.totalFrames,
    shotId,
    message: progress.message,
  };
}

function renderName(shot: Shot): string {
  return `shot_${shot.shotNumber}_camera_move.mp4`;
}

async function rollbackAttachedVideo(assetId: string, storageKey: string | undefined): Promise<void> {
  useProjectStore.setState((state) => {
    const shot = state.project.shots.find((item) => item.assets.cameraMoveVideoAssetId === assetId);
    if (!shot) return state;
    const nextProject = pruneUnreferencedProjectAssets({
      ...state.project,
      shots: state.project.shots.map((item) => item.id === shot.id ? {
        ...item,
        assets: { ...item.assets, cameraMoveVideoAssetId: undefined },
        updatedAt: new Date().toISOString(),
      } : item),
      updatedAt: new Date().toISOString(),
    });
    return { ...state, project: nextProject };
  });

  const current = useProjectStore.getState().project;
  if (!current.assets.assets[assetId]) {
    await deleteProjectAssetBlob(
      storageKey ?? createProjectAssetStorageKey(current.id, assetId),
    ).catch(() => undefined);
  }
}

export async function renderAgentShotVideo(
  input: AgentShotVideoRenderInput,
): Promise<AgentShotVideoRenderResult> {
  const blocked = requireWriteAccess();
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  if (abortController) return { ok: false, status: 'busy', shotId: input.shotId, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'A shot video render is already in progress.')] };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', shotId: input.shotId, diagnostics: busy };

  const flushProject = useProjectSafetyStore.getState().flushProject;
  if (!flushProject) return { ok: false, status: 'failed', shotId: input.shotId, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')] };
  let verified: { project: LocationProject } | undefined;
  try {
    verified = await flushProject('Verified save before agent shot video render');
  } catch (error) {
    return { ok: false, status: 'failed', shotId: input.shotId, diagnostics: [agentError('video_render_flush_failed', error instanceof Error ? error.message : 'Failed to save before video render.')] };
  }
  if (!verified) return { ok: false, status: 'failed', shotId: input.shotId, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'No verified project revision is available.')] };
  const project = verified.project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) return { ok: false, status: 'failed', shotId: input.shotId, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${input.shotId}".`)] };
  if (shot.cameraKeyframes.length < 2) return { ok: false, status: 'failed', shotId: input.shotId, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'Shot video render requires at least two keyframes.')] };
  const timelineFingerprintAtStart = fingerprintShotTimeline(shot);

  const attachToShot = input.attachToShot !== false;
  const shouldDownload = input.download !== false;
  const resolutionPreset = input.resolutionPreset ?? '1080p';
  if (!['720p', '1080p', '4k'].includes(resolutionPreset)) {
    return {
      ok: false,
      status: 'failed',
      shotId: shot.id,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, `Unsupported video resolution preset "${String(resolutionPreset)}".`)],
    };
  }
  resolveVideoPreset(resolutionPreset);
  const controller = new AbortController();
  abortController = controller;
  setAgentShotVideoRenderActive(true);
  latestProgress = { phase: 'preparing', progress: 0, shotId: shot.id, message: 'Preparing shot video render.' };

  try {
    // Foreground agent video uses the same fingerprinted cache/in-flight join as
    // package/background preparation while sharing the GPU coordinator.
    const video = await renderWorkCoordinator.schedule(
      'foreground-export-video',
      () => prepareVideoArtifact({
        project,
        shotId: shot.id,
        priority: 'foreground',
        includeDataUrl: attachToShot,
        signal: controller.signal,
        specification: {
          mode: input.mode ?? 'render',
          resolutionPreset,
          appearance: input.appearance ?? 'clay',
          contentMode: input.contentMode,
          backgroundColor: input.backgroundColor,
          includeCharacterAttachments: input.includeCharacterAttachments,
        },
        onProgress: (progress) => { latestProgress = toProgress(shot.id, progress); },
      }),
      { ownerId: shot.id, jobId: `agent-video:${shot.id}` },
    );

    let assetId: string | undefined;
    if (attachToShot) {
      if (!video.dataUrl) throw new Error('Rendered video did not provide attachable data.');
      const currentProject = useProjectStore.getState().project;
      const currentShot = currentProject.shots.find((candidate) => candidate.id === shot.id);
      if (!currentShot || fingerprintShotTimeline(currentShot) !== timelineFingerprintAtStart) {
        if (shouldDownload) downloadBlob(video.blob, renderName(shot));
        latestProgress = {
          phase: 'failed',
          progress: 1,
          shotId: shot.id,
          message: 'Shot timeline changed during video render; output was not attached.',
          error: 'stale_revision',
        };
        return {
          ok: false,
          status: 'stale_revision',
          shotId: shot.id,
          fileName: renderName(shot),
          width: video.width,
          height: video.height,
          durationSeconds: video.durationSeconds,
          frameRate: video.frameRate,
          mimeType: video.mimeType,
          encodeMode: video.encodeMode,
          artifact: registerAgentArtifact({
            blob: video.blob,
            mimeType: video.mimeType,
            fileName: renderName(shot),
            revisionId: useProjectSafetyStore.getState().activeRevisionId,
          }),
          diagnostics: [agentError(
            AGENT_DIAGNOSTIC_CODES.staleRevision,
            'Shot timeline changed during video render; the generated video was not attached.',
          )],
          progress: latestProgress,
        };
      }
      latestProgress = { phase: 'saving', progress: 0.98, shotId: shot.id, message: 'Attaching rendered video to shot.' };
      const asset = useProjectStore.getState().attachCameraMoveVideoToShot(shot.id, {
        name: renderName(shot),
        dataUrl: video.dataUrl,
        mimeType: video.mimeType,
        width: video.width,
        height: video.height,
        durationSeconds: video.durationSeconds,
        frameRate: video.frameRate,
        encodeMode: video.encodeMode,
        codecString: video.codecString,
        frameCount: video.frameCount,
        resolutionPreset,
        validated: video.encodeMode === 'render',
      });
      assetId = asset.id;
      try {
        await flushProject('Persist agent shot video attachment');
      } catch (error) {
        await rollbackAttachedVideo(asset.id, asset.storageKey);
        throw error;
      }
    }
    if (shouldDownload) downloadBlob(video.blob, renderName(shot));
    const revisionId = useProjectSafetyStore.getState().activeRevisionId;
    const artifact = registerAgentArtifact({
      blob: video.blob,
      mimeType: video.mimeType,
      fileName: renderName(shot),
      revisionId,
    });
    latestProgress = { phase: 'complete', progress: 1, shotId: shot.id, message: shouldDownload ? 'Shot video rendered and downloaded.' : 'Shot video rendered.' };
    const status = deriveOperationStatus({ hasArtifact: true, diagnostics: [] });
    return {
      ok: deriveOperationOk(status),
      status,
      shotId: shot.id,
      assetId,
      artifact,
      fileName: renderName(shot),
      width: video.width,
      height: video.height,
      durationSeconds: video.durationSeconds,
      frameRate: video.frameRate,
      mimeType: video.mimeType,
      encodeMode: video.encodeMode,
      revisionId,
      diagnostics: [],
      progress: latestProgress,
    };
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = error instanceof Error ? error.message : 'Shot video render failed.';
    latestProgress = {
      phase: cancelled ? 'cancelled' : 'failed',
      progress: latestProgress?.progress ?? 0,
      shotId: shot.id,
      message: cancelled ? 'Shot video render cancelled.' : message,
      error: cancelled ? undefined : message,
      completedFrames: latestProgress?.completedFrames,
      totalFrames: latestProgress?.totalFrames,
    };
    return {
      ok: false,
      status: cancelled ? 'cancelled' : 'failed',
      shotId: shot.id,
      diagnostics: [agentError(cancelled ? 'video_render_cancelled' : 'video_render_failed', latestProgress.message, {})],
      progress: latestProgress,
    };
  } finally {
    abortController = null;
    setAgentShotVideoRenderActive(false);
  }
}

export function resetAgentShotVideoRenderControl(): void {
  abortController?.abort();
  abortController = null;
  setAgentShotVideoRenderActive(false);
  latestProgress = null;
}
