import type { SceneObject, Vec3 } from '../domain/types';
import { snapBuildPoint } from './sandboxCore';

export type SelectionMode = 'replace' | 'toggle' | 'range';

export function normalizeSelectedIds(ids: string[], objects: SceneObject[]): string[] {
  const valid = new Set(objects.map((object) => object.id));
  return [...new Set(ids)].filter((id) => valid.has(id));
}

export function toggleSelectedId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

/**
 * World-space center of the same transformed AABBs used by the Three.js
 * selection bounds. Kept dependency-free so store initialization does not load
 * the renderer bundle.
 */
export function selectionPivot(objects: SceneObject[]): Vec3 {
  if (objects.length === 0) return [0, 0, 0];

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const object of objects) {
    const half: Vec3 = [
      (object.dimensions[0] * object.transform.scale[0]) / 2,
      (object.dimensions[1] * object.transform.scale[1]) / 2,
      (object.dimensions[2] * object.transform.scale[2]) / 2,
    ];
    for (const x of [-half[0], half[0]]) {
      for (const y of [-half[1], half[1]]) {
        for (const z of [-half[2], half[2]]) {
          const point = rotateEulerXyz([x, y, z], object.transform.rotation);
          const worldX = point[0] + object.transform.position[0];
          const worldY = point[1] + object.transform.position[1];
          const worldZ = point[2] + object.transform.position[2];
          minX = Math.min(minX, worldX);
          minY = Math.min(minY, worldY);
          minZ = Math.min(minZ, worldZ);
          maxX = Math.max(maxX, worldX);
          maxY = Math.max(maxY, worldY);
          maxZ = Math.max(maxZ, worldZ);
        }
      }
    }
  }

  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

export function translateSelectedObjects(
  objects: SceneObject[],
  selectedIds: string[],
  delta: Vec3,
  snapToGrid: boolean,
): SceneObject[] {
  const selected = new Set(selectedIds);
  return objects.map((object) => {
    if (!selected.has(object.id)) return object;
    const raw: Vec3 = [
      object.transform.position[0] + delta[0],
      object.transform.position[1] + delta[1],
      object.transform.position[2] + delta[2],
    ];
    const horizontal = snapBuildPoint(raw, snapToGrid);
    return {
      ...object,
      transform: { ...object.transform, position: [horizontal[0], raw[1], horizontal[2]] },
    };
  });
}

export function rotateSelectedObjects(
  objects: SceneObject[],
  selectedIds: string[],
  axis: 'x' | 'y' | 'z',
  deltaDegrees: number,
  pivot = selectionPivot(objects.filter((object) => selectedIds.includes(object.id))),
): SceneObject[] {
  const selected = new Set(selectedIds);
  const radians = deltaDegrees * Math.PI / 180;
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  return objects.map((object) => {
    if (!selected.has(object.id)) return object;
    const relative: Vec3 = [
      object.transform.position[0] - pivot[0],
      object.transform.position[1] - pivot[1],
      object.transform.position[2] - pivot[2],
    ];
    const rotated = rotateAroundAxis(relative, axis, radians);
    const rotation = [...object.transform.rotation] as Vec3;
    rotation[index] = normalizeDegrees(rotation[index] + deltaDegrees);
    return {
      ...object,
      transform: {
        ...object.transform,
        position: [rotated[0] + pivot[0], rotated[1] + pivot[1], rotated[2] + pivot[2]],
        rotation,
      },
    };
  });
}

export function scaleSelectedObjects(
  objects: SceneObject[],
  selectedIds: string[],
  factors: Vec3,
  pivot = selectionPivot(objects.filter((object) => selectedIds.includes(object.id))),
): SceneObject[] {
  const selected = new Set(selectedIds);
  return objects.map((object) => {
    if (!selected.has(object.id)) return object;
    const relative = object.transform.position.map((value, index) => value - pivot[index]) as Vec3;
    const position = relative.map((value, index) => pivot[index] + value * factors[index]) as Vec3;
    const dimensions = object.dimensions.map((value, index) => (
      Math.max(0.05, Number((value * factors[index]).toFixed(3)))
    )) as Vec3;
    return { ...object, transform: { ...object.transform, position }, dimensions };
  });
}

function rotateEulerXyz(point: Vec3, degrees: Vec3): Vec3 {
  const x = degrees[0] * Math.PI / 180;
  const y = degrees[1] * Math.PI / 180;
  const z = degrees[2] * Math.PI / 180;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;

  const ix = qw * point[0] + qy * point[2] - qz * point[1];
  const iy = qw * point[1] + qz * point[0] - qx * point[2];
  const iz = qw * point[2] + qx * point[1] - qy * point[0];
  const iw = -qx * point[0] - qy * point[1] - qz * point[2];
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function rotateAroundAxis(point: Vec3, axis: 'x' | 'y' | 'z', radians: number): Vec3 {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  if (axis === 'x') return [point[0], point[1] * cosine - point[2] * sine, point[1] * sine + point[2] * cosine];
  if (axis === 'y') return [point[0] * cosine + point[2] * sine, point[1], -point[0] * sine + point[2] * cosine];
  return [point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine, point[2]];
}

function normalizeDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}
