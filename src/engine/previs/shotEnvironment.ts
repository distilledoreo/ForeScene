/**
 * Prepared-location and panorama routing contracts for production shots.
 *
 * The compiler uses this module before it emits a shot plan. Agent inspection
 * uses the same pure resolver after the plan has been applied, so a panorama
 * link is checked as a production postcondition rather than inferred from the
 * existence of a panorama asset somewhere in the project.
 */

import type {
  LocationProject,
  PanoReference,
  Shot,
  ShotEnvironmentContract,
} from '../../domain/types';
import { getProductionConfiguration } from './productionConfiguration';

export const SHOT_ENVIRONMENT_FAILURE_CODES = [
  'environment_contract_missing',
  'location_missing',
  'expected_panorama_missing',
  'panorama_not_in_location',
  'wrong_panorama_linked',
  'projection_coverage_low',
  'projected_material_missing',
  'untextured_region_excessive',
  'projection_fallback_excessive',
  'projection_occlusion_unavailable',
] as const;

export type ShotEnvironmentDiagnosticCode = (typeof SHOT_ENVIRONMENT_FAILURE_CODES)[number];

export interface ShotEnvironmentDiagnostic {
  code: ShotEnvironmentDiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  shotId?: string;
  locationId?: string;
  expectedPanoId?: string;
  actualPanoId?: string;
  coverage?: number;
  fallbackRatio?: number;
}

export interface ShotEnvironmentResolution {
  contractPresent: boolean;
  contract?: ShotEnvironmentContract;
  locationId?: string;
  expectedPanoId?: string;
  panorama?: PanoReference;
  diagnostics: ShotEnvironmentDiagnostic[];
}

export interface ShotEnvironmentInspection extends ShotEnvironmentResolution {
  ok: boolean;
  shotId: string;
  actualPanoId?: string;
  requireProjection: boolean;
  minimumProjectionCoverage: number;
}

/** Find the persisted contract using the same stable-id fallback as presence. */
export function getShotEnvironmentContract(
  project: LocationProject,
  shot: Pick<Shot, 'id' | 'shotNumber' | 'productionShotId'>,
): ShotEnvironmentContract | undefined {
  const contracts = getProductionConfiguration(project).shotContracts;
  for (const key of [shot.id, shot.productionShotId, shot.shotNumber]) {
    if (key && contracts[key]?.environment) return contracts[key].environment;
  }
  return undefined;
}

/**
 * Resolve the explicit panorama for a prepared location.
 *
 * A contract never falls back to an arbitrary project panorama. If the
 * location does not name an expected/default panorama, compilation fails and
 * the operator must prepare the location first.
 */
export function resolveShotEnvironment(
  project: LocationProject,
  shot: Pick<Shot, 'id' | 'shotNumber' | 'productionShotId'>,
  contractInput?: ShotEnvironmentContract,
): ShotEnvironmentResolution {
  const contract = contractInput ?? getShotEnvironmentContract(project, shot);
  if (!contract) return { contractPresent: false, diagnostics: [] };

  const diagnostics: ShotEnvironmentDiagnostic[] = [];
  const configuration = getProductionConfiguration(project);
  const location = configuration.locations[contract.locationId];
  if (!location) {
    diagnostics.push({
      code: 'location_missing',
      severity: 'error',
      message: `Shot "${shot.id}" requires prepared location "${contract.locationId}", but it is not defined.`,
      shotId: shot.id,
      locationId: contract.locationId,
    });
    return {
      contractPresent: true,
      contract,
      locationId: contract.locationId,
      diagnostics,
    };
  }

  const expectedPanoId = contract.expectedPanoId
    ?? location.defaultPanoId
    ?? location.panoIds?.[0];
  if (!expectedPanoId) {
    diagnostics.push({
      code: 'expected_panorama_missing',
      severity: 'error',
      message: `Prepared location "${location.id}" has no expected or default panorama.`,
      shotId: shot.id,
      locationId: location.id,
    });
    return {
      contractPresent: true,
      contract,
      locationId: location.id,
      diagnostics,
    };
  }

  const panorama = project.panoRefs.find((candidate) => candidate.id === expectedPanoId);
  if (!panorama) {
    diagnostics.push({
      code: 'expected_panorama_missing',
      severity: 'error',
      message: `Shot "${shot.id}" requires panorama "${expectedPanoId}", but that panorama is not in the project.`,
      shotId: shot.id,
      locationId: location.id,
      expectedPanoId,
    });
  }

  if (location.panoIds?.length && !location.panoIds.includes(expectedPanoId)) {
    diagnostics.push({
      code: 'panorama_not_in_location',
      severity: 'error',
      message: `Panorama "${expectedPanoId}" is not prepared for location "${location.id}".`,
      shotId: shot.id,
      locationId: location.id,
      expectedPanoId,
    });
  }

  return {
    contractPresent: true,
    contract,
    locationId: location.id,
    expectedPanoId,
    panorama,
    diagnostics,
  };
}

export function inspectShotEnvironment(
  project: LocationProject,
  shotInput: Shot | string,
  options: { requireContract?: boolean } = {},
): ShotEnvironmentInspection {
  const shot = typeof shotInput === 'string'
    ? project.shots.find((candidate) => candidate.id === shotInput)
    : project.shots.find((candidate) => candidate.id === shotInput.id) ?? shotInput;
  const shotId = typeof shotInput === 'string' ? shotInput : shotInput.id;
  if (!shot) {
    return {
      ok: false,
      shotId,
      contractPresent: false,
      actualPanoId: undefined,
      requireProjection: false,
      minimumProjectionCoverage: 0,
      diagnostics: [{
        code: 'location_missing',
        severity: 'error',
        message: `Shot "${shotId}" does not exist.`,
        shotId,
      }],
    };
  }

  const resolution = resolveShotEnvironment(project, shot);
  const diagnostics = [...resolution.diagnostics];
  if (!resolution.contractPresent && options.requireContract) {
    diagnostics.push({
      code: 'environment_contract_missing',
      severity: 'error',
      message: `Shot "${shot.id}" has no persisted environment contract.`,
      shotId: shot.id,
    });
  }

  if (resolution.contractPresent && resolution.expectedPanoId !== shot.linkedPanoId) {
    diagnostics.push({
      code: 'wrong_panorama_linked',
      severity: 'error',
      message: shot.linkedPanoId
        ? `Shot "${shot.id}" links panorama "${shot.linkedPanoId}" instead of expected "${resolution.expectedPanoId}".`
        : `Shot "${shot.id}" has no linked panorama; expected "${resolution.expectedPanoId}".`,
      shotId: shot.id,
      locationId: resolution.locationId,
      expectedPanoId: resolution.expectedPanoId,
      actualPanoId: shot.linkedPanoId,
    });
  }

  return {
    ...resolution,
    ok: diagnostics.every((item) => item.severity !== 'error'),
    shotId: shot.id,
    actualPanoId: shot.linkedPanoId,
    requireProjection: resolution.contract?.requireProjection ?? false,
    minimumProjectionCoverage: resolution.contract?.minimumProjectionCoverage ?? 0.5,
    diagnostics,
  };
}

export function verifyShotPanorama(
  project: LocationProject,
  shotInput: Shot | string,
): ShotEnvironmentInspection {
  return inspectShotEnvironment(project, shotInput, { requireContract: true });
}

export interface ProjectionHealthMetrics {
  projectedTextureAvailable: boolean;
  occlusionMapAvailable: boolean;
  projectedMaterialCount: number;
  geometryPixelCount: number;
  coveredPixelCount: number;
  fallbackPixelCount: number;
  projectionCoverage: number;
  fallbackRatio: number;
}

export function analyzeProjectionDebugPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
): Pick<ProjectionHealthMetrics, 'geometryPixelCount' | 'coveredPixelCount' | 'fallbackPixelCount' | 'projectionCoverage' | 'fallbackRatio'> {
  const pixelCount = Math.min(width * height, Math.floor(pixels.length / 4));
  let coveredPixelCount = 0;
  let fallbackPixelCount = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    // Projected coverage debug colors: red = no projector coverage; cyan,
    // magenta, or white = one or more projectors contributed to the fragment.
    const isFallback = red > 150 && green < 100 && blue < 100;
    const isCovered = (green > 130 && blue > 130 && red < 150)
      || (red > 130 && blue > 130 && green < 150)
      || (red > 150 && green > 150 && blue > 150);
    if (isFallback) fallbackPixelCount += 1;
    else if (isCovered) coveredPixelCount += 1;
  }
  const geometryPixelCount = coveredPixelCount + fallbackPixelCount;
  return {
    geometryPixelCount,
    coveredPixelCount,
    fallbackPixelCount,
    projectionCoverage: geometryPixelCount > 0 ? coveredPixelCount / geometryPixelCount : 0,
    fallbackRatio: geometryPixelCount > 0 ? fallbackPixelCount / geometryPixelCount : 0,
  };
}

export interface ProjectionHealthOptions {
  requireProjection: boolean;
  minimumProjectionCoverage?: number;
  maximumFallbackRatio?: number;
  shotId?: string;
}

export function evaluateProjectionHealth(
  metrics: ProjectionHealthMetrics,
  options: ProjectionHealthOptions,
): ShotEnvironmentDiagnostic[] {
  if (!options.requireProjection) return [];
  const minimumCoverage = options.minimumProjectionCoverage ?? 0.5;
  const maximumFallbackRatio = options.maximumFallbackRatio ?? 0.35;
  const diagnostics: ShotEnvironmentDiagnostic[] = [];
  if (!metrics.projectedTextureAvailable || metrics.projectedMaterialCount === 0) {
    diagnostics.push({
      code: 'projected_material_missing',
      severity: 'error',
      message: 'Projected rendering has no usable projected texture or projected scene material.',
      shotId: options.shotId,
    });
  }
  if (metrics.projectionCoverage < minimumCoverage) {
    diagnostics.push({
      code: 'projection_coverage_low',
      severity: 'error',
      message: `Projected geometry coverage ${(metrics.projectionCoverage * 100).toFixed(1)}% is below the required ${(minimumCoverage * 100).toFixed(1)}%.`,
      shotId: options.shotId,
      coverage: metrics.projectionCoverage,
    });
  }
  if (metrics.fallbackRatio > maximumFallbackRatio) {
    diagnostics.push({
      code: 'projection_fallback_excessive',
      severity: 'error',
      message: `Unprojected geometry fallback ${(metrics.fallbackRatio * 100).toFixed(1)}% exceeds the allowed ${(maximumFallbackRatio * 100).toFixed(1)}%.`,
      shotId: options.shotId,
      fallbackRatio: metrics.fallbackRatio,
    });
    diagnostics.push({
      code: 'untextured_region_excessive',
      severity: 'error',
      message: 'Projected output contains excessive contiguous geometry without panorama coverage.',
      shotId: options.shotId,
      fallbackRatio: metrics.fallbackRatio,
    });
  }
  if (!metrics.occlusionMapAvailable) {
    diagnostics.push({
      code: 'projection_occlusion_unavailable',
      severity: 'warning',
      message: 'Projected health was measured without a generated occlusion map.',
      shotId: options.shotId,
    });
  }
  return diagnostics;
}
