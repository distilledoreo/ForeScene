import * as THREE from 'three';
import type { LocationProject, SceneObject, Vec3 } from '../domain/types';

export type SceneRelationshipKind = 'portal_host' | 'stair_clearance';

export interface LocalBoxFragment {
  min: Vec3;
  max: Vec3;
}

export interface SceneBoxCut extends LocalBoxFragment {
  sourceId: string;
  kind: SceneRelationshipKind;
}

export interface SceneSpatialRelationship {
  kind: SceneRelationshipKind;
  sourceId: string;
  targetId?: string;
  status: 'resolved' | 'unhosted' | 'ambiguous';
  candidateIds?: string[];
}

export interface SceneRelationshipResolution {
  relationships: SceneSpatialRelationship[];
  cutsByHostId: Map<string, SceneBoxCut[]>;
}

const EPSILON = 1e-4;
const DEFAULT_STAIR_CLEARANCE_ABOVE_METERS = 2.1;

function cloneVec3(value: THREE.Vector3): Vec3 {
  return [value.x, value.y, value.z];
}

function objectMatrix(object: SceneObject): THREE.Matrix4 {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(object.transform.rotation[0]),
    THREE.MathUtils.degToRad(object.transform.rotation[1]),
    THREE.MathUtils.degToRad(object.transform.rotation[2]),
    'XYZ',
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...object.transform.position),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(...object.transform.scale),
  );
}

function localBounds(object: SceneObject): LocalBoxFragment {
  return {
    min: [-object.dimensions[0] / 2, -object.dimensions[1] / 2, -object.dimensions[2] / 2],
    max: [object.dimensions[0] / 2, object.dimensions[1] / 2, object.dimensions[2] / 2],
  };
}

function corners(bounds: LocalBoxFragment): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        result.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  return result;
}

function transformedCorners(
  object: SceneObject,
  bounds: LocalBoxFragment = localBounds(object),
): THREE.Vector3[] {
  const matrix = objectMatrix(object);
  return corners(bounds).map((corner) => corner.applyMatrix4(matrix));
}

function worldAabbFromCorners(values: THREE.Vector3[]): THREE.Box3 {
  return new THREE.Box3().setFromPoints(values);
}

function objectWorldAabb(object: SceneObject): THREE.Box3 {
  return worldAabbFromCorners(transformedCorners(object));
}

function projectedCut(
  host: SceneObject,
  worldCorners: THREE.Vector3[],
  throughAxis: 'x' | 'y' | 'z',
): LocalBoxFragment | undefined {
  const inverse = objectMatrix(host).invert();
  const projected = worldCorners.map((point) => point.clone().applyMatrix4(inverse));
  const projectedBox = new THREE.Box3().setFromPoints(projected);
  const hostBounds = localBounds(host);
  const min = projectedBox.min;
  const max = projectedBox.max;

  if (throughAxis === 'x') {
    min.x = hostBounds.min[0] - EPSILON;
    max.x = hostBounds.max[0] + EPSILON;
  } else if (throughAxis === 'y') {
    min.y = hostBounds.min[1] - EPSILON;
    max.y = hostBounds.max[1] + EPSILON;
  } else {
    min.z = hostBounds.min[2] - EPSILON;
    max.z = hostBounds.max[2] + EPSILON;
  }

  const clipped: LocalBoxFragment = {
    min: [
      Math.max(hostBounds.min[0], min.x),
      Math.max(hostBounds.min[1], min.y),
      Math.max(hostBounds.min[2], min.z),
    ],
    max: [
      Math.min(hostBounds.max[0], max.x),
      Math.min(hostBounds.max[1], max.y),
      Math.min(hostBounds.max[2], max.z),
    ],
  };
  if (
    clipped.max[0] - clipped.min[0] <= EPSILON
    || clipped.max[1] - clipped.min[1] <= EPSILON
    || clipped.max[2] - clipped.min[2] <= EPSILON
  ) {
    return undefined;
  }
  return clipped;
}

function horizontalLocalXAxis(object: SceneObject): THREE.Vector3 {
  const matrix = objectMatrix(object);
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
  const x = new THREE.Vector3(1, 0, 0).applyMatrix4(matrix).sub(origin);
  x.y = 0;
  if (x.lengthSq() <= EPSILON) return new THREE.Vector3(1, 0, 0);
  return x.normalize();
}

function doorWallCompatible(doorway: SceneObject, wall: SceneObject): boolean {
  const orientation = Math.abs(horizontalLocalXAxis(doorway).dot(horizontalLocalXAxis(wall)));
  if (orientation < Math.cos(THREE.MathUtils.degToRad(25))) return false;

  const hostInverse = objectMatrix(wall).invert();
  const doorProjected = new THREE.Box3().setFromPoints(
    transformedCorners(doorway).map((point) => point.clone().applyMatrix4(hostInverse)),
  );
  const host = localBounds(wall);
  const overlapX = Math.min(host.max[0], doorProjected.max.x) - Math.max(host.min[0], doorProjected.min.x);
  const overlapY = Math.min(host.max[1], doorProjected.max.y) - Math.max(host.min[1], doorProjected.min.y);
  const overlapZ = Math.min(host.max[2], doorProjected.max.z) - Math.max(host.min[2], doorProjected.min.z);
  return overlapX > 0.12 && overlapY > 0.3 && overlapZ > Math.min(0.04, wall.dimensions[2] * 0.25);
}

function architectureRecord(object: SceneObject): Record<string, unknown> | undefined {
  const value = object.metadata?.architecture;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isEligibleHorizontalCutTarget(object: SceneObject): boolean {
  if (object.type === 'floor') return true;
  const architecture = architectureRecord(object);
  if (architecture?.kind === 'slab') return true;
  if (object.type !== 'box') return false;
  const bounds = objectWorldAabb(object);
  const size = bounds.getSize(new THREE.Vector3());
  if (size.y > 0.65 || size.x < 0.5 || size.z < 0.5) return false;
  return /(?:^|\b)(floor|slab|ceiling|deck|platform)(?:\b|$)/i.test(object.name);
}

export function stairClearanceLocalBounds(stairs: SceneObject): LocalBoxFragment {
  const [w, h, d] = stairs.dimensions;
  const configured = Number(architectureRecord(stairs)?.clearanceAboveMeters);
  const clearanceAbove = Number.isFinite(configured) && configured > 0
    ? Math.min(6, configured)
    : DEFAULT_STAIR_CLEARANCE_ABOVE_METERS;
  const overlapBelowTop = Math.min(0.18, Math.max(0.06, h * 0.08));
  return {
    min: [-w / 2, h / 2 - overlapBelowTop, -d / 2],
    max: [w / 2, h / 2 + clearanceAbove, d / 2],
  };
}

export function stairClearanceWorldAabb(stairs: SceneObject): { min: Vec3; max: Vec3 } {
  const world = worldAabbFromCorners(transformedCorners(stairs, stairClearanceLocalBounds(stairs)));
  return { min: cloneVec3(world.min), max: cloneVec3(world.max) };
}

function addCut(
  map: Map<string, SceneBoxCut[]>,
  hostId: string,
  cut: SceneBoxCut,
): void {
  const existing = map.get(hostId) ?? [];
  existing.push(cut);
  map.set(hostId, existing);
}

export function resolveSceneRelationships(project: LocationProject): SceneRelationshipResolution {
  const relationships: SceneSpatialRelationship[] = [];
  const cutsByHostId = new Map<string, SceneBoxCut[]>();
  const visible = project.scene.objects.filter((object) => object.visible !== false);
  const walls = visible.filter((object) => object.type === 'wall');

  for (const doorway of visible.filter((object) => object.type === 'doorway')) {
    const requestedHost = architectureRecord(doorway)?.hostWallId;
    let candidates = walls.filter((wall) => doorWallCompatible(doorway, wall));
    if (typeof requestedHost === 'string' && walls.some((wall) => wall.id === requestedHost)) {
      candidates = candidates.filter((wall) => wall.id === requestedHost);
    }

    if (candidates.length === 1) {
      const wall = candidates[0]!;
      const cut = projectedCut(wall, transformedCorners(doorway), 'z');
      if (cut) {
        addCut(cutsByHostId, wall.id, {
          ...cut,
          sourceId: doorway.id,
          kind: 'portal_host',
        });
        relationships.push({
          kind: 'portal_host',
          sourceId: doorway.id,
          targetId: wall.id,
          status: 'resolved',
        });
        continue;
      }
    }
    relationships.push({
      kind: 'portal_host',
      sourceId: doorway.id,
      status: candidates.length > 1 ? 'ambiguous' : 'unhosted',
      ...(candidates.length > 0 ? { candidateIds: candidates.map((wall) => wall.id) } : {}),
    });
  }

  const eligibleHorizontal = visible.filter(isEligibleHorizontalCutTarget);
  for (const stairs of visible.filter((object) => object.type === 'stairs')) {
    const clearanceCorners = transformedCorners(stairs, stairClearanceLocalBounds(stairs));
    const clearanceWorld = worldAabbFromCorners(clearanceCorners);
    const stairWorld = objectWorldAabb(stairs);
    const candidates = eligibleHorizontal
      .filter((target) => target.id !== stairs.id)
      .map((target) => {
        const targetWorld = objectWorldAabb(target);
        if (!clearanceWorld.intersectsBox(targetWorld)) return undefined;
        const cut = projectedCut(target, clearanceCorners, 'y');
        if (!cut) return undefined;
        const verticalDistance = Math.max(0, targetWorld.min.y - stairWorld.max.y);
        return { target, cut, verticalDistance };
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    if (candidates.length === 0) {
      relationships.push({
        kind: 'stair_clearance',
        sourceId: stairs.id,
        status: 'unhosted',
      });
      continue;
    }

    const nearestDistance = Math.min(...candidates.map((candidate) => candidate.verticalDistance));
    const nearestLayer = candidates.filter((candidate) => (
      candidate.verticalDistance <= nearestDistance + 0.3
    ));
    for (const candidate of nearestLayer) {
      addCut(cutsByHostId, candidate.target.id, {
        ...candidate.cut,
        sourceId: stairs.id,
        kind: 'stair_clearance',
      });
      relationships.push({
        kind: 'stair_clearance',
        sourceId: stairs.id,
        targetId: candidate.target.id,
        status: 'resolved',
      });
    }
  }

  return { relationships, cutsByHostId };
}

function overlaps(a: LocalBoxFragment, b: LocalBoxFragment): LocalBoxFragment | undefined {
  const overlap: LocalBoxFragment = {
    min: [
      Math.max(a.min[0], b.min[0]),
      Math.max(a.min[1], b.min[1]),
      Math.max(a.min[2], b.min[2]),
    ],
    max: [
      Math.min(a.max[0], b.max[0]),
      Math.min(a.max[1], b.max[1]),
      Math.min(a.max[2], b.max[2]),
    ],
  };
  if (
    overlap.max[0] - overlap.min[0] <= EPSILON
    || overlap.max[1] - overlap.min[1] <= EPSILON
    || overlap.max[2] - overlap.min[2] <= EPSILON
  ) return undefined;
  return overlap;
}

function subtractOne(fragment: LocalBoxFragment, cut: LocalBoxFragment): LocalBoxFragment[] {
  const overlap = overlaps(fragment, cut);
  if (!overlap) return [fragment];
  const result: LocalBoxFragment[] = [];
  const push = (min: Vec3, max: Vec3) => {
    if (
      max[0] - min[0] > EPSILON
      && max[1] - min[1] > EPSILON
      && max[2] - min[2] > EPSILON
    ) result.push({ min, max });
  };

  push(
    [fragment.min[0], fragment.min[1], fragment.min[2]],
    [overlap.min[0], fragment.max[1], fragment.max[2]],
  );
  push(
    [overlap.max[0], fragment.min[1], fragment.min[2]],
    [fragment.max[0], fragment.max[1], fragment.max[2]],
  );

  const xMin = Math.max(fragment.min[0], overlap.min[0]);
  const xMax = Math.min(fragment.max[0], overlap.max[0]);
  push(
    [xMin, fragment.min[1], fragment.min[2]],
    [xMax, overlap.min[1], fragment.max[2]],
  );
  push(
    [xMin, overlap.max[1], fragment.min[2]],
    [xMax, fragment.max[1], fragment.max[2]],
  );

  const yMin = Math.max(fragment.min[1], overlap.min[1]);
  const yMax = Math.min(fragment.max[1], overlap.max[1]);
  push(
    [xMin, yMin, fragment.min[2]],
    [xMax, yMax, overlap.min[2]],
  );
  push(
    [xMin, yMin, overlap.max[2]],
    [xMax, yMax, fragment.max[2]],
  );

  return result;
}

export function resolvedLocalBoxFragments(
  object: SceneObject,
  resolution: SceneRelationshipResolution,
): LocalBoxFragment[] {
  const cuts = resolution.cutsByHostId.get(object.id) ?? [];
  let fragments: LocalBoxFragment[] = [localBounds(object)];
  for (const cut of cuts) {
    fragments = fragments.flatMap((fragment) => subtractOne(fragment, cut));
  }
  return fragments;
}

export function localFragmentSize(fragment: LocalBoxFragment): Vec3 {
  return [
    fragment.max[0] - fragment.min[0],
    fragment.max[1] - fragment.min[1],
    fragment.max[2] - fragment.min[2],
  ];
}

export function localFragmentCenter(fragment: LocalBoxFragment): Vec3 {
  return [
    (fragment.min[0] + fragment.max[0]) / 2,
    (fragment.min[1] + fragment.max[1]) / 2,
    (fragment.min[2] + fragment.max[2]) / 2,
  ];
}

export function resolvedObjectWorldAabbs(
  object: SceneObject,
  resolution: SceneRelationshipResolution,
): Array<{ min: Vec3; max: Vec3 }> {
  const matrix = objectMatrix(object);
  return resolvedLocalBoxFragments(object, resolution).map((fragment) => {
    const world = new THREE.Box3().setFromPoints(
      corners(fragment).map((corner) => corner.applyMatrix4(matrix)),
    );
    return {
      min: cloneVec3(world.min),
      max: cloneVec3(world.max),
    };
  });
}

export function relationshipForSource(
  resolution: SceneRelationshipResolution,
  sourceId: string,
  kind?: SceneRelationshipKind,
): SceneSpatialRelationship[] {
  return resolution.relationships.filter((relationship) => (
    relationship.sourceId === sourceId
    && (kind === undefined || relationship.kind === kind)
  ));
}

export function relationshipsForObject(
  resolution: SceneRelationshipResolution,
  objectId: string,
): SceneSpatialRelationship[] {
  return resolution.relationships.filter((relationship) => (
    relationship.sourceId === objectId
    || relationship.targetId === objectId
    || relationship.candidateIds?.includes(objectId)
  ));
}
