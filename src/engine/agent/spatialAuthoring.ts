import * as THREE from 'three';
import { createSceneObject } from '../../domain/defaults';
import type { LocationProject, SceneObject, Vec3 } from '../../domain/types';
import { objectWorldAabb } from '../previs/compositionTelemetry';
import {
  relationshipForSource,
  relationshipsForObject,
  resolveSceneRelationships,
  type SceneRelationshipResolution,
  type SceneSpatialRelationship,
} from '../sceneRelationships';
import { AGENT_CREATABLE_OBJECT_TYPES, AGENT_UPRIGHT_OBJECT_TYPES } from './constants';
import type { AgentObjectQuery } from './protocol';

export type ArchitectureKind =
  | 'slab'
  | 'wall'
  | 'wall_segment'
  | 'opening'
  | 'room_member'
  | 'level_member';

export interface AgentArchitectureMetadata {
  kind: ArchitectureKind;
  levelId?: string;
  levelName?: string;
  elevation?: number;
  levelHeight?: number;
  assemblyId?: string;
  hostWallId?: string;
  openingKind?: 'door' | 'window';
  openingOffset?: number;
  /** Bottom offset above the owning level for segmented wall pieces such as headers. */
  baseOffset?: number;
}

export interface AgentWorldBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
}

export interface AgentSceneSpatialInspection {
  id: string;
  name: string;
  type: SceneObject['type'];
  stagingRole?: SceneObject['stagingRole'];
  transform: SceneObject['transform'];
  dimensions: Vec3;
  worldBounds: AgentWorldBounds;
  architecture?: AgentArchitectureMetadata;
  intersectsObjectIds: string[];
  supportedByObjectIds: string[];
  relationships: SceneSpatialRelationship[];
  intersections: Array<{
    objectId: string;
    classification: 'explained' | 'unexplained';
    reason?: string;
  }>;
}

export type AgentSpatialIssueSeverity = 'error' | 'warning' | 'info';

export interface AgentSpatialAuthoringIssue {
  code: string;
  severity: AgentSpatialIssueSeverity;
  message: string;
  objectIds: string[];
  suggestion?: string;
}

export interface AgentSpatialAuthoringReport {
  ok: boolean;
  objectCount: number;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  issues: AgentSpatialAuthoringIssue[];
}

const STRUCTURAL_KINDS = new Set<ArchitectureKind>([
  'slab',
  'wall',
  'wall_segment',
  'opening',
]);

const STRUCTURAL_TYPES = new Set<SceneObject['type']>([
  'floor',
  'wall',
  'doorway',
  'arch',
]);

function cloneVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function architectureMetadata(object: SceneObject): AgentArchitectureMetadata | undefined {
  const value = object.metadata?.architecture;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (
    kind !== 'slab'
    && kind !== 'wall'
    && kind !== 'wall_segment'
    && kind !== 'opening'
    && kind !== 'room_member'
    && kind !== 'level_member'
  ) {
    return undefined;
  }
  return {
    kind,
    ...(typeof record.levelId === 'string' ? { levelId: record.levelId } : {}),
    ...(typeof record.levelName === 'string' ? { levelName: record.levelName } : {}),
    ...(typeof record.elevation === 'number' && Number.isFinite(record.elevation)
      ? { elevation: record.elevation }
      : {}),
    ...(typeof record.levelHeight === 'number' && Number.isFinite(record.levelHeight)
      ? { levelHeight: record.levelHeight }
      : {}),
    ...(typeof record.assemblyId === 'string' ? { assemblyId: record.assemblyId } : {}),
    ...(typeof record.hostWallId === 'string' ? { hostWallId: record.hostWallId } : {}),
    ...(record.openingKind === 'door' || record.openingKind === 'window'
      ? { openingKind: record.openingKind }
      : {}),
    ...(typeof record.openingOffset === 'number' && Number.isFinite(record.openingOffset)
      ? { openingOffset: record.openingOffset }
      : {}),
    ...(typeof record.baseOffset === 'number' && Number.isFinite(record.baseOffset)
      ? { baseOffset: record.baseOffset }
      : {}),
  };
}

function boundsFor(object: SceneObject): AgentWorldBounds {
  const bounds = objectWorldAabb(object);
  return {
    min: cloneVec3(bounds.min),
    max: cloneVec3(bounds.max),
    center: [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ],
    size: [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ],
  };
}

function intersects(a: AgentWorldBounds, b: AgentWorldBounds): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0]
    && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
    && a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
  );
}

function intersectionVolume(a: AgentWorldBounds, b: AgentWorldBounds): number {
  const x = Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]));
  const y = Math.max(0, Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]));
  const z = Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]));
  return x * y * z;
}

function footprintContains(bounds: AgentWorldBounds, point: Vec3, margin = 0.04): boolean {
  return (
    point[0] >= bounds.min[0] - margin
    && point[0] <= bounds.max[0] + margin
    && point[2] >= bounds.min[2] - margin
    && point[2] <= bounds.max[2] + margin
  );
}

function isLikelySupport(object: SceneObject, bounds: AgentWorldBounds): boolean {
  const tag = architectureMetadata(object);
  if (tag?.kind === 'slab') return true;
  if (object.type === 'floor') return true;
  const name = object.name.toLowerCase();
  return (
    (name.includes('floor') || name.includes('slab') || name.includes('deck'))
    && bounds.size[1] <= 0.6
    && bounds.size[0] >= 1
    && bounds.size[2] >= 1
  );
}

function objectVolume(bounds: AgentWorldBounds): number {
  return Math.max(1e-8, bounds.size[0] * bounds.size[1] * bounds.size[2]);
}

function architectureAssemblyId(object: SceneObject): string | undefined {
  return architectureMetadata(object)?.assemblyId;
}

function relationshipExplainsPair(
  resolution: SceneRelationshipResolution,
  a: SceneObject,
  b: SceneObject,
): string | undefined {
  const relationship = resolution.relationships.find((candidate) => (
    candidate.status === 'resolved'
    && (
      (candidate.sourceId === a.id && candidate.targetId === b.id)
      || (candidate.sourceId === b.id && candidate.targetId === a.id)
    )
  ));
  if (!relationship) return undefined;
  return relationship.kind === 'portal_host'
    ? 'doorway portal is intentionally hosted in and cuts this wall'
    : 'stair clearance intentionally cuts this horizontal structure';
}

function wallLike(object: SceneObject): boolean {
  const kind = architectureMetadata(object)?.kind;
  return object.type === 'wall' || kind === 'wall' || kind === 'wall_segment';
}

function horizontalYawDifferenceDegrees(a: SceneObject, b: SceneObject): number {
  const normalize = (value: number) => {
    let normalized = value % 180;
    if (normalized < 0) normalized += 180;
    return normalized;
  };
  const delta = Math.abs(normalize(a.transform.rotation[1]) - normalize(b.transform.rotation[1]));
  return Math.min(delta, 180 - delta);
}

function expectedWallJunction(
  a: SceneObject,
  b: SceneObject,
  aBounds: AgentWorldBounds,
  bBounds: AgentWorldBounds,
  overlapVolume: number,
): boolean {
  if (!wallLike(a) || !wallLike(b)) return false;
  const assemblyA = architectureAssemblyId(a);
  const assemblyB = architectureAssemblyId(b);
  if (assemblyA && assemblyB && assemblyA === assemblyB) return true;
  const ratio = overlapVolume / Math.min(objectVolume(aBounds), objectVolume(bBounds));
  const yawDelta = horizontalYawDifferenceDegrees(a, b);
  if (yawDelta >= 25) return ratio <= 0.35;
  return ratio <= 0.08;
}

function supportSideForPortal(
  doorway: SceneObject,
  bounds: AgentWorldBounds,
  supports: SceneObject[],
  boundsById: ReadonlyMap<string, AgentWorldBounds>,
): { positive: boolean; negative: boolean } {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(doorway.transform.rotation[0]),
    THREE.MathUtils.degToRad(doorway.transform.rotation[1]),
    THREE.MathUtils.degToRad(doorway.transform.rotation[2]),
    'XYZ',
  );
  const normal = new THREE.Vector3(0, 0, 1).applyEuler(euler);
  normal.y = 0;
  if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
  normal.normalize();
  const depth = doorway.dimensions[2] * Math.abs(doorway.transform.scale[2]);
  const offset = depth / 2 + 0.3;
  const center = new THREE.Vector3(...bounds.center);
  const thresholdY = bounds.min[1];
  const points = [
    center.clone().addScaledVector(normal, offset),
    center.clone().addScaledVector(normal, -offset),
  ];
  const hasSupport = (point: THREE.Vector3) => supports.some((support) => {
    if (support.id === doorway.id) return false;
    const supportBounds = boundsById.get(support.id);
    if (!supportBounds) return false;
    const verticalGap = thresholdY - supportBounds.max[1];
    return (
      verticalGap >= -0.12
      && verticalGap <= 0.35
      && footprintContains(supportBounds, [point.x, thresholdY, point.z], 0.08)
    );
  });
  return {
    positive: hasSupport(points[0]!),
    negative: hasSupport(points[1]!),
  };
}

function matchesQuery(object: SceneObject, query: AgentObjectQuery): boolean {
  if (query.name !== undefined) {
    const match = query.match ?? 'contains';
    const candidate = object.name.toLowerCase();
    const expected = query.name.toLowerCase();
    if (match === 'exact' ? candidate !== expected : !candidate.includes(expected)) return false;
  }
  if (query.type !== undefined && object.type !== query.type) return false;
  if (query.stagingRole !== undefined && object.stagingRole !== query.stagingRole) return false;
  if (query.visible !== undefined && object.visible !== query.visible) return false;
  if (query.locked !== undefined && object.locked !== query.locked) return false;
  return true;
}

export function inspectSceneSpatially(
  project: LocationProject,
  query: AgentObjectQuery = {},
): AgentSceneSpatialInspection[] {
  const resolution = resolveSceneRelationships(project);
  const objects = project.scene.objects.filter((object) => matchesQuery(object, query));
  const allVisible = project.scene.objects.filter((object) => object.visible !== false && object.type !== 'sun_marker');
  const boundsById = new Map(allVisible.map((object) => [object.id, boundsFor(object)]));
  const supportObjects = allVisible.filter((object) => {
    const bounds = boundsById.get(object.id);
    return Boolean(bounds && isLikelySupport(object, bounds));
  });

  return objects.map((object) => {
    const bounds = boundsFor(object);
    const bottomPoint: Vec3 = [bounds.center[0], bounds.min[1], bounds.center[2]];
    const supportedByObjectIds = supportObjects
      .filter((support) => support.id !== object.id)
      .filter((support) => {
        const supportBounds = boundsById.get(support.id)!;
        const gap = bottomPoint[1] - supportBounds.max[1];
        return footprintContains(supportBounds, bottomPoint) && gap >= -0.05 && gap <= 0.35;
      })
      .map((support) => support.id);

    const intersecting = allVisible
      .filter((other) => other.id !== object.id)
      .filter((other) => intersects(bounds, boundsById.get(other.id)!));
    const intersections = intersecting.map((other) => {
      const otherBounds = boundsById.get(other.id)!;
      const relationReason = relationshipExplainsPair(resolution, object, other);
      const assemblyA = architectureAssemblyId(object);
      const assemblyB = architectureAssemblyId(other);
      const overlap = intersectionVolume(bounds, otherBounds);
      const reason = relationReason
        ?? (assemblyA && assemblyB && assemblyA === assemblyB ? 'same architectural assembly' : undefined)
        ?? (expectedWallJunction(object, other, bounds, otherBounds, overlap) ? 'expected wall junction' : undefined);
      return {
        objectId: other.id,
        classification: reason ? 'explained' as const : 'unexplained' as const,
        ...(reason ? { reason } : {}),
      };
    });

    return {
      id: object.id,
      name: object.name,
      type: object.type,
      stagingRole: object.stagingRole,
      transform: {
        position: cloneVec3(object.transform.position),
        rotation: cloneVec3(object.transform.rotation),
        scale: cloneVec3(object.transform.scale),
      },
      dimensions: cloneVec3(object.dimensions),
      worldBounds: bounds,
      architecture: architectureMetadata(object),
      intersectsObjectIds: intersecting.map((other) => other.id),
      supportedByObjectIds,
      relationships: relationshipsForObject(resolution, object.id),
      intersections,
    };
  });
}

function addIssue(
  issues: AgentSpatialAuthoringIssue[],
  issue: AgentSpatialAuthoringIssue,
): void {
  const key = `${issue.code}:${[...issue.objectIds].sort().join(',')}`;
  if (issues.some((candidate) => (
    `${candidate.code}:${[...candidate.objectIds].sort().join(',')}` === key
  ))) return;
  issues.push(issue);
}

export function validateSpatialAuthoring(project: LocationProject): AgentSpatialAuthoringReport {
  const issues: AgentSpatialAuthoringIssue[] = [];
  const objects = project.scene.objects.filter((object) => object.visible !== false && object.type !== 'sun_marker');
  const boundsById = new Map(objects.map((object) => [object.id, boundsFor(object)]));
  const supports = objects.filter((object) => isLikelySupport(object, boundsById.get(object.id)!));
  const structural = objects.filter((object) => {
    const tag = architectureMetadata(object);
    return STRUCTURAL_TYPES.has(object.type) || Boolean(tag && STRUCTURAL_KINDS.has(tag.kind));
  });

  for (const object of objects) {
    const bounds = boundsById.get(object.id)!;
    const tag = architectureMetadata(object);
    const name = object.name.toLowerCase();

    const nameSuggestsHorizontalSurface = /(?:^|\b)(slab|deck|ceiling)(?:\b|$)/i.test(object.name)
      || (object.type === 'floor' && /(?:^|\b)floor(?:\b|$)/i.test(object.name))
      || (object.type === 'box' && /(?:^|\b)floor(?:\b|$)/i.test(object.name));
    const thinnestAxis = Math.min(bounds.size[0], bounds.size[1], bounds.size[2]);
    if (
      nameSuggestsHorizontalSurface
      && bounds.size[1] > 1
      && thinnestAxis < 0.6
      && bounds.size[1] !== thinnestAxis
    ) {
      addIssue(issues, {
        code: 'dimension_axis_mismatch',
        severity: 'error',
        objectIds: [object.id],
        message: `"${object.name}" is named like a horizontal slab but is ${bounds.size[1].toFixed(2)} m tall. ForeScene dimensions are [X width, Y height, Z depth].`,
        suggestion: 'Use a small Y dimension for slab thickness, e.g. [width, 0.2, depth].',
      });
    }

    if (tag?.kind === 'slab' && bounds.size[1] > 0.6) {
      addIssue(issues, {
        code: 'slab_too_thick',
        severity: 'warning',
        objectIds: [object.id],
        message: `Architectural slab "${object.name}" is ${bounds.size[1].toFixed(2)} m thick.`,
        suggestion: 'Typical previs floor/ceiling slabs are roughly 0.1–0.4 m thick unless intentionally massive.',
      });
    }

    if (/(upper|upstairs|second floor|2nd floor)/i.test(name) && bounds.max[1] < 2.2) {
      addIssue(issues, {
        code: 'named_upper_level_near_ground',
        severity: 'warning',
        objectIds: [object.id],
        message: `"${object.name}" sounds like an upper-level object but its world bounds remain near ground level.`,
        suggestion: 'Assign it to an architectural level or move its lower bound to the intended story elevation.',
      });
    }

    if (tag?.elevation !== undefined) {
      const expectedFloor = tag.elevation;
      if (tag.kind === 'slab') {
        const role = object.metadata?.architecture && typeof object.metadata.architecture === 'object'
          ? (object.metadata.architecture as Record<string, unknown>).slabRole
          : undefined;
        const referenceY = role === 'ceiling' ? bounds.max[1] : bounds.max[1];
        const targetY = role === 'ceiling' && tag.levelHeight !== undefined
          ? expectedFloor + tag.levelHeight
          : expectedFloor;
        if (Math.abs(referenceY - targetY) > 0.12) {
          addIssue(issues, {
            code: 'level_misalignment',
            severity: 'error',
            objectIds: [object.id],
            message: `"${object.name}" is tagged for ${tag.levelName ?? tag.levelId ?? 'a level'} but its slab surface is ${Math.abs(referenceY - targetY).toFixed(2)} m from the declared level elevation.`,
            suggestion: 'Recreate or reposition it with architecture.slab(...) so story elevation is handled automatically.',
          });
        }
      } else if (tag.kind === 'wall' || tag.kind === 'wall_segment' || tag.kind === 'level_member') {
        const expectedBottom = expectedFloor + (tag.baseOffset ?? 0);
        if (Math.abs(bounds.min[1] - expectedBottom) > 0.12) {
          addIssue(issues, {
            code: 'level_misalignment',
            severity: 'error',
            objectIds: [object.id],
            message: `"${object.name}" starts at Y=${bounds.min[1].toFixed(2)} m but its declared level placement expects Y=${expectedBottom.toFixed(2)} m.`,
            suggestion: 'Use architecture.wall(...) or architecture.placeOnLevel(...) instead of manually calculating Y.',
          });
        }
      }

      if (
        tag.levelHeight !== undefined
        && tag.kind !== 'slab'
        && bounds.max[1] > expectedFloor + tag.levelHeight + 0.5
      ) {
        addIssue(issues, {
          code: 'level_height_overflow',
          severity: 'warning',
          objectIds: [object.id],
          message: `"${object.name}" extends above the declared story height by more than 0.5 m.`,
          suggestion: 'Check the level assignment, dimensions, and Y axis.',
        });
      }
    }

    if (object.type === 'doorway') {
      const nearWall = structural.some((wall) => {
        if (wall.id === object.id || (wall.type !== 'wall' && architectureMetadata(wall)?.kind !== 'wall_segment')) return false;
        const wallBounds = boundsById.get(wall.id)!;
        const horizontalGapX = Math.max(0, Math.max(wallBounds.min[0] - bounds.max[0], bounds.min[0] - wallBounds.max[0]));
        const horizontalGapZ = Math.max(0, Math.max(wallBounds.min[2] - bounds.max[2], bounds.min[2] - wallBounds.max[2]));
        return Math.hypot(horizontalGapX, horizontalGapZ) <= 0.35
          && bounds.min[1] <= wallBounds.max[1]
          && bounds.max[1] >= wallBounds.min[1];
      });
      if (!tag?.hostWallId && !nearWall) {
        addIssue(issues, {
          code: 'unhosted_opening',
          severity: 'warning',
          objectIds: [object.id],
          message: `Doorway "${object.name}" is not associated with or adjacent to a wall.`,
          suggestion: 'Use architecture.opening(...) inside architecture.wall(...) so the wall is segmented around a real opening.',
        });
      }
    }

    const isMovableContent = (
      object.stagingRole === 'prop'
      || object.stagingRole === 'person'
      || object.type === 'human_dummy'
    );
    if (isMovableContent) {
      const bottom: Vec3 = [bounds.center[0], bounds.min[1], bounds.center[2]];
      const expectedLevelId = tag?.levelId;
      const support = supports.find((candidate) => {
        if (candidate.id === object.id) return false;
        const candidateTag = architectureMetadata(candidate);
        if (expectedLevelId && candidateTag?.levelId && candidateTag.levelId !== expectedLevelId) return false;
        const candidateBounds = boundsById.get(candidate.id)!;
        const gap = bounds.min[1] - candidateBounds.max[1];
        return footprintContains(candidateBounds, bottom) && gap >= -0.05 && gap <= 0.35;
      });
      if (!support && bounds.min[1] > 0.35) {
        addIssue(issues, {
          code: 'unsupported_object',
          severity: 'warning',
          objectIds: [object.id],
          message: `"${object.name}" is elevated with no nearby floor/slab under its center point.`,
          suggestion: 'Use architecture.placeOnLevel(...) or scene.placeOn(...) and verify the supporting slab.',
        });
      }

      const objectVolume = Math.max(1e-6, bounds.size[0] * bounds.size[1] * bounds.size[2]);
      for (const wall of structural) {
        if (wall.id === object.id) continue;
        const wallTag = architectureMetadata(wall);
        if (wall.type !== 'wall' && wallTag?.kind !== 'wall_segment') continue;
        const overlap = intersectionVolume(bounds, boundsById.get(wall.id)!);
        if (overlap / objectVolume > 0.15) {
          addIssue(issues, {
            code: 'content_wall_intrusion',
            severity: 'warning',
            objectIds: [object.id, wall.id],
            message: `"${object.name}" substantially intersects wall geometry "${wall.name}".`,
            suggestion: 'Move the object clear of the wall or revise the wall/opening layout.',
          });
        }
      }
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    ok: errorCount === 0,
    objectCount: objects.length,
    issueCount: issues.length,
    errorCount,
    warningCount,
    issues,
  };
}

const primitiveReference = Object.fromEntries(
  AGENT_CREATABLE_OBJECT_TYPES.map((type) => {
    const object = createSceneObject(type, 1);
    return [type, {
      defaultDimensions: cloneVec3(object.dimensions),
      placement: type === 'floor'
        ? 'position Y denotes the desired TOP surface; compiler stores center below it'
        : AGENT_UPRIGHT_OBJECT_TYPES.has(type)
          ? 'position Y denotes the desired BOTTOM/floor contact; compiler stores center above it'
          : 'position is the object CENTER',
    }];
  }),
);

export const AGENT_SPATIAL_AUTHORING_REFERENCE = {
  version: 1,
  world: {
    units: 'meters',
    worldUp: '+Y',
    horizontalAxes: ['X', 'Z'],
    forwardAxis: '+Z',
    position: '[x, y, z]',
    dimensions: '[width along X, height along Y, depth along Z]',
    rotation: '[x, y, z] Euler angles in DEGREES',
  },
  criticalRules: [
    'Y is always vertical. A floor/slab should normally have a SMALL dimensions[1].',
    'Do not guess story Y values repeatedly. Use architecture.level and architecture helpers.',
    'Raw scene.create has legacy placement semantics that vary by primitive; consult primitiveReference below.',
    'For substantial construction: build -> scene_validate -> scene_capture (top/isometric) -> correct -> apply/finalize.',
    'Door/window openings should be authored through architecture.opening + architecture.wall so wall geometry is segmented around the opening.',
  ],
  primitiveReference,
  scripting: {
    architecture: {
      level: 'architecture.level({name, elevation, height}) -> level descriptor',
      opening: 'architecture.opening({kind:"door"|"window", offset, width, height, sillHeight?}) -> opening descriptor; does not mutate by itself',
      wall: 'architecture.wall({level, from:[x,z], to:[x,z], name?, thickness?, height?, openings?}) -> segmented wall assembly',
      slab: 'architecture.slab({level, name?, width, depth, thickness?, center?:[x,z], role?:"floor"|"ceiling"})',
      room: 'architecture.room({level, name, boundary:[[x,z],...], thickness?, height?, openingsByEdge?}) -> free-form polygon wall loop',
      placeOnLevel: 'architecture.placeOnLevel(object, level, {x?, z?, gap?}) -> moves object bottom to level elevation',
    },
    creation: [
      'scene.createCentered(type, {position:[centerX,centerY,centerZ], dimensions,...}) gives uniform CENTER semantics across primitive types',
      'scene.create(...) remains available for legacy primitive-specific placement semantics',
    ],
    spatial: [
      'scene.bounds',
      'scene.distance',
      'scene.intersects',
      'scene.nearest',
      'scene.placeOn',
      'scene.align',
      'scene.lookAt',
      'scene.distribute',
      'scene.linearArray',
      'scene.radialArray',
    ],
  },
} as const;
