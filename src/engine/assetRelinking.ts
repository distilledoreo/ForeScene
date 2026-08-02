import type { ProjectAsset } from '../domain/types';
import { sha256Digest } from './binaryIntegrity';

export interface AssetCandidateMatch {
  file: File;
  confidence: 'hash' | 'name-and-size' | 'name' | 'weak';
  score: number;
}

function withoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/\s*\((?:copy|\d+)\)$/i, '');
}

export function normalizeAssetFileName(name: string): string {
  return withoutExtension(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function matchMissingAssetCandidates(
  asset: ProjectAsset,
  files: readonly File[],
): Promise<AssetCandidateMatch[]> {
  const targetName = normalizeAssetFileName(asset.originalFileName ?? asset.name);
  const targetSize = asset.byteSize;
  const matches: AssetCandidateMatch[] = [];
  for (const file of files) {
    const nameMatch = normalizeAssetFileName(file.name) === targetName;
    const sizeMatch = targetSize !== undefined && file.size === targetSize;
    let confidence: AssetCandidateMatch['confidence'] = nameMatch && sizeMatch ? 'name-and-size' : nameMatch ? 'name' : 'weak';
    let score = nameMatch ? 0.7 : 0.2;
    if (sizeMatch) score += 0.2;
    if (asset.contentHash) {
      const hash = await sha256Digest(await file.arrayBuffer());
      if (hash === asset.contentHash) {
        confidence = 'hash';
        score = 1;
      }
    }
    if (score >= 0.4) matches.push({ file, confidence, score });
  }
  return matches.sort((left, right) => right.score - left.score);
}
