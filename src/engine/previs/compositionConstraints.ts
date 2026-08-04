/**
 * Reference-driven composition constraints.
 *
 * External tools may turn a storyboard or approved layout into normalized
 * screen-space facts. ForeScene evaluates those facts against its existing
 * deterministic projection telemetry; it does not perform image
 * understanding or pixel-similarity matching.
 */

import type {
  LocationProject,
  NormalizedRect,
  Shot,
  ShotCompositionConstraintSet,
  Vec2,
} from '../../domain/types';
import { resolveProjectForShot } from '../shotSceneState';
import {
  buildCameraMatrices,
  projectWorldPoint,
  type ProjectedBounds,
} from './screenProjection';
import {
  describeSceneObjectComposition,
  type ShotCompositionSubject,
} from './compositionTelemetry';
import { getProductionConfiguration } from './productionConfiguration';

export type CompositionConstraintDiagnosticCode =
  | 'composition_contract_missing'
  | 'composition_entity_missing'
  | 'composition_constraint_out_of_tolerance';

/** Normalized comparison epsilon for point/range values (about one pixel at 1k). */
export const COMPOSITION_NUMERIC_EPSILON = 0.001;

export interface CompositionConstraintDiagnostic {
  code: CompositionConstraintDiagnosticCode;
  message: string;
  entityId?: string;
  measured?: unknown;
  expected?: unknown;
  weightedError?: number;
}

export interface CompositionEntityProjection {
  entityId: string;
  objectIds: string[];
  bounds?: NormalizedRect;
  bodyBounds?: NormalizedRect;
  assemblyBounds?: NormalizedRect;
  center?: Vec2;
  coverage?: number;
  bodyCoverage?: number;
  assemblyCoverage?: number;
  visibleFraction?: number;
  headPoint?: Vec2;
  facePoint?: Vec2;
  footPoint?: Vec2;
  feetY?: number;
  completeAssemblyInFrame?: boolean;
  occlusionRatio?: number;
}

export interface ShotCompositionConstraintInspection {
  ok: boolean;
  shotId: string;
  contractPresent: boolean;
  totalWeightedError: number;
  entities: Record<string, CompositionEntityProjection>;
  diagnostics: CompositionConstraintDiagnostic[];
}

interface ResolvedEntityProjection {
  entityId: string;
  objectIds: string[];
  telemetry: ShotCompositionSubject[];
  projection: CompositionEntityProjection;
}

export function getShotCompositionContract(
  project: LocationProject,
  shot: Pick<Shot, 'id' | 'shotNumber' | 'productionShotId'>,
): ShotCompositionConstraintSet | undefined {
  const contracts = getProductionConfiguration(project).shotContracts;
  for (const key of [shot.id, shot.productionShotId, shot.shotNumber]) {
    if (key && contracts[key]?.composition) return contracts[key].composition;
  }
  return undefined;
}

function boundObjectIds(project: LocationProject, entityId: string): string[] {
  const configuration = getProductionConfiguration(project);
  const binding = configuration.bindings[entityId]
    ?? configuration.bindings[`cast.${entityId}`]
    ?? configuration.bindings[`prop.${entityId}`]
    ?? configuration.bindings[`locations.${entityId}`];
  if (binding?.kind === 'object') return [binding.objectId];
  if (binding?.kind === 'group') return [...new Set(project.scene.objectGroups?.[binding.groupId]?.objectIds ?? [])];
  if (binding?.kind === 'location') {
    const location = configuration.locations[binding.locationId];
    return [...new Set([
      ...(location?.objectIds ?? []),
      ...(location?.objectGroupIds ?? []).flatMap((groupId) => project.scene.objectGroups?.[groupId]?.objectIds ?? []),
    ])];
  }
  if (project.scene.objects.some((object) => object.id === entityId)) return [entityId];
  const byName = project.scene.objects.find((object) => object.name === entityId);
  return byName ? [byName.id] : [];
}

function rectFromBounds(bounds: ProjectedBounds, width: number, height: number): NormalizedRect {
  const left = bounds.visible.pixels.left / Math.max(1, width);
  const top = bounds.visible.pixels.top / Math.max(1, height);
  const right = bounds.visible.pixels.right / Math.max(1, width);
  const bottom = bounds.visible.pixels.bottom / Math.max(1, height);
  return {
    x: Math.max(0, Math.min(1, left)),
    y: Math.max(0, Math.min(1, top)),
    width: Math.max(0, Math.min(1, right) - Math.max(0, Math.min(1, left))),
    height: Math.max(0, Math.min(1, bottom) - Math.max(0, Math.min(1, top))),
  };
}

function unionRect(rects: NormalizedRect[]): NormalizedRect | undefined {
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function centerOf(rect: NormalizedRect | undefined): Vec2 | undefined {
  return rect ? [rect.x + rect.width / 2, rect.y + rect.height / 2] : undefined;
}

function pointFromSubject(
  telemetry: ShotCompositionSubject[],
  landmark: 'headTop' | 'eyes',
): Vec2 | undefined {
  const points = telemetry
    .map((entry) => entry.landmarks?.[landmark])
    .filter((point): point is { x: number; y: number; inFrame: boolean } => Boolean(point));
  if (points.length === 0) return undefined;
  return [
    points.reduce((sum, point) => sum + point.x, 0) / points.length,
    points.reduce((sum, point) => sum + point.y, 0) / points.length,
  ];
}

function footPointFromSubject(telemetry: ShotCompositionSubject[]): Vec2 | undefined {
  const points = telemetry
    .map((entry) => entry.footPoint)
    .filter((point): point is { x: number; y: number; inFrame: boolean } => Boolean(point));
  if (points.length === 0) return undefined;
  return [
    points.reduce((sum, point) => sum + point.x, 0) / points.length,
    points.reduce((sum, point) => sum + point.y, 0) / points.length,
  ];
}

function resolveEntityProjection(
  project: LocationProject,
  shot: Shot,
  entityId: string,
): ResolvedEntityProjection {
  const resolved = resolveProjectForShot(project, shot);
  const objectIds = boundObjectIds(project, entityId);
  const entries = objectIds.flatMap((objectId) => {
    const object = resolved.scene.objects.find((candidate) => candidate.id === objectId);
    if (!object || object.visible === false) return [];
    return [describeSceneObjectComposition({ project, shot, object })];
  });
  const width = shot.exportSettings.width || 1280;
  const height = shot.exportSettings.height || 720;
  const bodyBounds = unionRect(entries.map((entry) => rectFromBounds(entry.bodyBounds ?? entry.bounds, width, height)));
  const assemblyBounds = unionRect(entries.map((entry) => rectFromBounds(entry.assemblyBounds ?? entry.bounds, width, height)));
  const bodyCoverage = entries.length > 0
    ? entries.reduce((sum, entry) => sum + (entry.bodyCoverage ?? entry.bounds.areaCoverage), 0)
    : 0;
  const assemblyCoverage = entries.length > 0
    ? entries.reduce((sum, entry) => sum + (entry.assemblyCoverage ?? entry.bounds.areaCoverage), 0)
    : 0;
  const visibleFraction = entries.length > 0
    ? entries.reduce((sum, entry) => sum + Math.max(0, 1 - (entry.occlusionRatio ?? 0)), 0) / entries.length
    : 0;
  const telemetry: ShotCompositionSubject[] = entries;
  return {
    entityId,
    objectIds,
    telemetry,
    projection: {
      entityId,
      objectIds,
      ...(bodyBounds ? { bounds: bodyBounds, bodyBounds, center: centerOf(bodyBounds) } : {}),
      ...(assemblyBounds ? { assemblyBounds } : {}),
      coverage: bodyCoverage,
      bodyCoverage,
      assemblyCoverage,
      visibleFraction,
      ...(pointFromSubject(telemetry, 'headTop') ? { headPoint: pointFromSubject(telemetry, 'headTop') } : {}),
      ...(pointFromSubject(telemetry, 'eyes') ? { facePoint: pointFromSubject(telemetry, 'eyes') } : {}),
      ...(footPointFromSubject(telemetry) ? { footPoint: footPointFromSubject(telemetry), feetY: footPointFromSubject(telemetry)?.[1] } : {}),
      completeAssemblyInFrame: entries.length > 0 && entries.every((entry) => entry.completeAssemblyInFrame === true),
      ...(entries.length > 0 ? {
        occlusionRatio: entries.reduce((sum, entry) => sum + (entry.occlusionRatio ?? 0), 0) / entries.length,
      } : {}),
    },
  };
}

function rangeError(value: number | undefined, range: [number, number] | undefined): number {
  if (value === undefined || !range) return 0;
  if (value < range[0]! - COMPOSITION_NUMERIC_EPSILON) return range[0]! - value - COMPOSITION_NUMERIC_EPSILON;
  if (value > range[1]! + COMPOSITION_NUMERIC_EPSILON) return value - range[1]! - COMPOSITION_NUMERIC_EPSILON;
  return 0;
}

function rectError(actual: NormalizedRect | undefined, expected: NormalizedRect | undefined): number {
  if (!actual || !expected) return 1;
  return Math.max(
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.width - expected.width),
    Math.abs(actual.height - expected.height),
  );
}

function pointError(actual: Vec2 | undefined, expected: Vec2 | undefined): number {
  if (!actual || !expected) return 1;
  return Math.max(0, Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) - COMPOSITION_NUMERIC_EPSILON);
}

function addConstraintError(
  diagnostics: CompositionConstraintDiagnostic[],
  params: {
    entityId?: string;
    code?: CompositionConstraintDiagnosticCode;
    message: string;
    expected?: unknown;
    measured?: unknown;
    error: number;
    tolerance: number;
    weight: number;
  },
): number {
  const weightedError = params.error * params.weight;
  if (params.error > params.tolerance) {
    diagnostics.push({
      code: params.code ?? 'composition_constraint_out_of_tolerance',
      message: params.message,
      entityId: params.entityId,
      expected: params.expected,
      measured: params.measured,
      weightedError,
    });
  }
  return weightedError;
}

function intersectionFraction(a: NormalizedRect | undefined, b: NormalizedRect | undefined): number {
  if (!a || !b || a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const area = Math.max(0, right - left) * Math.max(0, bottom - top);
  return area / Math.max(1e-6, b.width * b.height);
}

export function inspectShotCompositionError(
  project: LocationProject,
  shotInput: Shot | string,
  contractInput?: ShotCompositionConstraintSet,
): ShotCompositionConstraintInspection {
  // Object inputs may be candidate shots produced by the deterministic solver;
  // do not replace those candidates with the persisted shot of the same id.
  const shot = typeof shotInput === 'string'
    ? project.shots.find((candidate) => candidate.id === shotInput)
    : shotInput;
  const shotId = typeof shotInput === 'string' ? shotInput : shotInput.id;
  if (!shot) {
    return {
      ok: false,
      shotId,
      contractPresent: false,
      totalWeightedError: 0,
      entities: {},
      diagnostics: [{ code: 'composition_entity_missing', message: `Shot "${shotId}" does not exist.` }],
    };
  }
  const contract = contractInput ?? getShotCompositionContract(project, shot);
  if (!contract) {
    return {
      ok: true,
      shotId: shot.id,
      contractPresent: false,
      totalWeightedError: 0,
      entities: {},
      diagnostics: [],
    };
  }

  const entities = new Map<string, ResolvedEntityProjection>();
  const ensureEntity = (entityId: string) => {
    const existing = entities.get(entityId);
    if (existing) return existing;
    const created = resolveEntityProjection(project, shot, entityId);
    entities.set(entityId, created);
    return created;
  };
  const diagnostics: CompositionConstraintDiagnostic[] = [];
  let totalWeightedError = 0;
  const weights = contract.weights ?? {};
  const tolerance = contract.cropTolerance ?? 0.05;

  for (const subject of contract.subjects) {
    const resolved = ensureEntity(subject.entityId).projection;
    if (resolved.objectIds.length === 0) {
      diagnostics.push({
        code: 'composition_entity_missing',
        message: `Composition subject "${subject.entityId}" cannot be resolved to a prepared object or group.`,
        entityId: subject.entityId,
      });
      continue;
    }
    if (subject.expectedBounds) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" bounds are outside the reference tolerance.`,
        expected: subject.expectedBounds,
        measured: resolved.bounds,
        error: rectError(resolved.bounds, subject.expectedBounds),
        tolerance,
        weight: weights.subjectScale ?? 1,
      });
    }
    if (subject.headPoint) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" head point is outside the reference tolerance.`,
        expected: subject.headPoint,
        measured: resolved.headPoint,
        error: pointError(resolved.headPoint, subject.headPoint),
        tolerance,
        weight: weights.headPoint ?? 1,
      });
    }
    if (subject.facePoint) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" face point is outside the reference tolerance.`,
        expected: subject.facePoint,
        measured: resolved.facePoint,
        error: pointError(resolved.facePoint, subject.facePoint),
        tolerance,
        weight: weights.facePoint ?? 1,
      });
    }
    if (subject.expectedFootPoint) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" foot point is outside the reference tolerance.`,
        expected: subject.expectedFootPoint,
        measured: resolved.footPoint,
        error: pointError(resolved.footPoint, subject.expectedFootPoint),
        tolerance,
        weight: weights.subjectPosition ?? 1,
      });
    }
    if (subject.expectedFeetY) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" feet Y is outside the reference range.`,
        expected: subject.expectedFeetY,
        measured: resolved.feetY,
        error: rangeError(resolved.feetY, subject.expectedFeetY),
        tolerance: 0,
        weight: weights.subjectPosition ?? 1,
      });
    }
    if (subject.expectedCoverage) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" coverage is outside the reference range.`,
        expected: subject.expectedCoverage,
        measured: resolved.coverage,
        error: rangeError(resolved.coverage, subject.expectedCoverage),
        tolerance: 0,
        weight: weights.subjectScale ?? 1,
      });
    }
    if (subject.expectedVisibility !== undefined) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" visibility is outside the reference target.`,
        expected: subject.expectedVisibility,
        measured: resolved.visibleFraction,
        error: Math.abs((resolved.visibleFraction ?? 0) - subject.expectedVisibility),
        tolerance,
        weight: weights.occlusion ?? 1,
      });
    }
    if (subject.completeAssemblyInFrame && !resolved.completeAssemblyInFrame) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" complete assembly is cropped.`,
        expected: true,
        measured: resolved.completeAssemblyInFrame,
        error: 1,
        tolerance: 0,
        weight: weights.crop ?? 1,
      });
    }
    if (subject.screenRegion && resolved.center) {
      const target = subject.screenRegion === 'left' ? 0.25 : subject.screenRegion === 'right' ? 0.75 : 0.5;
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: subject.entityId,
        message: `Subject "${subject.entityId}" is outside the requested ${subject.screenRegion} screen region.`,
        expected: target,
        measured: resolved.center[0],
        error: Math.abs(resolved.center[0] - target),
        tolerance: 0.15,
        weight: weights.subjectPosition ?? 1,
      });
    }
  }

  for (const prop of contract.props ?? []) {
    const resolved = ensureEntity(prop.entityId).projection;
    if (resolved.objectIds.length === 0) {
      diagnostics.push({
        code: 'composition_entity_missing',
        message: `Composition prop "${prop.entityId}" cannot be resolved to a prepared object or group.`,
        entityId: prop.entityId,
      });
      continue;
    }
    if (prop.expectedBounds) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: prop.entityId,
        message: `Prop "${prop.entityId}" bounds are outside the reference tolerance.`,
        expected: prop.expectedBounds,
        measured: resolved.bounds,
        error: rectError(resolved.bounds, prop.expectedBounds),
        tolerance,
        weight: weights.propPosition ?? 1,
      });
    }
    if (prop.expectedScreenPoint) {
      totalWeightedError += addConstraintError(diagnostics, {
        entityId: prop.entityId,
        message: `Prop "${prop.entityId}" screen point is outside the reference tolerance.`,
        expected: prop.expectedScreenPoint,
        measured: resolved.center,
        error: pointError(resolved.center, prop.expectedScreenPoint),
        tolerance,
        weight: weights.propPosition ?? 1,
      });
    }
  }

  const matrices = buildCameraMatrices(shot.camera, shot.exportSettings.width || 1280, shot.exportSettings.height || 720);
  const width = matrices.frameWidth;
  const height = matrices.frameHeight;
  const floorPoint = projectWorldPoint([shot.camera.target[0], 0, shot.camera.target[2]], matrices);
  const horizonPoint = projectWorldPoint([shot.camera.target[0], shot.camera.position[1], shot.camera.target[2]], matrices);
  const floorY = floorPoint.y / Math.max(1, height);
  const horizonY = horizonPoint.y / Math.max(1, height);
  if (contract.floorLineY !== undefined) {
    totalWeightedError += addConstraintError(diagnostics, {
      message: 'Floor line is outside the reference tolerance.',
      expected: contract.floorLineY,
      measured: floorY,
      error: Math.abs(floorY - contract.floorLineY),
      tolerance,
      weight: weights.floorLine ?? 1,
    });
  }
  if (contract.horizonY !== undefined) {
    totalWeightedError += addConstraintError(diagnostics, {
      message: 'Horizon line is outside the reference tolerance.',
      expected: contract.horizonY,
      measured: horizonY,
      error: Math.abs(horizonY - contract.horizonY),
      tolerance,
      weight: weights.horizon ?? 1,
    });
  }

  for (const intent of contract.occlusionIntent ?? []) {
    const foreground = ensureEntity(intent.foregroundEntityId).projection;
    const background = ensureEntity(intent.backgroundEntityId).projection;
    const overlap = intersectionFraction(foreground.bounds, background.bounds);
    totalWeightedError += addConstraintError(diagnostics, {
      message: `Occlusion between "${intent.foregroundEntityId}" and "${intent.backgroundEntityId}" is outside the reference range.`,
      expected: intent.targetFraction,
      measured: overlap,
      error: rangeError(overlap, intent.targetFraction),
      tolerance: 0,
      weight: weights.occlusion ?? 1,
    });
  }

  return {
    ok: diagnostics.length === 0,
    shotId: shot.id,
    contractPresent: true,
    totalWeightedError,
    entities: Object.fromEntries([...entities.entries()].map(([id, value]) => [id, value.projection])),
    diagnostics,
  };
}

/** Strict verifier alias used by Agent and frame-validation adapters. */
export function verifyShotCompositionConstraints(
  project: LocationProject,
  shotInput: Shot | string,
  contractInput?: ShotCompositionConstraintSet,
): ShotCompositionConstraintInspection {
  const result = inspectShotCompositionError(project, shotInput, contractInput);
  return {
    ...result,
    ok: result.contractPresent && result.diagnostics.length === 0,
  };
}
