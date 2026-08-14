/**
 * Deterministic benchmark-spec → production-manifest compiler.
 * The candidate never authors or translates this schema.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkSpecV1 } from './types';
import type { PrevisProductionManifestV1 } from '../../src/engine/previs/manifest';
import { parsePrevisProductionManifest } from '../../src/engine/previs/manifestValidation';
import { preflightProductionAssets, type ProductionAssetPreflightResult } from '../../src/engine/previs/assetPreflight';

export function resolveBenchmarkAssetPath(specPath: string, assetPath: string): string {
  return path.isAbsolute(assetPath)
    ? path.normalize(assetPath)
    : path.resolve(path.dirname(specPath), assetPath);
}

export function compileBenchmarkProductionManifest(
  spec: BenchmarkSpecV1,
  specPath: string,
): PrevisProductionManifestV1 {
  if (spec.productionManifest) return structuredClone(spec.productionManifest);
  const assets = (spec.assets ?? []).map((asset) => {
    const source = resolveBenchmarkAssetPath(specPath, asset.path);
    if (asset.kind === 'panorama') {
      return {
        id: asset.id,
        type: 'panorama' as const,
        source,
        semanticRole: 'prop' as const,
        required: true,
      };
    }
    if (asset.kind === 'fsrig') {
      return {
        id: asset.id,
        type: 'saved_rig' as const,
        importMode: 'saved_rig' as const,
        semanticRole: 'character' as const,
        required: true,
        rigPackage: source,
      };
    }
    const binding = spec.semanticSubjectBindings?.find((item) => item.semanticId === asset.id);
    const role = binding?.stagingRole === 'character' ? 'character' as const : 'subject' as const;
    return {
      id: asset.id,
      type: 'imported_model' as const,
      source,
      importMode: 'ordinary_model' as const,
      semanticRole: role === 'character' ? 'subject' as const : role,
      required: true,
    };
  });

  const locationId = 'stage';
  const subjectIds = spec.semanticSubjectBindings?.map((item) => item.semanticId)
    ?? spec.shots.flatMap((shot) => shot.requiredSubjects);
  const uniqueSubjects = [...new Set(subjectIds)];

  return {
    version: 2,
    project: {
      name: spec.name,
      description: spec.description,
      aspectRatio: '16:9',
    },
    locations: [{
      id: locationId,
      name: 'Neutral stage',
      template: 'empty_stage',
    }],
    cast: uniqueSubjects
      .filter((id) => !assets.some((asset) => asset.id === id))
      .map((id) => ({
        id,
        name: spec.semanticSubjectBindings?.find((item) => item.semanticId === id)?.name ?? id,
        type: 'human_dummy' as const,
      })),
    ...(assets.length > 0 ? { assets } : {}),
    shots: spec.shots.map((shot) => ({
      id: shot.id,
      shotNumber: shot.shotNumber,
      name: shot.name,
      description: shot.description,
      locationId,
      subjects: shot.requiredSubjects,
      camera: {
        template: 'medium' as const,
        subjects: shot.requiredSubjects,
      },
    })),
  };
}

export async function compileAndPreflightBenchmarkInput(input: {
  spec: BenchmarkSpecV1;
  specPath: string;
  outputManifestPath: string;
}): Promise<{
  manifest: PrevisProductionManifestV1;
  parsedOk: boolean;
  preflight: ProductionAssetPreflightResult;
  outputManifestPath: string;
}> {
  const compiled = compileBenchmarkProductionManifest(input.spec, input.specPath);
  const parsed = parsePrevisProductionManifest(compiled);
  const manifest = parsed.manifest ?? compiled;
  await mkdir(path.dirname(input.outputManifestPath), { recursive: true });
  await writeFile(input.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (!parsed.manifest || parsed.errors.length > 0) {
    return {
      manifest: compiled,
      parsedOk: false,
      outputManifestPath: input.outputManifestPath,
      preflight: {
        ok: false,
        assets: [],
        errors: parsed.errors,
      },
    };
  }
  const preflight = await preflightProductionAssets(parsed.manifest, input.outputManifestPath);
  return {
    manifest: parsed.manifest,
    parsedOk: true,
    preflight,
    outputManifestPath: input.outputManifestPath,
  };
}
