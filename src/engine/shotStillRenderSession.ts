/**
 * Shot-scoped render session — reuse WebGL renderers across the prepared-still
 * DAG for one shot before disposing.
 */

import type * as THREE from 'three';
import type { LocationProject, Shot } from '../domain/types';
import {
  renderShotCharacterFrame,
  renderShotDepthFrame,
  renderViewportClayOnRenderer,
  renderViewportProjected,
  createViewportRenderer,
  disposeViewportRenderer,
} from './renderers';
import {
  renderViewportDepth,
  resolveShotDepthSettings,
  type DepthRangeMeters,
} from './depthRender';
import { resolveProjectForShot } from './shotSceneState';
import { resolveProjectForStillSpecification, type RenderedStillArtifact } from './stillArtifactRender';
import type { StillArtifactSpecification } from './stillArtifactTypes';

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Still materialization was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeType = header.match(/^data:([^;,]+)/i)?.[1] ?? 'image/png';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function clayLayerKey(spec: StillArtifactSpecification): string {
  const peopleVariant = 'peopleVariant' in spec ? spec.peopleVariant : 'with_people';
  return `clay:${spec.width}x${spec.height}:${peopleVariant}`;
}

export class ShotStillRenderSession {
  private readonly clayRenderers = new Map<string, THREE.WebGLRenderer>();

  async renderSpecification(
    project: LocationProject,
    shot: Shot,
    specification: StillArtifactSpecification,
    options: {
      signal?: AbortSignal;
      depthRange?: DepthRangeMeters;
    } = {},
  ): Promise<RenderedStillArtifact> {
    const { signal, depthRange } = options;
    throwIfCancelled(signal);

    switch (specification.kind) {
    case 'clay-viewport': {
      const resolved = resolveProjectForShot(project, shot, {
        contentMode: specification.peopleVariant === 'clean_plate' ? 'clean_plate' : 'full_scene',
      });
      const key = clayLayerKey(specification);
      let renderer = this.clayRenderers.get(key);
      if (!renderer) {
        renderer = createViewportRenderer(specification.width, specification.height);
        this.clayRenderers.set(key, renderer);
      }
      const frame = await renderViewportClayOnRenderer(
        renderer,
        resolved,
        shot.camera,
        specification.width,
        specification.height,
        { output: 'blob', includePixelStats: false },
      );
      throwIfCancelled(signal);
      return {
        blob: frame.blob ?? dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'projected-viewport': {
      const resolved = resolveProjectForShot(project, shot, {
        contentMode: specification.peopleVariant === 'clean_plate' ? 'clean_plate' : 'full_scene',
      });
      const frame = await renderViewportProjected(
        resolved,
        shot.camera,
        specification.width,
        specification.height,
        { output: 'blob' },
      );
      throwIfCancelled(signal);
      return {
        blob: frame.blob ?? dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'depth-viewport': {
      const frame = await renderShotDepthFrame(project, shot, {
        peopleVariant: specification.peopleVariant,
        depthRange,
        output: 'blob',
      });
      throwIfCancelled(signal);
      return {
        blob: frame.blob ?? dataUrlToBlob(frame.dataUrl),
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
      const key = `${clayLayerKey(specification)}:ref`;
      let renderer = this.clayRenderers.get(key);
      if (!renderer) {
        renderer = createViewportRenderer(specification.width, specification.height);
        this.clayRenderers.set(key, renderer);
      }
      const frame = await renderViewportClayOnRenderer(
        renderer,
        resolved.project,
        resolved.shot.camera,
        specification.width,
        specification.height,
        { output: 'blob', includePixelStats: false },
      );
      throwIfCancelled(signal);
      return {
        blob: frame.blob ?? dataUrlToBlob(frame.dataUrl),
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
        specification.width,
        specification.height,
        { output: 'blob' },
      );
      throwIfCancelled(signal);
      return {
        blob: frame.blob ?? dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    case 'depth-reference-frame': {
      const depthSettings = resolveShotDepthSettings(shot);
      const rangeCameras = [
        shot.camera,
        ...shot.cameraKeyframes.map((keyframe) => keyframe.camera),
      ];
      const resolved = resolveProjectForStillSpecification(project, shot, specification);
      const frame = await renderViewportDepth(
        resolved.project,
        resolved.shot.camera,
        specification.width,
        specification.height,
        {
          depth: {
            ...depthSettings,
            rangeMode: 'manual',
            nearMeters: depthRange?.nearMeters ?? depthSettings.nearMeters,
            farMeters: depthRange?.farMeters ?? depthSettings.farMeters,
          },
          rangeCameras,
          output: 'blob',
        },
      );
      throwIfCancelled(signal);
      return {
        blob: frame.blob ?? dataUrlToBlob(frame.dataUrl),
        width: frame.width,
        height: frame.height,
        mimeType: 'image/png',
      };
    }
    }
  }

  dispose(): void {
    for (const renderer of this.clayRenderers.values()) disposeViewportRenderer(renderer);
    this.clayRenderers.clear();
  }
}

export function inspectShotStillRenderSessionForTests(session: ShotStillRenderSession): {
  clayRendererCount: number;
} {
  return {
    clayRendererCount: (session as unknown as { clayRenderers: Map<string, unknown> }).clayRenderers.size,
  };
}
