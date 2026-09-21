import * as vm from 'node:vm';
import { createSceneObject } from '../../src/domain/defaults';
import type { LocationProject, SceneObject } from '../../src/domain/types';
import {
  AGENT_CREATABLE_OBJECT_TYPES,
  AGENT_PLAN_LIMITS,
  AGENT_UPRIGHT_OBJECT_TYPES,
} from '../../src/engine/agent/constants';
import { projectFingerprint } from '../../src/engine/agent/planDiff';
import type { ForeSceneAgentCommand, ForeSceneAgentPlan } from '../../src/engine/agent/protocol';

export const AGENT_SCRIPT_LIMITS = {
  maxSourceBytes: 128 * 1024,
  defaultTimeoutMs: 2_000,
  maxTimeoutMs: 5_000,
} as const;

export interface AgentScriptCompileOptions {
  fileName?: string;
  timeoutMs?: number;
}

export interface AgentScriptCompileResult {
  plan: ForeSceneAgentPlan;
  sourceBytes: number;
  commandCount: number;
  expandedCommandCount: number;
  timeoutMs: number;
}

interface RawAgentScriptResult {
  description?: string;
  commands: ForeSceneAgentCommand[];
  expandedCommandCount: number;
}

type PrimitiveTemplate = Pick<
  SceneObject,
  'name' | 'type' | 'transform' | 'dimensions' | 'category' | 'locked' | 'visible' | 'stagingRole' | 'poseableCharacter'
>;

function resolveTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? AGENT_SCRIPT_LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Agent script timeout must be a positive finite number.');
  }
  return Math.min(Math.floor(timeoutMs), AGENT_SCRIPT_LIMITS.maxTimeoutMs);
}

function primitiveTemplates(): Record<string, PrimitiveTemplate> {
  return Object.fromEntries(AGENT_CREATABLE_OBJECT_TYPES.map((type) => {
    const object = createSceneObject(type, 1);
    return [type, {
      name: object.name,
      type: object.type,
      transform: structuredClone(object.transform),
      dimensions: [...object.dimensions],
      category: object.category,
      locked: object.locked,
      visible: object.visible,
      stagingRole: object.stagingRole,
      ...(object.poseableCharacter ? { poseableCharacter: structuredClone(object.poseableCharacter) } : {}),
    } satisfies PrimitiveTemplate];
  }));
}

function buildProgram(
  projectJson: string,
  templatesJson: string,
  uprightTypesJson: string,
  source: string,
): string {
  return `(() => {
    "use strict";
    const __commands = [];
    let __expandedCount = 0;
    const __counts = { object: 0, shot: 0, landmark: 0 };
    let __description;
    const __shadow = ${projectJson};
    const __templates = ${templatesJson};
    const __uprightTypes = new Set(${uprightTypesJson});

    function __clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function __deepFreeze(value) {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) __deepFreeze(value[key]);
      }
      return value;
    }

    function __snapshot(value) {
      return __deepFreeze(__clone(value));
    }

    function __commandCost(command) {
      if (command.op === 'object.createMany' || command.op === 'object.updateMany') {
        return command.items.length;
      }
      if (command.op === 'object.duplicateMany') {
        return command.items.reduce((sum, item) => sum + 1 + (item.updates ? 1 : 0), 0);
      }
      return 1;
    }

    function __emit(command) {
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        throw new TypeError('ForeScene script commands must be objects.');
      }
      if (__commands.length >= ${AGENT_PLAN_LIMITS.maxCommands}) {
        throw new Error('ForeScene script top-level command limit exceeded (${AGENT_PLAN_LIMITS.maxCommands}). Use bulk helpers or split the work.');
      }
      const cost = __commandCost(command);
      if (__expandedCount + cost > ${AGENT_PLAN_LIMITS.maxExpandedCommands}) {
        throw new Error('ForeScene script expanded command limit exceeded (${AGENT_PLAN_LIMITS.maxExpandedCommands}). Split the work.');
      }
      __expandedCount += cost;
      __commands.push(command);
      return command;
    }

    function __assertBulkCount(items, operation) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error(operation + ' requires at least one item.');
      }
      if (items.length > ${AGENT_PLAN_LIMITS.maxBulkItems}) {
        throw new Error(operation + ' supports at most ${AGENT_PLAN_LIMITS.maxBulkItems} items.');
      }
    }

    function __nextRef(kind) {
      __counts[kind] += 1;
      return 'script_' + kind + '_' + __counts[kind];
    }

    function __target(value) {
      if (typeof value === 'string') return { id: value };
      if (!value || typeof value !== 'object') {
        throw new TypeError('Expected an entity id, ref, shotNumber, query, or shadow entity.');
      }
      if (typeof value.ref === 'string') return { ref: value.ref };
      if (typeof value.id === 'string') return { id: value.id };
      if (typeof value.shotNumber === 'string') return { shotNumber: value.shotNumber };
      if (value.query && typeof value.query === 'object') return { query: { ...value.query } };
      throw new TypeError('Target has no id, ref, shotNumber, or query.');
    }

    function __matches(value, query) {
      if (!query || typeof query !== 'object') return true;
      const mode = query.match === 'contains' ? 'contains' : 'exact';
      for (const [key, expected] of Object.entries(query)) {
        if (key === 'match' || expected === undefined) continue;
        const actual = value[key];
        if (key === 'name') {
          const left = String(actual ?? '').toLowerCase();
          const right = String(expected).toLowerCase();
          if (mode === 'contains' ? !left.includes(right) : left !== right) return false;
        } else if (actual !== expected) {
          return false;
        }
      }
      return true;
    }

    function __collection(kind) {
      if (kind === 'object') return __shadow.scene.objects;
      if (kind === 'shot') return __shadow.shots;
      if (kind === 'landmark') return __shadow.landmarks;
      throw new Error('Unsupported shadow entity kind: ' + kind);
    }

    function __resolve(kind, value) {
      const targetValue = __target(value);
      const values = __collection(kind);
      if (targetValue.ref) {
        const found = values.find((item) => item.ref === targetValue.ref);
        if (!found) throw new Error('No ' + kind + ' with ref "' + targetValue.ref + '" in shadow project.');
        return found;
      }
      if (targetValue.id) {
        const found = values.find((item) => item.id === targetValue.id);
        if (!found) throw new Error('No ' + kind + ' with id "' + targetValue.id + '" in shadow project.');
        return found;
      }
      if (targetValue.shotNumber) {
        const found = values.find((item) => item.shotNumber === targetValue.shotNumber);
        if (!found) throw new Error('No ' + kind + ' with shotNumber "' + targetValue.shotNumber + '" in shadow project.');
        return found;
      }
      const matches = values.filter((item) => __matches(item, targetValue.query));
      if (matches.length !== 1) {
        throw new Error('Expected exactly one ' + kind + ' query match; found ' + matches.length + '.');
      }
      return matches[0];
    }

    function __baseName(templateName) {
      return String(templateName).replace(/\s+1$/, '');
    }

    function __actualCreatePosition(type, dimensions, requested, scale) {
      const height = dimensions[1] * scale[1];
      if (type === 'floor') return [requested[0], requested[1] - height / 2, requested[2]];
      if (__uprightTypes.has(type)) return [requested[0], requested[1] + height / 2, requested[2]];
      return [...requested];
    }

    function __makeShadowObject(type, options, ref) {
      const template = __templates[type];
      if (!template) throw new Error('Unsupported creatable object type: ' + type);
      const index = __shadow.scene.objects.filter((object) => object.type === type).length + 1;
      const dimensions = options.dimensions ? [...options.dimensions] : [...template.dimensions];
      const scale = options.scale ? [...options.scale] : [...template.transform.scale];
      const requestedPosition = options.position ? [...options.position] : [0, 0, 0];
      const object = {
        ...__clone(template),
        id: '__script_object__' + ref,
        ref,
        name: options.name ?? (__baseName(template.name) + ' ' + index),
        dimensions,
        ...(options.stagingRole ? { stagingRole: options.stagingRole } : {}),
        transform: {
          position: __actualCreatePosition(type, dimensions, requestedPosition, scale),
          rotation: options.rotation ? [...options.rotation] : [...template.transform.rotation],
          scale,
        },
      };
      __shadow.scene.objects.push(object);
      return object;
    }

    function __applyObjectUpdates(object, updates) {
      if (!updates || typeof updates !== 'object') throw new TypeError('Object updates must be an object.');
      for (const key of ['name', 'visible', 'locked', 'stagingRole', 'color', 'secondaryColor']) {
        if (updates[key] !== undefined) object[key] = __clone(updates[key]);
      }
      if (Array.isArray(updates.dimensions)) object.dimensions = [...updates.dimensions];
      if (updates.transform && typeof updates.transform === 'object') {
        object.transform = __clone(updates.transform);
      }
      for (const key of ['position', 'rotation', 'scale']) {
        if (Array.isArray(updates[key])) object.transform[key] = [...updates[key]];
      }
      return object;
    }

    function __duplicateShadow(sourceValue, ref, updates) {
      const source = __resolve('object', sourceValue);
      const index = __shadow.scene.objects.filter((object) => object.type === source.type).length + 1;
      const duplicate = {
        ...__clone(source),
        id: '__script_object__' + ref,
        ref,
        name: __baseName(__templates[source.type]?.name ?? source.type) + ' ' + index,
        locked: false,
        visible: true,
        transform: {
          ...__clone(source.transform),
          position: [
            source.transform.position[0] + 0.75,
            source.transform.position[1],
            source.transform.position[2] + 0.75,
          ],
        },
      };
      if (updates) __applyObjectUpdates(duplicate, updates);
      __shadow.scene.objects.push(duplicate);
      return duplicate;
    }

    function __degrees(value) {
      return (value * Math.PI) / 180;
    }

    function __rotatePoint(point, rotation) {
      let [x, y, z] = point;
      const rx = __degrees(rotation[0] ?? 0);
      const ry = __degrees(rotation[1] ?? 0);
      const rz = __degrees(rotation[2] ?? 0);
      let c = Math.cos(rx), s = Math.sin(rx);
      [y, z] = [y * c - z * s, y * s + z * c];
      c = Math.cos(ry); s = Math.sin(ry);
      [x, z] = [x * c + z * s, -x * s + z * c];
      c = Math.cos(rz); s = Math.sin(rz);
      [x, y] = [x * c - y * s, x * s + y * c];
      return [x, y, z];
    }

    function __bounds(value) {
      const object = __resolve('object', value);
      const half = [
        Math.abs(object.dimensions[0] * object.transform.scale[0]) / 2,
        Math.abs(object.dimensions[1] * object.transform.scale[1]) / 2,
        Math.abs(object.dimensions[2] * object.transform.scale[2]) / 2,
      ];
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const local = [half[0] * sx, half[1] * sy, half[2] * sz];
        const rotated = __rotatePoint(local, object.transform.rotation);
        for (let axis = 0; axis < 3; axis += 1) {
          const world = rotated[axis] + object.transform.position[axis];
          min[axis] = Math.min(min[axis], world);
          max[axis] = Math.max(max[axis], world);
        }
      }
      return {
        min,
        max,
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      };
    }

    function __pointDistanceToBounds(point, bounds) {
      let sum = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const delta = point[axis] < bounds.min[axis]
          ? bounds.min[axis] - point[axis]
          : point[axis] > bounds.max[axis]
            ? point[axis] - bounds.max[axis]
            : 0;
        sum += delta * delta;
      }
      return Math.sqrt(sum);
    }

    function __distance(aValue, bValue) {
      const a = __bounds(aValue);
      const b = __bounds(bValue);
      let sum = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const delta = a.max[axis] < b.min[axis]
          ? b.min[axis] - a.max[axis]
          : b.max[axis] < a.min[axis]
            ? a.min[axis] - b.max[axis]
            : 0;
        sum += delta * delta;
      }
      return Math.sqrt(sum);
    }

    function __intersects(aValue, bValue) {
      const a = __bounds(aValue);
      const b = __bounds(bValue);
      return [0, 1, 2].every((axis) => a.min[axis] <= b.max[axis] && a.max[axis] >= b.min[axis]);
    }

    function __updateOne(value, updates, emit = true) {
      const object = __resolve('object', value);
      __applyObjectUpdates(object, updates);
      if (emit) __emit({ op: 'object.update', object: __target(value), updates: __clone(updates) });
      return __snapshot(object);
    }

    function __updateMany(values, updatesOrFactory) {
      __assertBulkCount(values, 'scene.updateMany');
      const items = values.map((value, index) => {
        const object = __resolve('object', value);
        const updates = typeof updatesOrFactory === 'function'
          ? updatesOrFactory(__snapshot(object), index)
          : updatesOrFactory;
        __applyObjectUpdates(object, updates);
        return { object: __target(value), updates: __clone(updates) };
      });
      __emit({ op: 'object.updateMany', items });
      return values.map((value) => __snapshot(__resolve('object', value)));
    }

    Object.defineProperty(globalThis, 'project', {
      configurable: false,
      enumerable: true,
      get: () => __snapshot(__shadow),
    });

    const target = __deepFreeze({
      id: (id) => __deepFreeze({ id: String(id) }),
      ref: (ref) => __deepFreeze({ ref: String(ref) }),
      shotNumber: (shotNumber) => __deepFreeze({ shotNumber: String(shotNumber) }),
      query: (query) => __deepFreeze({ query: { ...query } }),
    });

    const scene = __deepFreeze({
      list: () => __snapshot(__shadow.scene.objects),
      find: (query) => {
        const value = __shadow.scene.objects.find((item) => __matches(item, query));
        return value ? __snapshot(value) : undefined;
      },
      findAll: (query) => __snapshot(__shadow.scene.objects.filter((item) => __matches(item, query))),
      require(query) {
        const values = __shadow.scene.objects.filter((item) => __matches(item, query));
        if (values.length !== 1) throw new Error('Expected exactly one scene object matching ' + JSON.stringify(query) + '; found ' + values.length + '.');
        return __snapshot(values[0]);
      },
      create(type, options = {}) {
        const createdRef = typeof options.ref === 'string' ? options.ref : __nextRef('object');
        const normalized = { ...options, position: options.position ?? [0, 0, 0] };
        const object = __makeShadowObject(type, normalized, createdRef);
        const { ref: _ref, ...payload } = normalized;
        __emit({ op: 'object.create', ref: createdRef, object: { ...payload, type } });
        return __snapshot(object);
      },
      createMany(type, entries) {
        __assertBulkCount(entries, 'scene.createMany');
        const items = entries.map((options = {}) => {
          const createdRef = typeof options.ref === 'string' ? options.ref : __nextRef('object');
          const normalized = { ...options, position: options.position ?? [0, 0, 0] };
          __makeShadowObject(type, normalized, createdRef);
          const { ref: _ref, ...payload } = normalized;
          return { ref: createdRef, object: { ...payload, type } };
        });
        __emit({ op: 'object.createMany', items });
        return __snapshot(items.map((item) => __resolve('object', { ref: item.ref })));
      },
      update(object, updates) {
        return __updateOne(object, updates);
      },
      updateMany(objects, updatesOrFactory) {
        return __updateMany(objects, updatesOrFactory);
      },
      delete(object) {
        const resolved = __resolve('object', object);
        const targetValue = __target(object);
        __shadow.scene.objects = __shadow.scene.objects.filter((candidate) => candidate !== resolved);
        __emit({ op: 'object.delete', object: targetValue });
      },
      duplicate(object, options = {}) {
        const createdRef = typeof options.ref === 'string' ? options.ref : __nextRef('object');
        const duplicate = __duplicateShadow(object, createdRef, options.updates);
        __emit({
          op: 'object.duplicateMany',
          items: [{
            object: __target(object),
            ref: createdRef,
            ...(options.updates ? { updates: __clone(options.updates) } : {}),
          }],
        });
        return __snapshot(duplicate);
      },
      duplicateMany(object, copies) {
        __assertBulkCount(copies, 'scene.duplicateMany');
        const items = copies.map((options = {}) => {
          const createdRef = typeof options.ref === 'string' ? options.ref : __nextRef('object');
          __duplicateShadow(object, createdRef, options.updates);
          return {
            object: __target(object),
            ref: createdRef,
            ...(options.updates ? { updates: __clone(options.updates) } : {}),
          };
        });
        __emit({ op: 'object.duplicateMany', items });
        return __snapshot(items.map((item) => __resolve('object', { ref: item.ref })));
      },
      bounds(object) {
        return __snapshot(__bounds(object));
      },
      distance(a, b) {
        return __distance(a, b);
      },
      intersects(a, b) {
        return __intersects(a, b);
      },
      nearest(query, position) {
        const values = __shadow.scene.objects.filter((item) => __matches(item, query));
        let best;
        let bestDistance = Infinity;
        for (const value of values) {
          const distance = __pointDistanceToBounds(position, __bounds(value));
          if (distance < bestDistance) {
            best = value;
            bestDistance = distance;
          }
        }
        return best ? __snapshot(best) : undefined;
      },
      placeOn(object, surface, options = {}) {
        const moving = __resolve('object', object);
        const movingBounds = __bounds(moving);
        const surfaceBounds = __bounds(surface);
        const gap = Number(options.gap ?? 0);
        const nextY = moving.transform.position[1] + (surfaceBounds.max[1] + gap - movingBounds.min[1]);
        return __updateOne(object, { position: [moving.transform.position[0], nextY, moving.transform.position[2]] });
      },
      align(object, targetObject, options = {}) {
        const axisName = options.axis ?? 'x';
        const axis = axisName === 'y' ? 1 : axisName === 'z' ? 2 : 0;
        const sourceAnchor = options.source ?? 'center';
        const targetAnchor = options.target ?? 'center';
        const sourceBounds = __bounds(object);
        const targetBounds = __bounds(targetObject);
        const anchorValue = (bounds, anchor) => anchor === 'min' ? bounds.min[axis] : anchor === 'max' ? bounds.max[axis] : bounds.center[axis];
        const delta = anchorValue(targetBounds, targetAnchor) - anchorValue(sourceBounds, sourceAnchor) + Number(options.offset ?? 0);
        const moving = __resolve('object', object);
        const position = [...moving.transform.position];
        position[axis] += delta;
        return __updateOne(object, { position });
      },
      lookAt(object, targetObject, options = {}) {
        const moving = __resolve('object', object);
        const a = __bounds(moving).center;
        const b = __bounds(targetObject).center;
        const yaw = Math.atan2(b[0] - a[0], b[2] - a[2]) * 180 / Math.PI + Number(options.yawOffsetDegrees ?? 0);
        const rotation = [...moving.transform.rotation];
        rotation[1] = yaw;
        return __updateOne(object, { rotation });
      },
      distribute(objects, options = {}) {
        if (!Array.isArray(objects) || objects.length < 2) throw new Error('scene.distribute requires at least two objects.');
        const axisName = options.axis ?? 'x';
        const axis = axisName === 'y' ? 1 : axisName === 'z' ? 2 : 0;
        const resolved = objects.map((object) => __resolve('object', object));
        const start = Number(options.start ?? resolved[0].transform.position[axis]);
        const end = options.end !== undefined ? Number(options.end) : undefined;
        const spacing = end !== undefined
          ? (end - start) / (resolved.length - 1)
          : Number(options.spacing ?? 1);
        return __updateMany(objects, (_object, index) => {
          const live = resolved[index];
          const position = [...live.transform.position];
          position[axis] = start + spacing * index;
          return { position };
        });
      },
      linearArray(object, options = {}) {
        const count = Math.floor(Number(options.count ?? 0));
        if (!(count > 0)) throw new Error('scene.linearArray requires count > 0.');
        if (count > ${AGENT_PLAN_LIMITS.maxBulkItems}) throw new Error('scene.linearArray count exceeds bulk limit.');
        const sourceObject = __resolve('object', object);
        const offset = options.offset ?? [1, 0, 0];
        const copies = Array.from({ length: count }, (_, index) => {
          const step = index + 1;
          const updates = {
            position: [
              sourceObject.transform.position[0] + offset[0] * step,
              sourceObject.transform.position[1] + offset[1] * step,
              sourceObject.transform.position[2] + offset[2] * step,
            ],
            ...(options.namePrefix ? { name: String(options.namePrefix) + ' ' + (step + 1) } : {}),
          };
          return { updates };
        });
        return this.duplicateMany(object, copies);
      },
      radialArray(object, options = {}) {
        const count = Math.floor(Number(options.count ?? 0));
        const radius = Number(options.radius ?? 0);
        if (!(count > 0) || !(radius >= 0)) throw new Error('scene.radialArray requires count > 0 and radius >= 0.');
        if (count > ${AGENT_PLAN_LIMITS.maxBulkItems}) throw new Error('scene.radialArray count exceeds bulk limit.');
        const sourceObject = __resolve('object', object);
        const center = options.center ?? [0, sourceObject.transform.position[1], 0];
        const start = Number(options.startAngleDegrees ?? 0) * Math.PI / 180;
        const copies = Array.from({ length: count }, (_, index) => {
          const angle = start + (index / count) * Math.PI * 2;
          const position = [
            center[0] + Math.sin(angle) * radius,
            center[1],
            center[2] + Math.cos(angle) * radius,
          ];
          const updates = {
            position,
            ...(options.faceCenter ? {
              rotation: [
                sourceObject.transform.rotation[0],
                Math.atan2(center[0] - position[0], center[2] - position[2]) * 180 / Math.PI,
                sourceObject.transform.rotation[2],
              ],
            } : {}),
            ...(options.namePrefix ? { name: String(options.namePrefix) + ' ' + (index + 1) } : {}),
          };
          return { updates };
        });
        return this.duplicateMany(object, copies);
      },
    });

    const shots = __deepFreeze({
      list: () => __snapshot(__shadow.shots),
      find: (query) => {
        const value = __shadow.shots.find((item) => __matches(item, query));
        return value ? __snapshot(value) : undefined;
      },
      findAll: (query) => __snapshot(__shadow.shots.filter((item) => __matches(item, query))),
      require(query) {
        const values = __shadow.shots.filter((item) => __matches(item, query));
        if (values.length !== 1) throw new Error('Expected exactly one shot matching ' + JSON.stringify(query) + '; found ' + values.length + '.');
        return __snapshot(values[0]);
      },
      create(options = {}) {
        const ref = typeof options.ref === 'string' ? options.ref : __nextRef('shot');
        const index = __shadow.shots.length + 1;
        const origin = __shadow.scene.panoOrigin ?? [0, 1.65, 0];
        const shotNumber = options.shotNumber ?? String(index).padStart(3, '0');
        const baseCamera = {
          position: [...origin],
          target: [origin[0], origin[1], origin[2] + 10],
          fovDegrees: __shadow.settings.defaultShotFovDegrees,
          aspectRatio: 16 / 9,
          near: 0.01,
          far: 100,
        };
        const shot = {
          id: '__script_shot__' + ref,
          ref,
          shotNumber,
          name: options.name ?? ('Shot ' + shotNumber),
          description: options.description ?? '',
          camera: { ...baseCamera, ...(options.camera ?? {}) },
          cameraKeyframes: [],
          objectOverrides: {},
          landmarkIds: [],
          status: 'planned',
        };
        __shadow.shots.push(shot);
        const { ref: _ref, ...payload } = options;
        __emit({ op: 'shot.create', ref, shot: payload });
        return __snapshot(shot);
      },
      rename(shotValue, name) {
        const shot = __resolve('shot', shotValue);
        shot.name = name;
        __emit({ op: 'shot.rename', shot: __target(shotValue), name });
        return __snapshot(shot);
      },
      describe(shotValue, description) {
        const shot = __resolve('shot', shotValue);
        shot.description = description;
        __emit({ op: 'shot.updateDescription', shot: __target(shotValue), description });
        return __snapshot(shot);
      },
      camera(shotValue, camera) {
        const shot = __resolve('shot', shotValue);
        shot.camera = { ...shot.camera, ...__clone(camera) };
        __emit({ op: 'shot.updateCamera', shot: __target(shotValue), camera: __clone(camera) });
        return __snapshot(shot);
      },
      frameSubjects(shotValue, subjects, composition) {
        __emit({
          op: 'shot.frameSubjects',
          shot: __target(shotValue),
          subjects: subjects.map(__target),
          ...(composition ? { composition } : {}),
        });
      },
      stage(shotValue, object, options = {}) {
        __emit({ op: 'shot.stageObject', shot: __target(shotValue), object: __target(object), ...options });
      },
      clearStaging(shotValue, object) {
        __emit({
          op: 'shot.clearStaging',
          shot: __target(shotValue),
          ...(object ? { object: __target(object) } : {}),
        });
      },
      delete(shotValue) {
        const shot = __resolve('shot', shotValue);
        __shadow.shots = __shadow.shots.filter((candidate) => candidate !== shot);
        __emit({ op: 'shot.delete', shot: __target(shotValue) });
      },
    });

    const landmarks = __deepFreeze({
      list: () => __snapshot(__shadow.landmarks),
      find: (query) => {
        const value = __shadow.landmarks.find((item) => __matches(item, query));
        return value ? __snapshot(value) : undefined;
      },
      findAll: (query) => __snapshot(__shadow.landmarks.filter((item) => __matches(item, query))),
      require(query) {
        const values = __shadow.landmarks.filter((item) => __matches(item, query));
        if (values.length !== 1) throw new Error('Expected exactly one landmark matching ' + JSON.stringify(query) + '; found ' + values.length + '.');
        return __snapshot(values[0]);
      },
      create(options = {}) {
        const ref = typeof options.ref === 'string' ? options.ref : __nextRef('landmark');
        const index = __shadow.landmarks.length + 1;
        const landmark = {
          id: '__script_landmark__' + ref,
          ref,
          name: options.name ?? ('landmark_' + index),
          displayName: options.displayName ?? ('Landmark ' + index),
          position: options.position ? [...options.position] : [0, 1.2, 0],
          description: options.description ?? '',
          tags: options.tags ? [...options.tags] : [],
          promptCritical: options.promptCritical ?? true,
          visible: options.visible ?? true,
          ...(options.linkedObjectId ? { linkedObjectId: options.linkedObjectId } : {}),
        };
        __shadow.landmarks.push(landmark);
        const { ref: _ref, ...payload } = options;
        __emit({ op: 'landmark.create', ref, landmark: payload });
        return __snapshot(landmark);
      },
      update(landmarkValue, updates) {
        const landmark = __resolve('landmark', landmarkValue);
        Object.assign(landmark, __clone(updates));
        __emit({ op: 'landmark.update', landmark: __target(landmarkValue), updates: __clone(updates) });
        return __snapshot(landmark);
      },
      link(landmarkValue, object) {
        const landmark = __resolve('landmark', landmarkValue);
        landmark.linkedObjectId = object === null ? undefined : (__resolve('object', object).id);
        __emit({
          op: 'landmark.linkObject',
          landmark: __target(landmarkValue),
          object: object === null ? null : __target(object),
        });
        return __snapshot(landmark);
      },
      delete(landmarkValue) {
        const landmark = __resolve('landmark', landmarkValue);
        __shadow.landmarks = __shadow.landmarks.filter((candidate) => candidate !== landmark);
        __emit({ op: 'landmark.delete', landmark: __target(landmarkValue) });
      },
    });

    const workspace = __deepFreeze({
      open(value) {
        __emit({ op: 'workspace.open', workspace: value });
      },
    });

    const plan = __deepFreeze({
      description(value) {
        __description = String(value);
      },
      command(command) {
        return __emit(__clone(command));
      },
    });

    ${source}

    return JSON.stringify({
      ...(__description ? { description: __description } : {}),
      commands: __commands,
      expandedCommandCount: __expandedCount,
    });
  })()`;
}

function parseResult(serialized: unknown): RawAgentScriptResult {
  if (typeof serialized !== 'string') {
    throw new Error('ForeScene agent script did not produce a serialized plan.');
  }
  const parsed = JSON.parse(serialized) as Partial<RawAgentScriptResult>;
  if (!Array.isArray(parsed.commands)) {
    throw new Error('ForeScene agent script did not produce a command array.');
  }
  if (parsed.commands.length > AGENT_PLAN_LIMITS.maxCommands) {
    throw new Error(`ForeScene agent script produced ${parsed.commands.length} top-level commands; maximum is ${AGENT_PLAN_LIMITS.maxCommands}.`);
  }
  if (
    typeof parsed.expandedCommandCount !== 'number'
    || !Number.isFinite(parsed.expandedCommandCount)
    || parsed.expandedCommandCount > AGENT_PLAN_LIMITS.maxExpandedCommands
  ) {
    throw new Error('ForeScene agent script produced an invalid expanded command count.');
  }
  if (parsed.description !== undefined && typeof parsed.description !== 'string') {
    throw new Error('ForeScene agent script description must be a string.');
  }
  return parsed as RawAgentScriptResult;
}

export function compileAgentScript(
  source: string,
  project: LocationProject,
  options: AgentScriptCompileOptions = {},
): AgentScriptCompileResult {
  if (typeof source !== 'string') throw new TypeError('Agent script source must be a string.');
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > AGENT_SCRIPT_LIMITS.maxSourceBytes) {
    throw new Error(`Agent script is ${sourceBytes} bytes; maximum is ${AGENT_SCRIPT_LIMITS.maxSourceBytes}.`);
  }
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const projectJson = JSON.stringify(project);
  if (!projectJson) throw new Error('Could not serialize the current ForeScene project for scripting.');

  const templatesJson = JSON.stringify(primitiveTemplates());
  const uprightTypesJson = JSON.stringify([...AGENT_UPRIGHT_OBJECT_TYPES]);
  const context = vm.createContext(Object.create(null), {
    name: 'ForeScene Agent Script',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });

  let raw: unknown;
  try {
    raw = new vm.Script(buildProgram(projectJson, templatesJson, uprightTypesJson, source), {
      filename: options.fileName ?? 'forescene-agent-script.js',
    }).runInContext(context, { timeout: timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ForeScene agent script failed: ${message}`);
  }

  const result = parseResult(raw);
  const plan: ForeSceneAgentPlan = {
    version: 1,
    ...(result.description ? { description: result.description } : {}),
    expectedFingerprint: projectFingerprint(project),
    commands: result.commands,
  };
  return {
    plan,
    sourceBytes,
    commandCount: result.commands.length,
    expandedCommandCount: result.expandedCommandCount,
    timeoutMs,
  };
}
