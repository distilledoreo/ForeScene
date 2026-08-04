/**
 * Explicit mutation expectations for scoped production compiles.
 */

import type { LocationProject, Shot } from '../../domain/types';
import type { PrevisProductionManifestV1, PrevisShotDefinition } from './manifest';
import type { ProductionCanaryPlan } from './productionGates';
import { getProductionConfiguration } from './productionConfiguration';

export interface ProductionMutationExpectation {
  /** Existing shot ids that the compile is permitted to modify. */
  allowedExistingShotIds: ReadonlySet<string>;
  /** Production shot ids that may appear on newly created shots (compiler uses shot numbers). */
  expectedCreatedProductionShotIds: ReadonlySet<string>;
  /** Existing scene object ids that the compile is permitted to modify. */
  allowedExistingObjectIds: ReadonlySet<string>;
}

export interface ProductionMutationScopeResult {
  ok: boolean;
  errors: string[];
}

function boundObjectIds(project: LocationProject): Set<string> {
  const ids = new Set<string>();
  const config = getProductionConfiguration(project);
  const groups = project.scene.objectGroups ?? {};
  for (const binding of Object.values(config.bindings)) {
    if (binding.kind === 'object') ids.add(binding.objectId);
    if (binding.kind === 'group') {
      for (const objectId of groups[binding.groupId]?.objectIds ?? []) ids.add(objectId);
    }
  }
  for (const location of Object.values(config.locations)) {
    for (const objectId of location.objectIds) ids.add(objectId);
    for (const groupId of location.objectGroupIds) {
      for (const objectId of groups[groupId]?.objectIds ?? []) ids.add(objectId);
    }
  }
  return ids;
}

/** Matches shotCompiler, which stamps compiled shots with the manifest shot number. */
function compiledProductionShotId(definition: PrevisShotDefinition): string {
  return definition.shotNumber;
}

function manifestAliases(definition: PrevisShotDefinition): string[] {
  return [definition.id, definition.shotNumber, compiledProductionShotId(definition)];
}

function beforeShotRepresentsManifestShot(beforeShot: Shot, definition: PrevisShotDefinition): boolean {
  const aliases = new Set(manifestAliases(definition));
  if (beforeShot.productionShotId && aliases.has(beforeShot.productionShotId)) return true;
  return aliases.has(beforeShot.shotNumber);
}

function beforeProjectHasManifestShot(before: LocationProject, definition: PrevisShotDefinition): boolean {
  return before.shots.some((shot) => beforeShotRepresentsManifestShot(shot, definition));
}

function buildExpectation(
  before: LocationProject,
  definitions: PrevisShotDefinition[],
): ProductionMutationExpectation {
  const allowedExistingShotIds = new Set(
    before.shots
      .filter((shot) => definitions.some((definition) => beforeShotRepresentsManifestShot(shot, definition)))
      .map((shot) => shot.id),
  );
  const expectedCreatedProductionShotIds = new Set(
    definitions
      .filter((definition) => !beforeProjectHasManifestShot(before, definition))
      .map((definition) => compiledProductionShotId(definition)),
  );
  return {
    allowedExistingShotIds,
    expectedCreatedProductionShotIds,
    allowedExistingObjectIds: boundObjectIds(before),
  };
}

export function buildCanaryMutationExpectation(
  before: LocationProject,
  plan: ProductionCanaryPlan,
  manifest: PrevisProductionManifestV1,
): ProductionMutationExpectation {
  const definitions = plan.shotIds
    .map((shotId) => manifest.shots.find((shot) => shot.id === shotId))
    .filter((shot): shot is PrevisShotDefinition => Boolean(shot));
  return buildExpectation(before, definitions);
}

export function buildFullStillMutationExpectation(
  before: LocationProject,
  manifest: PrevisProductionManifestV1,
): ProductionMutationExpectation {
  return buildExpectation(before, manifest.shots);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function verifyProductionMutationScope(
  before: LocationProject,
  after: LocationProject,
  expectation: ProductionMutationExpectation,
): ProductionMutationScopeResult {
  const errors: string[] = [];
  if (before.id !== after.id) errors.push('Project id changed during the verified mutation.');

  const beforeShots = new Map(before.shots.map((shot) => [shot.id, shot]));
  const afterShotIds = new Set(after.shots.map((shot) => shot.id));
  for (const shot of before.shots) {
    if (!afterShotIds.has(shot.id)) {
      errors.push(`Shot "${shot.shotNumber}" was removed during production compile.`);
    }
  }

  for (const shot of after.shots) {
    const beforeShot = beforeShots.get(shot.id);
    if (!beforeShot) {
      const productionShotId = shot.productionShotId;
      if (!productionShotId || !expectation.expectedCreatedProductionShotIds.has(productionShotId)) {
        errors.push(`Unexpected new shot "${shot.shotNumber}" was created.`);
      }
      continue;
    }
    if (!sameJson(beforeShot, shot) && !expectation.allowedExistingShotIds.has(shot.id)) {
      errors.push(`Unrelated shot "${shot.shotNumber}" changed during production compile.`);
    }
  }

  const beforeObjects = new Map(before.scene.objects.map((object) => [object.id, object]));
  const afterObjectIds = new Set(after.scene.objects.map((object) => object.id));
  for (const object of before.scene.objects) {
    if (!afterObjectIds.has(object.id)) {
      errors.push(`Scene object "${object.id}" was removed during production compile.`);
    }
  }

  for (const object of after.scene.objects) {
    const beforeObject = beforeObjects.get(object.id);
    if (!beforeObject) continue;
    if (!sameJson(beforeObject, object) && !expectation.allowedExistingObjectIds.has(object.id)) {
      errors.push(`Unrelated scene object "${object.id}" changed during production compile.`);
    }
  }

  const beforePanoIds = before.panoRefs.map((pano) => pano.id).sort().join('|');
  const afterPanoIds = after.panoRefs.map((pano) => pano.id).sort().join('|');
  if (beforePanoIds !== afterPanoIds) {
    errors.push('Panorama references changed outside the production compile scope.');
  }

  return { ok: errors.length === 0, errors };
}
