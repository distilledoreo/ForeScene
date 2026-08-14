import { readFile } from 'node:fs/promises';
import { BENCHMARK_SPEC_VERSION, type BenchmarkSpecV1 } from './types';
import { harnessFailure } from './failures';
import { adaptFrozenPanoramaTriadSpec, isFrozenPanoramaTriadSpec } from './panoramaTriadAdapter';

export function parseBenchmarkSpec(value: unknown): BenchmarkSpecV1 {
  if (!value || typeof value !== 'object') {
    throw new Error(harnessFailure('Benchmark spec must be an object.').message);
  }
  const record = value as Partial<BenchmarkSpecV1>;
  if (record.version !== BENCHMARK_SPEC_VERSION) {
    throw new Error(`Unsupported benchmark spec version: ${String(record.version)}`);
  }
  if (!record.id || !record.name || !Array.isArray(record.shots) || record.shots.length === 0) {
    throw new Error('Benchmark spec requires id, name, and at least one shot.');
  }
  for (const shot of record.shots) {
    if (!shot.id || !shot.shotNumber || !shot.intent) {
      throw new Error('Each shot requires id, shotNumber, and intent.');
    }
    if ('cameraMustBe' in (shot as object) || 'cameraPosition' in (shot as object)) {
      throw new Error('Benchmark specs must not hard-code camera coordinates.');
    }
  }
  return record as BenchmarkSpecV1;
}

export async function loadBenchmarkSpec(filePath: string): Promise<BenchmarkSpecV1> {
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  if (isFrozenPanoramaTriadSpec(raw)) return adaptFrozenPanoramaTriadSpec(raw, filePath);
  return parseBenchmarkSpec(raw);
}
