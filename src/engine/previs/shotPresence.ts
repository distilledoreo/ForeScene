/**
 * Closed-world shot presence contracts.
 *
 * A shot's visibility is a production postcondition, not merely a list of
 * objects mentioned by the manifest compiler. This module deliberately works
 * from the complete project scene so imported or previously authored dynamic
 * objects cannot leak into a shot through global visibility or a timeline
 * snapshot.
 */

import type {
  LocationProject,
  ProductionObjectClass,
  SceneObject,
  Shot,
  ShotObjectOverrides,
  ShotPresenceContract,
} from '../../domain/types';
import { getSortedCameraKeyframes } from '../cameraKeyframes';
import { interpolateObjectOverrides } from '../objectKeyframes';
import {
  classifyProductionObject,
  getProductionConfiguration,
} from './productionConfiguration';
import { resolveSceneObjectsForShot, updateShotObjectOverrides } from '../shotSceneState';

export const SHOT_PRESENCE_FAILURE_CODES = [
  'unexpected_dynamic_object',
  'expected_dynamic_object_missing',
  'expected_dynamic_object_hidden',
  'partial_group_visibility',
  'unclassified_dynamic_object',
  'dynamic_presence_changed_over_time',
] as const;

export type ShotPresenceDiagnosticCode =
  | (typeof SHOT_PRESENCE_FAILURE_CODES)[number]
  | 'shot_missing'
  | 'presence_contract_missing';

export interface ShotPresenceDiagnostic {
  code: ShotPresenceDiagnosticCode;
  message: string;
  shotId?: string;
  objectId?: string;
  groupId?: string;
  sampleTimeSeconds?: number;
}

export interface DynamicObjectDescriptor {
  objectId: string;
  classification: ProductionObjectClass;
  groupIds: string[];
}

export interface ShotPresenceResolution {
  contractPresent: boolean;
  allowUnspecifiedDynamicObjects: boolean;
  expectedVisibleObjectIds: string[];
  expectedVisibleGroupIds: string[];
  diagnostics: ShotPresenceDiagnostic[];
}

export interface ShotPresenceSample {
  timeSeconds: number;
  visibleDynamicObjectIds: string[];
  diagnostics: ShotPresenceDiagnostic[];
}

export interface ShotPresenceInspection {
  ok: boolean;
  shotId: string;
  contractPresent: boolean;
  expectedVisibleObjectIds: string[];
  expectedVisibleGroupIds: string[];
  dynamicObjectIds: string[];
  actualVisibleObjectIds: string[];
  samples: ShotPresenceSample[];
  diagnostics: ShotPresenceDiagnostic[];
}

export interface ShotPresenceApplicationResult {
  ok: boolean;
  project: LocationProject;
  inspection: ShotPresenceInspection;
  diagnostics: ShotPresenceDiagnostic[];
}

const DYNAMIC_CLASSES = new Set<ProductionObjectClass>([
  'dynamic_subject',
  'dynamic_prop',
  'conditional_set_piece',
  'unclassified',
]);

/**
 * Derive the project-wide dynamic universe without treating ordinary
 * architecture as shot-controlled. Explicit production classification,
 * staging metadata, and non-location production bindings are authoritative
 * signals; ordinary architecture/environment geometry remains static.
 */
export function deriveDynamicObjectUniverse(
  project: LocationProject,
): DynamicObjectDescriptor[] {
  const groups = project.scene.objectGroups ?? {};
  const groupIdsByObjectId = new Map<string, string[]>();
  for (const [groupId, group] of Object.entries(groups)) {
    for (const objectId of new Set(group.objectIds)) {
      groupIdsByObjectId.set(objectId, [
        ...(groupIdsByObjectId.get(objectId) ?? []),
        groupId,
      ]);
    }
  }

  const boundDynamicObjectIds = new Set<string>();
  const configuration = getProductionConfiguration(project);
  for (const [entityId, binding] of Object.entries(configuration.bindings)) {
    // Location bindings describe set geography, not a shot-presence subject.
    if (binding.kind === 'object' && !entityId.startsWith('locations.')) {
      boundDynamicObjectIds.add(binding.objectId);
    } else if (binding.kind === 'group' && !entityId.startsWith('locations.')) {
      for (const objectId of groups[binding.groupId]?.objectIds ?? []) {
        boundDynamicObjectIds.add(objectId);
      }
    }
  }

  return project.scene.objects.flatMap((object) => {
    const classification = classifyProductionObject(object);
    const metadata = object.metadata ?? {};
    const explicitlyDynamic = metadata.productionDynamic === true
      || metadata.conditionalSetPiece === true;
    const isDynamic = DYNAMIC_CLASSES.has(classification)
      || explicitlyDynamic
      || boundDynamicObjectIds.has(object.id);
    if (!isDynamic) return [];
    return [{
      objectId: object.id,
      classification,
      groupIds: [...(groupIdsByObjectId.get(object.id) ?? [])],
    }];
  });
}

/** Find a persisted shot contract by stable shot id, production id, or number. */
export function getShotPresenceContract(
  project: LocationProject,
  shot: Pick<Shot, 'id' | 'shotNumber' | 'productionShotId'>,
): ShotPresenceContract | undefined {
  const contracts = getProductionConfiguration(project).shotContracts;
  for (const key of [shot.id, shot.productionShotId, shot.shotNumber]) {
    if (key && contracts[key]?.presence) return contracts[key].presence;
  }
  return undefined;
}

/** Resolve direct object ids and complete logical group member sets. */
export function resolveExpectedShotPresence(
  project: LocationProject,
  contract?: ShotPresenceContract,
): ShotPresenceResolution {
  const dynamic = new Set(deriveDynamicObjectUniverse(project).map((item) => item.objectId));
  const expected = new Set<string>();
  const diagnostics: ShotPresenceDiagnostic[] = [];
  const expectedVisibleObjectIds = contract?.expectedVisibleObjectIds ?? [];
  const expectedVisibleGroupIds = contract?.expectedVisibleGroupIds ?? [];

  for (const objectId of expectedVisibleObjectIds) {
    const object = project.scene.objects.find((item) => item.id === objectId);
    if (!object || !dynamic.has(objectId)) {
      diagnostics.push({
        code: 'expected_dynamic_object_missing',
        message: `Expected dynamic object "${objectId}" does not exist or is not classified as dynamic.`,
        objectId,
      });
      continue;
    }
    expected.add(objectId);
  }

  for (const groupId of expectedVisibleGroupIds) {
    const group = project.scene.objectGroups?.[groupId];
    if (!group) {
      diagnostics.push({
        code: 'expected_dynamic_object_missing',
        message: `Expected dynamic group "${groupId}" does not exist.`,
        groupId,
      });
      continue;
    }
    const memberIds = [...new Set(group.objectIds)];
    if (memberIds.length === 0) {
      diagnostics.push({
        code: 'expected_dynamic_object_missing',
        message: `Expected dynamic group "${groupId}" is empty.`,
        groupId,
      });
      continue;
    }
    for (const objectId of memberIds) {
      if (!project.scene.objects.some((object) => object.id === objectId)) {
        diagnostics.push({
          code: 'expected_dynamic_object_missing',
          message: `Expected dynamic group "${groupId}" is missing member "${objectId}".`,
          groupId,
          objectId,
        });
      } else if (dynamic.has(objectId)) {
        expected.add(objectId);
      }
    }
  }

  return {
    contractPresent: contract !== undefined,
    allowUnspecifiedDynamicObjects: contract?.allowUnspecifiedDynamicObjects ?? false,
    expectedVisibleObjectIds: [...expected],
    expectedVisibleGroupIds: [...expectedVisibleGroupIds],
    diagnostics,
  };
}

/** Inspect a shot's base state and all meaningful timeline visibility samples. */
export function inspectShotPresence(
  project: LocationProject,
  shotInput: Shot | string,
  contractInput?: ShotPresenceContract,
): ShotPresenceInspection {
  const shot = typeof shotInput === 'string'
    ? project.shots.find((candidate) => candidate.id === shotInput)
    : project.shots.find((candidate) => candidate.id === shotInput.id) ?? shotInput;
  const shotId = typeof shotInput === 'string' ? shotInput : shotInput.id;
  if (!shot) {
    const diagnostic: ShotPresenceDiagnostic = {
      code: 'shot_missing',
      message: `Shot "${shotId}" does not exist.`,
      shotId,
    };
    return {
      ok: false,
      shotId,
      contractPresent: false,
      expectedVisibleObjectIds: [],
      expectedVisibleGroupIds: [],
      dynamicObjectIds: [],
      actualVisibleObjectIds: [],
      samples: [],
      diagnostics: [diagnostic],
    };
  }

  const contract = contractInput ?? getShotPresenceContract(project, shot);
  const resolution = resolveExpectedShotPresence(project, contract);
  const dynamic = deriveDynamicObjectUniverse(project);
  const dynamicIds = dynamic.map((item) => item.objectId);
  const dynamicIdSet = new Set(dynamicIds);
  const diagnostics: ShotPresenceDiagnostic[] = resolution.diagnostics.map((item) => ({ ...item, shotId }));

  for (const item of dynamic) {
    if (item.classification === 'unclassified') {
      diagnostics.push({
        code: 'unclassified_dynamic_object',
        message: `Dynamic object "${item.objectId}" has no usable production classification.`,
        shotId,
        objectId: item.objectId,
      });
    }
  }

  const expected = new Set(resolution.expectedVisibleObjectIds);
  const sampleTimes = presenceSampleTimes(shot);
  const samples: ShotPresenceSample[] = [];
  for (const timeSeconds of sampleTimes) {
    const objectOverrides = timeSeconds === 0 && shot.cameraKeyframes.length === 0
      ? shot.objectOverrides ?? {}
      : interpolateObjectOverrides(
        shot.cameraKeyframes,
        timeSeconds,
        shot.objectOverrides,
        project.scene.objects,
      );
    const visibleDynamicObjectIds = visibleDynamicIds(project, objectOverrides, dynamicIdSet);
    const sampleDiagnostics = samplePresenceDiagnostics({
      project,
      dynamic,
      visibleDynamicObjectIds,
      expected,
      resolution,
      shotId,
      timeSeconds,
    });
    samples.push({ timeSeconds, visibleDynamicObjectIds, diagnostics: sampleDiagnostics });
    diagnostics.push(...sampleDiagnostics);
  }

  const first = samples[0]?.visibleDynamicObjectIds ?? [];
  const firstKey = first.join('|');
  if (samples.some((sample) => sample.visibleDynamicObjectIds.join('|') !== firstKey)) {
    diagnostics.push({
      code: 'dynamic_presence_changed_over_time',
      message: `Dynamic object presence changes across timeline samples for shot "${shotId}".`,
      shotId,
    });
  }

  const uniqueDiagnostics = dedupeDiagnostics(diagnostics);
  return {
    ok: uniqueDiagnostics.length === 0,
    shotId,
    contractPresent: resolution.contractPresent,
    expectedVisibleObjectIds: resolution.expectedVisibleObjectIds,
    expectedVisibleGroupIds: resolution.expectedVisibleGroupIds,
    dynamicObjectIds: dynamicIds,
    actualVisibleObjectIds: first,
    samples,
    diagnostics: uniqueDiagnostics,
  };
}

/** Verify is intentionally a separate entry point for gate code and adapters. */
export function verifyShotPresence(
  project: LocationProject,
  shotInput: Shot | string,
  contractInput?: ShotPresenceContract,
): ShotPresenceInspection {
  return inspectShotPresence(project, shotInput, contractInput);
}

/**
 * Apply a closed-world visibility state while preserving every camera,
 * transform, pose, and non-visibility override. Timeline snapshots are made
 * explicit so later interpolation cannot reintroduce an inherited object.
 */
export function applyClosedWorldShotPresence(
  project: LocationProject,
  shotInput: Shot | string,
  contractInput?: ShotPresenceContract,
): ShotPresenceApplicationResult {
  const shot = typeof shotInput === 'string'
    ? project.shots.find((candidate) => candidate.id === shotInput)
    : project.shots.find((candidate) => candidate.id === shotInput.id) ?? shotInput;
  const shotId = typeof shotInput === 'string' ? shotInput : shotInput.id;
  const contract = contractInput ?? (shot ? getShotPresenceContract(project, shot) : undefined);
  const before = inspectShotPresence(project, shot ?? shotId, contract);
  if (!shot || !contract || before.diagnostics.some((item) => (
    item.code === 'expected_dynamic_object_missing'
    || item.code === 'shot_missing'
    || item.code === 'unclassified_dynamic_object'
  ))) {
    return {
      ok: false,
      project,
      inspection: before,
      diagnostics: before.diagnostics,
    };
  }

  const expected = new Set(before.expectedVisibleObjectIds);
  const dynamicIds = before.dynamicObjectIds;
  let nextShot = structuredClone(shot);
  for (const objectId of dynamicIds) {
    const object = project.scene.objects.find((candidate) => candidate.id === objectId);
    if (!object) continue;
    nextShot.objectOverrides = updateShotObjectOverrides(nextShot, object, {
      visible: expected.has(objectId),
    });
  }

  nextShot.cameraKeyframes = nextShot.cameraKeyframes.map((keyframe) => ({
    ...keyframe,
    objectOverrides: applyVisibilityToOverrides(
      keyframe.objectOverrides ?? nextShot.objectOverrides,
      dynamicIds,
      expected,
    ),
  }));
  nextShot.updatedAt = new Date().toISOString();

  const nextProject: LocationProject = {
    ...project,
    shots: project.shots.map((candidate) => candidate.id === shot.id ? nextShot : candidate),
  };
  const inspection = inspectShotPresence(nextProject, nextShot, contract);
  return {
    ok: inspection.ok,
    project: nextProject,
    inspection,
    diagnostics: inspection.diagnostics,
  };
}

function applyVisibilityToOverrides(
  source: ShotObjectOverrides | undefined,
  dynamicIds: readonly string[],
  expected: ReadonlySet<string>,
): ShotObjectOverrides {
  const next = structuredClone(source ?? {});
  for (const objectId of dynamicIds) {
    next[objectId] = {
      ...(next[objectId] ?? {}),
      visible: expected.has(objectId),
    };
  }
  return next;
}

function visibleDynamicIds(
  project: LocationProject,
  overrides: ShotObjectOverrides,
  dynamicIds: ReadonlySet<string>,
): string[] {
  const resolved = resolveSceneObjectsForShot(project, { objectOverrides: overrides });
  return resolved
    .filter((object) => dynamicIds.has(object.id) && object.visible !== false)
    .map((object) => object.id);
}

function samplePresenceDiagnostics(input: {
  project: LocationProject;
  dynamic: DynamicObjectDescriptor[];
  visibleDynamicObjectIds: string[];
  expected: ReadonlySet<string>;
  resolution: ShotPresenceResolution;
  shotId: string;
  timeSeconds: number;
}): ShotPresenceDiagnostic[] {
  const diagnostics: ShotPresenceDiagnostic[] = [];
  const visible = new Set(input.visibleDynamicObjectIds);
  if (!input.resolution.contractPresent) return diagnostics;

  for (const objectId of input.expected) {
    if (!visible.has(objectId)) {
      diagnostics.push({
        code: 'expected_dynamic_object_hidden',
        message: `Expected dynamic object "${objectId}" is hidden at ${input.timeSeconds.toFixed(3)}s.`,
        shotId: input.shotId,
        objectId,
        sampleTimeSeconds: input.timeSeconds,
      });
    }
  }

  if (!input.resolution.allowUnspecifiedDynamicObjects) {
    for (const objectId of input.visibleDynamicObjectIds) {
      if (!input.expected.has(objectId)) {
        diagnostics.push({
          code: 'unexpected_dynamic_object',
          message: `Unexpected dynamic object "${objectId}" is visible at ${input.timeSeconds.toFixed(3)}s.`,
          shotId: input.shotId,
          objectId,
          sampleTimeSeconds: input.timeSeconds,
        });
      }
    }
  }

  for (const [groupId, group] of Object.entries(input.project.scene.objectGroups ?? {})) {
    const memberIds = [...new Set(group.objectIds)].filter((objectId) => (
      input.dynamic.some((item) => item.objectId === objectId)
    ));
    if (memberIds.length < 2) continue;
    const visibleCount = memberIds.filter((objectId) => visible.has(objectId)).length;
    if (visibleCount > 0 && visibleCount < memberIds.length) {
      diagnostics.push({
        code: 'partial_group_visibility',
        message: `Multipart group "${groupId}" is only partially visible at ${input.timeSeconds.toFixed(3)}s.`,
        shotId: input.shotId,
        groupId,
        sampleTimeSeconds: input.timeSeconds,
      });
    }
  }
  return diagnostics;
}

function presenceSampleTimes(shot: Shot): number[] {
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes);
  if (keyframes.length === 0) return [0];
  const times = new Set<number>([0]);
  for (const keyframe of keyframes) times.add(Math.max(0, keyframe.timeSeconds));
  for (let index = 1; index < keyframes.length; index += 1) {
    const start = keyframes[index - 1]!.timeSeconds;
    const end = keyframes[index]!.timeSeconds;
    if (end > start) times.add(start + (end - start) / 2);
  }
  return [...times].sort((a, b) => a - b);
}

function dedupeDiagnostics(items: ShotPresenceDiagnostic[]): ShotPresenceDiagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [
      item.code,
      item.shotId ?? '',
      item.objectId ?? '',
      item.groupId ?? '',
      item.sampleTimeSeconds ?? '',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
