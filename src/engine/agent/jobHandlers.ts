/**
 * Production job item handlers — each executes real work and may register artifacts.
 */

import type { AgentJobType, AgentRenderShotFrameInput } from './protocol';
import { getAgentArtifactBlob, registerAgentArtifact } from './artifactRegistry';
import { getAgentRenderShotFrameImpl } from './renderCallbackRegistry';
import { agentError } from './diagnostics';
import { buildContactSheetSpec } from '../previs/contactSheet';

export interface JobHandlerContext {
  jobId: string;
  revisionIdAtStart?: string;
  /** The owning job's signal; handlers must stop between expensive units. */
  signal: AbortSignal;
  registerArtifact: (artifactId: string) => void;
}

export type JobHandler = (
  item: unknown,
  index: number,
  ctx: JobHandlerContext,
) => Promise<void>;

const APPEARANCE_PASSES = new Set(['clay', 'projected', 'depth']);

function throwIfJobCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Job item cancelled.');
  error.name = 'AbortError';
  throw error;
}

function parseRenderJob(item: unknown): AgentRenderShotFrameInput {
  if (!item || typeof item !== 'object') {
    throw new Error('Render job item must be an object with shotId.');
  }
  const record = item as Record<string, unknown>;
  if (typeof record.shotId !== 'string') {
    throw new Error('Render job item requires shotId.');
  }
  return {
    shotId: record.shotId,
    ...(typeof record.timeSeconds === 'number' ? { timeSeconds: record.timeSeconds } : {}),
    ...(typeof record.appearance === 'string' && APPEARANCE_PASSES.has(record.appearance)
      ? { appearance: record.appearance as AgentRenderShotFrameInput['appearance'] }
      : {}),
    ...(typeof record.peopleVariant === 'string'
      ? { peopleVariant: record.peopleVariant as AgentRenderShotFrameInput['peopleVariant'] }
      : {}),
    ...(typeof record.content === 'string'
      ? { content: record.content as AgentRenderShotFrameInput['content'] }
      : {}),
  };
}

async function runShotRenderItem(item: unknown, _index: number, ctx: JobHandlerContext): Promise<void> {
  throwIfJobCancelled(ctx.signal);
  const input = parseRenderJob(item);
  const result = await getAgentRenderShotFrameImpl()(input);
  throwIfJobCancelled(ctx.signal);
  if (!result.ok || !result.artifact) {
    throw new Error(result.diagnostics[0]?.message ?? 'Shot render failed.');
  }
  if (result.artifact.kind === 'inline' && result.artifact.dataUrl) {
    const blob = await dataUrlToBlob(result.artifact.dataUrl);
    const handle = registerAgentArtifact({
      blob,
      mimeType: result.artifact.mimeType,
      fileName: `shot_${input.shotId}.png`,
      revisionId: ctx.revisionIdAtStart,
      jobId: ctx.jobId,
      shotId: input.shotId,
    });
    ctx.registerArtifact(handle.artifactId);
  }
}

async function runPassMatrixItem(item: unknown, _index: number, ctx: JobHandlerContext): Promise<void> {
  throwIfJobCancelled(ctx.signal);
  if (!item || typeof item !== 'object') {
    throw new Error('Pass matrix item must be { shotId, pass }.');
  }
  const record = item as { shotId?: string; pass?: string };
  if (!record.shotId || !record.pass) {
    throw new Error('Pass matrix item requires shotId and pass.');
  }
  const appearance = record.pass === 'projected' || record.pass === 'depth' ? record.pass : 'clay';
  await runShotRenderItem({ shotId: record.shotId, appearance }, _index, ctx);
}

async function runContactSheetItem(item: unknown, _index: number, ctx: JobHandlerContext): Promise<void> {
  throwIfJobCancelled(ctx.signal);
  const artifactIds = Array.isArray(item) ? item : [item];
  const images: Array<{ id: string; blob: Blob }> = [];
  for (const artifactId of artifactIds) {
    throwIfJobCancelled(ctx.signal);
    if (typeof artifactId !== 'string') continue;
    const blob = getAgentArtifactBlob(artifactId);
    if (!blob) {
      throw new Error(`Artifact ${artifactId} is not available for contact sheet composition.`);
    }
    images.push({ id: artifactId, blob });
  }
  if (images.length === 0) {
    throw new Error('Contact sheet job requires at least one artifact id.');
  }

  const spec = buildContactSheetSpec({
    title: 'Contact sheet',
    shots: images.map((entry, idx) => ({
      shotNumber: String(idx + 1).padStart(3, '0'),
      name: entry.id,
      framePath: entry.id,
      status: 'rendered',
      warningCount: 0,
      fromCanonicalRenderer: true,
    })),
  });

  const blob = await composeContactSheetPng(spec, images, ctx.signal);
  throwIfJobCancelled(ctx.signal);
  const handle = registerAgentArtifact({
    blob,
    mimeType: 'image/png',
    fileName: 'contact-sheet.png',
    revisionId: ctx.revisionIdAtStart,
    jobId: ctx.jobId,
  });
  ctx.registerArtifact(handle.artifactId);
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function composeContactSheetPng(
  spec: ReturnType<typeof buildContactSheetSpec>,
  images: Array<{ id: string; blob: Blob }>,
  signal?: AbortSignal,
): Promise<Blob> {
  const columns = spec.columns;
  const rows = Math.ceil(images.length / columns);
  const cellW = spec.cellWidth;
  const cellH = spec.cellHeight;
  const canvas = document.createElement('canvas');
  canvas.width = columns * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create contact sheet canvas.');

  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < images.length; i += 1) {
    if (signal?.aborted) {
      const error = new Error('Job item cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * cellW;
    const y = row * cellH;
    const url = URL.createObjectURL(images[i]!.blob);
    try {
      const image = await loadImage(url);
      ctx.drawImage(image, x, y, cellW, cellH);
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px sans-serif';
      ctx.fillText(images[i]!.id, x + 8, y + 20);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((next) => {
      if (!next) reject(new Error('Contact sheet PNG encoding failed.'));
      else resolve(next);
    }, 'image/png');
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode contact sheet image.'));
    image.src = url;
  });
}

export const AGENT_JOB_HANDLERS: Partial<Record<AgentJobType, JobHandler>> = {
  'render-shot-batch': runShotRenderItem,
  'render-pass-matrix': runPassMatrixItem,
  'create-contact-sheets': runContactSheetItem,
  'frame-subjects-batch': async () => {
    throw new Error('frame-subjects-batch must be executed via frameSubjectsBatch(), not the generic job queue.');
  },
  'inspect-shots-diagnostics': async () => {
    throw new Error('inspect-shots-diagnostics must be executed via inspectShotsDiagnostics().');
  },
  custom: async (item) => {
    throw new Error(
      agentError('job_handler_missing', `No handler for custom job item: ${String(item)}`).message,
    );
  },
};

export function expandJobItems(input: {
  type: AgentJobType;
  jobs?: unknown[];
  shotIds?: string[];
  passes?: string[];
}): unknown[] {
  if (input.jobs && input.jobs.length > 0) return input.jobs;
  if (input.type === 'render-pass-matrix' && input.shotIds && input.passes) {
    const items: Array<{ shotId: string; pass: string }> = [];
    for (const shotId of input.shotIds) {
      for (const pass of input.passes) {
        items.push({ shotId, pass });
      }
    }
    return items;
  }
  if (input.shotIds) {
    return input.shotIds.map((shotId) => (
      typeof shotId === 'string' ? { shotId } : shotId
    ));
  }
  return [];
}
