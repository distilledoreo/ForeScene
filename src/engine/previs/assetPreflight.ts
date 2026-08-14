/**
 * Filesystem preflight for production assets. Runs before any project mutation.
 * Semantic role is not an implementation type: a subject can stay imported_model.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  PREVIS_DIAGNOSTIC_CODES,
  previsError,
  type PrevisDiagnostic,
} from './manifestDiagnostics';
import type { PrevisAssetDefinition, PrevisProductionManifestV1 } from './manifest';

export interface PreflightedAsset {
  id: string;
  type: PrevisAssetDefinition['type'];
  semanticRole?: PrevisAssetDefinition['semanticRole'];
  importMode?: PrevisAssetDefinition['importMode'];
  expectedObjectType: 'imported_model' | 'imported_character' | 'pano' | 'resource' | 'primitive_proxy';
  sourcePath?: string;
  sourceSha256?: string;
  rigPackagePath?: string;
  rigPackageSha256?: string;
  required: boolean;
}

export interface ProductionAssetPreflightResult {
  ok: boolean;
  assets: PreflightedAsset[];
  errors: PrevisDiagnostic[];
}

export function expectedObjectTypeForAsset(asset: PrevisAssetDefinition): PreflightedAsset['expectedObjectType'] {
  if (asset.type === 'imported_character' || asset.type === 'saved_rig' || asset.importMode === 'character' || asset.importMode === 'saved_rig') {
    return 'imported_character';
  }
  if (asset.type === 'panorama') return 'pano';
  if (asset.type === 'image' || asset.type === 'video') return 'resource';
  if (asset.type === 'primitive_proxy') return 'primitive_proxy';
  return 'imported_model';
}

async function hashFile(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function requireFile(filePath: string, pathLabel: string, entityId: string): Promise<PrevisDiagnostic | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return previsError(
        PREVIS_DIAGNOSTIC_CODES.missingAssetSource,
        `Asset source is not a file: ${filePath}`,
        { path: pathLabel, entityId },
      );
    }
  } catch {
    return previsError(
      PREVIS_DIAGNOSTIC_CODES.missingAssetSource,
      `Asset source was not found: ${filePath}`,
      { path: pathLabel, entityId },
    );
  }
  return undefined;
}

export function resolveManifestAssetPath(manifestPath: string, source: string): string {
  return path.isAbsolute(source) ? source : path.resolve(path.dirname(manifestPath), source);
}

export async function preflightProductionAssets(
  manifest: PrevisProductionManifestV1,
  manifestPath: string,
): Promise<ProductionAssetPreflightResult> {
  const errors: PrevisDiagnostic[] = [];
  const assets: PreflightedAsset[] = [];

  for (const [index, asset] of (manifest.assets ?? []).entries()) {
    const required = asset.required !== false;
    const expectedObjectType = expectedObjectTypeForAsset(asset);
    const pathBase = `assets[${index}]`;
    const preflighted: PreflightedAsset = {
      id: asset.id,
      type: asset.type,
      semanticRole: asset.semanticRole,
      importMode: asset.importMode,
      expectedObjectType,
      required,
    };

    if (asset.semanticRole === 'subject' && asset.type === 'imported_model') {
      preflighted.expectedObjectType = 'imported_model';
    }

    if (asset.source) {
      const sourcePath = resolveManifestAssetPath(manifestPath, asset.source);
      const missing = await requireFile(sourcePath, `${pathBase}.source`, asset.id);
      if (missing) {
        if (required) errors.push(missing);
      } else {
        preflighted.sourcePath = sourcePath;
        preflighted.sourceSha256 = await hashFile(sourcePath);
      }
    } else if (required && asset.type !== 'primitive_proxy' && !(asset.type === 'saved_rig' && asset.rigPackage)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.missingAssetSource,
        `Required asset "${asset.id}" has no source.`,
        { path: `${pathBase}.source`, entityId: asset.id },
      ));
    }

    const needsRig = expectedObjectType === 'imported_character'
      && (asset.type === 'saved_rig' || asset.importMode === 'saved_rig' || asset.rigMode === 'saved-rig');
    if (needsRig) {
      if (!asset.rigPackage) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.missingSavedRigPackage,
          `Character asset "${asset.id}" is missing a rig package.`,
          { path: `${pathBase}.rigPackage`, entityId: asset.id },
        ));
      } else {
        const rigPath = resolveManifestAssetPath(manifestPath, asset.rigPackage);
        const missing = await requireFile(rigPath, `${pathBase}.rigPackage`, asset.id);
        if (missing) errors.push(missing);
        else {
          preflighted.rigPackagePath = rigPath;
          preflighted.rigPackageSha256 = await hashFile(rigPath);
        }
      }
    } else if (asset.rigPackage && expectedObjectType === 'imported_model') {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unexpectedCharacterRig,
        `Ordinary imported model "${asset.id}" must not declare a rig package.`,
        { path: `${pathBase}.rigPackage`, entityId: asset.id },
      ));
    }

    assets.push(preflighted);
  }

  return { ok: errors.length === 0, assets, errors };
}
