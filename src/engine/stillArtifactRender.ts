/**
 * Canonical still-artifact renderer. Routes to existing WebGL entry points;
 * does not reimplement projection, depth, or character passes.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  getSortedCameraKeyframes,
  interpolateCameraKeyframes,
} from './cameraKeyframes';
import {
  renderShotDepthFrame,
  renderViewportDepth,
  resolveShotDepthRangeForExport,
  resolveShotDepthSettings,
  type DepthRangeMeters,
} from './depthRender';
import { dataUrlToBlob } from './fileTransfers';
import { interpolateObjectOverrides } from './objectKeyframes';
import {
  renderShotCharacterFrame,
  renderShotFrame,
  renderShotProjectedFrame,
  renderViewportClay,
  renderViewportProjected,
} from './renderers';
import {
  resolveProjectForShot,
  type SceneContentMode,
} from './shotSceneState';
import type { StillArtifactSpecification } from './stillArtifactTypes';

export interface RenderedStillArtifact {
  blob: Blob;
  width: number;
  height: number;
  mimeType: 'image/png';
}

export interface RenderStillArtifactParams {
  project: LocationProject;
  shot: Shot;
  specification: StillArtifactSpecification;
  signal?: AbortSignal;
  /** Shared shot-wide depth range; resolved once per batch when omitted for depth specs. */
  depthRange?: DepthRangeMeters;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Still render was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function resolveContentMode(spec: StillArtifactSpecification): SceneContentMode {
  if (spec.contentMode) return spec.contentMode;
  if (spec.peopleVariant === 'clean_plate') return 'clean_plate';
  return 'full_scene';
}

function cameraAtTime(shot: Shot, timeSeconds: number | undefined) {
  if (timeSeconds === undefined) return shot.camera;
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes);
  if (keyframes.length === 0) return shot.camera;
  try {
    return interpolateCameraKeyframes(keyframes, timeSeconds);
  } catch {
    return shot.camera;
  }
}

/**
 * Build a project snapshot for a reference-frame still:
 * interpolate camera + object overrides at t, apply content mode / staging.
 */
export function resolveProjectForStillSpecification(
  project: LocationProject,
  shot: Shot,
  specification: StillArtifactSpecification,
): { project: LocationProject; shot: Shot } {
  const contentMode = resolveContentMode(specification);
  const includeCharacterAttachments = specification.includeCharacterAttachments !== false;

  if (specification.timeSeconds === undefined) {
    return {
      project: resolveProjectForShot(project, shot, {
        contentMode,
        includeCharacterAttachments,
      }),
      shot,
    };
  }

  const camera = cameraAtTime(shot, specification.timeSeconds);
  const overrides = interpolateObjectOverrides(
    shot.cameraKeyframes,
    specification.timeSeconds,
    shot.objectOverrides,
    project.scene.objects,
  );
  const timedShot: Shot = {
    ...shot,
    camera,
    objectOverrides: overrides,
  };
  return {
    project: resolveProjectForShot(project, timedShot, {
      contentMode,
      includeCharacterAttachments,
    }),
    shot: timedShot,
  };
}

async function ensureDepthRange(
  project: LocationProject,
  shot: Shot,
  provided?: DepthRangeMeters,
): Promise<DepthRangeMeters> {
  if (provided) return provided;
  return resolveShotDepthRangeForExport(project, shot);
}

/**
 * Render one still artifact via existing engine renderers.
 */
export async function renderStillArtifact(
  params: RenderStillArtifactParams,
): Promise<RenderedStillArtifact> {
  const { project, shot, specification, signal } = params;
  throwIfCancelled(signal);

  const width = specification.width;
  const height = specification.height;

  switch (specification.kind) {
    case 'clay-viewport': {
      const frame = await renderShotFrame(project, shot, {
        peopleVariant: specification.peopleVariant,
      });
      throwIfCancelled(signal);
      return {
        blob: dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'projected-viewport': {
      const frame = await renderShotProjectedFrame(project, shot, {
        peopleVariant: specification.peopleVariant,
      });
      throwIfCancelled(signal);
      return {
        blob: dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'depth-viewport': {
      const depthRange = await ensureDepthRange(project, shot, params.depthRange);
      throwIfCancelled(signal);
      const frame = await renderShotDepthFrame(project, shot, {
        peopleVariant: specification.peopleVariant,
        depthRange,
      });
      throwIfCancelled(signal);
      return {
        blob: dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'character-still': {
      const appearance = specification.appearance === 'depth' ? 'clay' : specification.appearance;
      const frame = await renderShotCharacterFrame(project, shot, {
        appearance,
        includeAttachedProps: specification.includeCharacterAttachments !== false,
      });
      throwIfCancelled(signal);
      return {
        blob: frame.blob,
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'clay-reference-frame': {
      const resolved = resolveProjectForStillSpecification(project, shot, specification);
      const frame = await renderViewportClay(
        resolved.project,
        resolved.shot.camera,
        width,
        height,
      );
      throwIfCancelled(signal);
      return {
        blob: dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'projected-reference-frame': {
      const resolved = resolveProjectForStillSpecification(project, shot, specification);
      const frame = await renderViewportProjected(
        resolved.project,
        resolved.shot.camera,
        width,
        height,
      );
      throwIfCancelled(signal);
      return {
        blob: dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'depth-reference-frame': {
      const depthRange = await ensureDepthRange(project, shot, params.depthRange);
      throwIfCancelled(signal);
      const depthSettings = resolveShotDepthSettings(shot);
      const rangeCameras = [
        shot.camera,
        ...shot.cameraKeyframes.map((keyframe) => keyframe.camera),
      ];
      const resolved = resolveProjectForStillSpecification(project, shot, specification);
      const frame = await renderViewportDepth(
        resolved.project,
        resolved.shot.camera,
        width,
        height,
        {
          depth: {
            ...depthSettings,
            rangeMode: 'manual',
            nearMeters: depthRange.nearMeters,
            farMeters: depthRange.farMeters,
          },
          rangeCameras,
        },
      );
      throwIfCancelled(signal);
      return {
        blob: dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    default: {
      const exhaustive: never = specification.kind;
      throw new Error(`Unsupported still artifact kind: ${String(exhaustive)}`);
    }
  }
}
