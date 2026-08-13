import { Writable } from 'node:stream';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  assembleZipBlob,
  describeZipAssemblyMode,
  resolvePackageConcurrency,
  ZIP_ASSEMBLY_MODE_IN_MEMORY,
  ZIP_ASSEMBLY_MODE_STREAM,
} from '../src/engine/packageExportCore';
import {
  ARTIFACT_PAGE_MATERIALIZATION_SLICE,
  ARTIFACT_TRANSFER_CHUNK_BYTES,
  ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES,
  ARTIFACT_TRANSFER_MODE_CHUNKED,
  ARTIFACT_TRANSFER_MODE_FALLBACK,
  ArtifactTransferError,
  createSequentialFileSink,
  encodeArtifactBytesForBindingFallback,
  encodeUint8ArrayChunkToBase64,
  iterateBlobSlices,
  resolveArtifactTransferPlan,
  toCliArtifactTransfer,
} from '../scripts/agent/artifactIo';
import { resolveBatchConcurrency } from '../src/engine/agent/batchControl';

describe('package and artifact transfer assembly', () => {
  it('documents a streaming zip path or the bounded in-memory fallback', () => {
    const mode = describeZipAssemblyMode();
    expect([ZIP_ASSEMBLY_MODE_STREAM, ZIP_ASSEMBLY_MODE_IN_MEMORY]).toContain(mode);
  });

  it('assembles a readable zip without requiring Array.from of the whole archive', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'fore-scene');
    const blob = await assembleZipBlob(zip);
    const loaded = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(await loaded.file('hello.txt')?.async('string')).toBe('fore-scene');
  });

  it('resolves bounded configurable package and batch concurrency', () => {
    expect(resolvePackageConcurrency(99)).toBe(8);
    expect(resolvePackageConcurrency(0)).toBe(2);
    expect(resolvePackageConcurrency(3)).toBe(3);
    expect(resolveBatchConcurrency(99)).toBe(4);
    expect(resolveBatchConcurrency(2)).toBe(2);
  });

  it('encodes artifact chunks without Array.from of the full payload', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255]);
    const encoded = encodeUint8ArrayChunkToBase64(bytes);
    expect(Buffer.from(encoded, 'base64')).toEqual(Buffer.from(bytes));
    expect(ARTIFACT_TRANSFER_CHUNK_BYTES).toBeGreaterThan(1024);
  });

  it('keeps the whole-file number-array copy as an explicit bounded fallback', () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const fallback = encodeArtifactBytesForBindingFallback(bytes);
    expect(fallback).toEqual([9, 8, 7, 6, 5]);
    expect(Buffer.from(fallback)).toEqual(Buffer.from(bytes));
    expect(resolveArtifactTransferPlan({ bindingAvailable: true }).transferMode).toBe(ARTIFACT_TRANSFER_MODE_CHUNKED);
    expect(resolveArtifactTransferPlan({
      bindingAvailable: false,
      allowFallback: true,
      byteLength: 16,
    }).transferMode).toBe(ARTIFACT_TRANSFER_MODE_FALLBACK);
    expect(() => resolveArtifactTransferPlan({ bindingAvailable: false })).toThrow(ArtifactTransferError);
    expect(() => resolveArtifactTransferPlan({
      bindingAvailable: false,
      allowFallback: true,
      byteLength: ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES + 1,
    })).toThrow(/limited to/);
    expect(() => encodeArtifactBytesForBindingFallback(
      new Uint8Array(ARTIFACT_TRANSFER_FALLBACK_MAX_BYTES + 1),
    )).toThrow(ArtifactTransferError);
  });

  it('chunks a Blob via slice windows instead of materializing a full Uint8Array', async () => {
    const payload = new Uint8Array(600);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 256;
    const blob = new Blob([payload], { type: 'application/octet-stream' });
    const arrayBufferSpy = vi.spyOn(blob, 'arrayBuffer');
    const chunks: Uint8Array[] = [];
    const result = await iterateBlobSlices(blob, 256, (chunk) => {
      chunks.push(chunk);
    });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(result.byteLength).toBe(600);
    expect(result.chunkCount).toBe(3);
    expect(chunks.map((chunk) => chunk.length)).toEqual([256, 256, 88]);
    const rebuilt = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      rebuilt.set(chunk, offset);
      offset += chunk.length;
    }
    expect(rebuilt).toEqual(payload);
  });

  it('writes artifact chunks incrementally and closes the sink on success and failure', async () => {
    const writes: Buffer[] = [];
    let ended = false;
    let destroyed = false;
    const sink = createSequentialFileSink('memory://artifact.bin', {
      createStream: () => new Writable({
        write(chunk, _encoding, callback) {
          writes.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          ended = true;
          callback();
        },
        destroy(_error, callback) {
          destroyed = true;
          callback();
        },
      }) as import('node:fs').WriteStream,
    });

    await sink.write(Buffer.from('abcd'));
    expect(writes.map((chunk) => chunk.toString())).toEqual(['abcd']);
    await sink.write(Buffer.from('ef'));
    expect(writes.map((chunk) => chunk.toString())).toEqual(['abcd', 'ef']);
    expect(sink.closed).toBe(false);

    const closed = await sink.close();
    expect(closed).toEqual({ byteLength: 6, chunkCount: 2 });
    expect(sink.closed).toBe(true);
    expect(ended).toBe(true);

    const failing = createSequentialFileSink('memory://artifact-fail.bin', {
      createStream: () => new Writable({
        write(chunk, _encoding, callback) {
          writes.push(Buffer.from(chunk));
          callback();
        },
        destroy(_error, callback) {
          destroyed = true;
          callback();
        },
      }) as import('node:fs').WriteStream,
    });
    await failing.write(Buffer.from('partial'));
    await failing.abort();
    expect(failing.closed).toBe(true);
    expect(failing.failed).toBe(true);
    expect(destroyed).toBe(true);
    await expect(failing.write(Buffer.from('late'))).rejects.toThrow(/closed/);
  });

  it('unlinks a partial file when the sink is aborted', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'forescene-artifact-sink-'));
    const filePath = path.join(directory, 'partial.bin');
    const sink = createSequentialFileSink(filePath);
    await sink.write(Buffer.from('partial-bytes'));
    expect((await stat(filePath)).size).toBeGreaterThan(0);
    await sink.abort();
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for drain before accepting the next artifact chunk', async () => {
    let drain!: () => void;
    const blocked = new Promise<void>((resolve) => {
      drain = resolve;
    });
    let waitingForDrain = false;
    const sink = createSequentialFileSink('memory://backpressure.bin', {
      createStream: () => {
        const stream = new Writable({
          highWaterMark: 4,
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        const originalWrite = stream.write.bind(stream);
        stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
          const result = originalWrite(chunk as never, encoding as never, callback as never);
          waitingForDrain = true;
          void blocked.then(() => stream.emit('drain'));
          return false;
        }) as typeof stream.write;
        return stream as import('node:fs').WriteStream;
      },
    });

    let resolved = false;
    const writePromise = sink.write(Buffer.from('12345')).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => {
      expect(waitingForDrain).toBe(true);
    });
    expect(resolved).toBe(false);
    drain();
    await writePromise;
    expect(resolved).toBe(true);
    await sink.close();
  });

  it('describes CLI transfer telemetry without calling browser-blob a streamed file', () => {
    const transfer = toCliArtifactTransfer({
      savedPath: '/tmp/package.zip',
      byteLength: 512,
      transferMode: ARTIFACT_TRANSFER_MODE_CHUNKED,
      pageMaterialization: ARTIFACT_PAGE_MATERIALIZATION_SLICE,
      chunkCount: 2,
    });
    expect(transfer).toEqual({
      transferMode: ARTIFACT_TRANSFER_MODE_CHUNKED,
      pageMaterialization: ARTIFACT_PAGE_MATERIALIZATION_SLICE,
      byteLength: 512,
      chunkCount: 2,
    });
    expect(transfer.transferMode).not.toBe('browser-blob');
  });
});
