/**
 * Persist Agent artifacts without depending on browser download events.
 *
 * Binary transfer uses chunked base64 bindings so the CLI never materializes
 * the entire payload as `Array.from(bytes)`. The page reads `Blob.slice()`
 * windows (256 KiB) instead of `blob.arrayBuffer()` on the whole file. Each
 * decoded chunk is written through a sequential file sink — the Node side
 * does not keep a second full `Buffer[]` copy. A whole-file number-array
 * copy is an explicit, size-bounded last resort (`allowFallback: true`) and
 * is never selected silently after a failed binding setup.
 *
 * Limitation: Playwright `page.evaluate` cannot return a Blob or stream one
 * out of the page. The registry already holds a Blob; `downloadArtifact`
 * returns that handle (`transferMode: "browser-blob"`) without a second
 * Uint8Array copy. That browser handle is not a streamed file. CLI transfer
 * therefore chunks inside the page and writes each slice through a binding.
 * Full-file `Uint8Array` materialization is only the explicit fallback path.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { WriteStream } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

export const ARTIFACT_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const ARTIFACT_TRANSFER_MODE_CHUNKED = 'chunked-base64';
export const ARTIFACT_TRANSFER_MODE_FALLBACK = 'uint8array-fallback';
export const ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_PAGE_MATERIALIZATION_SLICE = 'blob-slice';
export const ARTIFACT_PAGE_MATERIALIZATION_FULL = 'full-uint8array';

export type AgentArtifactTransferMode =
  | typeof ARTIFACT_TRANSFER_MODE_CHUNKED
  | typeof ARTIFACT_TRANSFER_MODE_FALLBACK;
export type AgentArtifactPageMaterialization =
  | typeof ARTIFACT_PAGE_MATERIALIZATION_SLICE
  | typeof ARTIFACT_PAGE_MATERIALIZATION_FULL;

export interface AgentArtifactTransferTelemetry {
  transferMode: AgentArtifactTransferMode;
  pageMaterialization: AgentArtifactPageMaterialization;
  byteLength: number;
  chunkCount: number;
}

export interface SavedAgentArtifact {
  savedPath: string;
  byteLength: number;
  fileName?: string;
  mimeType?: string;
  transferMode: AgentArtifactTransferMode;
  pageMaterialization: AgentArtifactPageMaterialization;
  chunkCount: number;
}

export interface SequentialFileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<{ byteLength: number; chunkCount: number }>;
  abort(): Promise<void>;
  readonly closed: boolean;
  readonly failed: boolean;
  readonly byteLength: number;
  readonly chunkCount: number;
}

export class ArtifactTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactTransferError';
  }
}

/**
 * Choose a transfer mode. Binding setup failure never silently selects the
 * whole-file copy — callers must opt in, and the fallback is size-bounded.
 */
export function resolveArtifactTransferPlan(input: {
  bindingAvailable: boolean;
  allowFallback?: boolean;
  byteLength?: number;
}): {
  transferMode: AgentArtifactTransferMode;
} {
  if (input.bindingAvailable) {
    return { transferMode: ARTIFACT_TRANSFER_MODE_CHUNKED };
  }
  if (!input.allowFallback) {
    throw new ArtifactTransferError(
      'Chunked artifact binding is unavailable. Refusing a silent whole-file copy. Pass allowFallback: true only for an explicit bounded fallback.',
    );
  }
  if (input.byteLength !== undefined && input.byteLength > ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES) {
    throw new ArtifactTransferError(
      `Whole-file artifact fallback is limited to ${ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES} bytes (got ${input.byteLength}).`,
    );
  }
  return { transferMode: ARTIFACT_TRANSFER_MODE_FALLBACK };
}

/**
 * Sequential disk sink. Each chunk is flushed (write callback + drain)
 * before the next is accepted, and `abort()` closes the stream then
 * removes any partial file.
 */
export function createSequentialFileSink(
  filePath: string,
  options: { createStream?: (path: string) => WriteStream } = {},
): SequentialFileSink {
  const createStream = options.createStream ?? createWriteStream;
  const stream = createStream(filePath);
  const opened = 'fd' in stream
    ? stream.fd != null
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
      })
    : Promise.resolve();
  let byteLength = 0;
  let chunkCount = 0;
  let closed = false;
  let failed = false;
  let writeQueue: Promise<void> = Promise.resolve();

  const writeNow = async (chunk: Uint8Array): Promise<void> => {
    if (closed || failed) {
      throw new ArtifactTransferError('Artifact file sink is closed.');
    }
    await opened;
    if (closed || failed) {
      throw new ArtifactTransferError('Artifact file sink is closed.');
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let writeReturned = false;
      let needsDrain = false;
      let callbackFired = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        if (error) {
          settled = true;
          reject(error);
          return;
        }
        if (writeReturned && callbackFired && !needsDrain) {
          settled = true;
          resolve();
        }
      };
      const onError = (error: Error) => finish(error);
      stream.once('error', onError);
      const ready = stream.write(buffer, (error) => {
        callbackFired = true;
        stream.off('error', onError);
        finish(error);
      });
      needsDrain = !ready;
      writeReturned = true;
      if (needsDrain) {
        void once(stream, 'drain').then(() => {
          needsDrain = false;
          finish();
        }, (error: Error) => finish(error));
      } else {
        finish();
      }
    });
    byteLength += buffer.length;
    chunkCount += 1;
  };

  return {
    write(chunk: Uint8Array): Promise<void> {
      const task = writeQueue.then(() => writeNow(chunk));
      writeQueue = task.then(() => undefined, () => undefined);
      return task;
    },
    async close(): Promise<{ byteLength: number; chunkCount: number }> {
      if (failed) throw new ArtifactTransferError('Artifact file sink failed.');
      if (closed) return { byteLength, chunkCount };
      await writeQueue;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { byteLength, chunkCount };
    },
    async abort(): Promise<void> {
      failed = true;
      closed = true;
      await writeQueue.catch(() => undefined);
      stream.destroy();
      await finished(stream).catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
    },
    get closed() { return closed; },
    get failed() { return failed; },
    get byteLength() { return byteLength; },
    get chunkCount() { return chunkCount; },
  };
}

export function toCliArtifactTransfer(saved: SavedAgentArtifact): AgentArtifactTransferTelemetry {
  return {
    transferMode: saved.transferMode,
    pageMaterialization: saved.pageMaterialization,
    byteLength: saved.byteLength,
    chunkCount: saved.chunkCount,
  };
}

export function encodeUint8ArrayChunkToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

/**
 * Read a Blob in bounded slices. Never calls `blob.arrayBuffer()` on the
 * whole file — each window is at most `chunkBytes`.
 */
export async function iterateBlobSlices(
  blob: Blob,
  chunkBytes: number,
  onSlice: (chunk: Uint8Array, offset: number) => void | Promise<void>,
): Promise<{ byteLength: number; chunkCount: number }> {
  const size = blob.size;
  const windowSize = Math.max(1, Math.floor(chunkBytes));
  let offset = 0;
  let chunkCount = 0;
  while (offset < size) {
    const end = Math.min(offset + windowSize, size);
    const slice = blob.slice(offset, end);
    const chunk = new Uint8Array(await slice.arrayBuffer());
    await onSlice(chunk, offset);
    chunkCount += 1;
    offset = end;
  }
  return { byteLength: size, chunkCount };
}

/**
 * Last-resort binding fallback. Callers must not use this when the chunked
 * Playwright binding is available — it materializes the whole file as a
 * number array so the page can return a JSON-safe payload.
 */
export function encodeArtifactBytesForBindingFallback(bytes: Uint8Array): number[] {
  if (bytes.length > ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES) {
    throw new ArtifactTransferError(
      `Whole-file artifact fallback is limited to ${ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES} bytes (got ${bytes.length}).`,
    );
  }
  const values = new Array<number>(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    values[index] = bytes[index]!;
  }
  return values;
}

export async function saveAgentArtifactToFile(
  page: Page,
  artifactId: string,
  outputPath: string,
  options: { allowFallback?: boolean } = {},
): Promise<SavedAgentArtifact> {
  const savedPath = path.resolve(outputPath);
  await mkdir(path.dirname(savedPath), { recursive: true });

  const bindingName = `__foresceneWriteArtifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const sink = createSequentialFileSink(savedPath);
  let bindingAvailable = true;

  try {
    try {
      await page.exposeFunction(bindingName, async (base64: string) => {
        await sink.write(Buffer.from(base64, 'base64'));
      });
    } catch {
      bindingAvailable = false;
      resolveArtifactTransferPlan({
        bindingAvailable: false,
        allowFallback: options.allowFallback,
      });
    }

    const payload = await page.evaluate(async (input) => {
      const api = window.foreScene;
      if (!api) throw new Error('window.foreScene is not available.');
      const result = await api.downloadArtifact({ artifactId: input.artifactId, download: false });
      if (!result.ok || !result.blob) {
        const detail = result.diagnostics?.map((item) => item.message).join('; ') || 'Artifact bytes were not available.';
        throw new Error(detail);
      }
      const blob = result.blob;
      const writer = (window as unknown as Record<string, ((chunk: string) => Promise<void>) | undefined>)[input.bindingName];
      if (typeof writer === 'function') {
        const chunkSize = input.chunkBytes;
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
          const slice = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
          const chunk = new Uint8Array(await slice.arrayBuffer());
          let binary = '';
          for (let index = 0; index < chunk.length; index += 1) {
            binary += String.fromCharCode(chunk[index]!);
          }
          await writer(btoa(binary));
        }
        return {
          transferMode: 'chunked-base64' as const,
          pageMaterialization: 'blob-slice' as const,
          fileName: result.artifact?.fileName,
          mimeType: result.artifact?.mimeType,
          byteLength: blob.size,
        };
      }
      if (!input.allowFallback) {
        throw new Error('Chunked artifact binding is unavailable. Refusing a silent whole-file copy.');
      }
      if (blob.size > input.maxFallbackBytes) {
        throw new Error(
          `Whole-file artifact fallback is limited to ${input.maxFallbackBytes} bytes (got ${blob.size}).`,
        );
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const fallback = new Array<number>(bytes.length);
      for (let index = 0; index < bytes.length; index += 1) {
        fallback[index] = bytes[index]!;
      }
      return {
        transferMode: 'uint8array-fallback' as const,
        pageMaterialization: 'full-uint8array' as const,
        bytes: fallback,
        fileName: result.artifact?.fileName,
        mimeType: result.artifact?.mimeType,
        byteLength: bytes.length,
      };
    }, {
      artifactId,
      bindingName,
      chunkBytes: ARTIFACT_TRANSFER_CHUNK_BYTES,
      allowFallback: options.allowFallback === true,
      maxFallbackBytes: ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES,
    });

    if (!bindingAvailable && payload.transferMode === ARTIFACT_TRANSFER_MODE_CHUNKED) {
      throw new ArtifactTransferError('Chunked artifact binding was not installed; refusing an unverified transfer.');
    }

    if (payload.transferMode === ARTIFACT_TRANSFER_MODE_FALLBACK) {
      await sink.write(Buffer.from(payload.bytes ?? []));
    }

    const closed = await sink.close();
    if (closed.byteLength !== payload.byteLength) {
      await unlink(savedPath).catch(() => undefined);
      throw new ArtifactTransferError(
        `Transferred ${closed.byteLength} bytes but the page reported ${payload.byteLength}.`,
      );
    }

    return {
      savedPath,
      byteLength: payload.byteLength,
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      transferMode: payload.transferMode,
      pageMaterialization: payload.pageMaterialization,
      chunkCount: closed.chunkCount,
    };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

export async function refreshAgentSessionRevision(page: Page): Promise<{ revisionId?: string; fingerprint?: string }> {
  return page.evaluate(async () => {
    const api = window.foreScene;
    if (!api) throw new Error('window.foreScene is not available.');
    const refreshed = await api.refreshRevision();
    return { revisionId: refreshed.revisionId, fingerprint: refreshed.fingerprint };
  });
}
