/**
 * Canonical translation from shot export settings → desired still artifacts.
 * Capture, edit reconciliation, and export must all use this module.
 */

import type { LocationProject, Shot } from '../domain/types';
import { getCameraMoveReferenceFrames } from './cameraKeyframes';
import {
  shotHasVisibleCharactersForPass,
} from './characterPassExport';
import {
  shouldExportDepthReferenceFrames,
  shouldExportViewportDepth,
} from './depthRender';
import { getPeopleRenderVariants } from './peopleExport';
import { canUseProjectedAppearance } from './projectedStyle';
import {
  stillArtifactKey,
  type StillArtifactSpecification,
} from './stillArtifactTypes';

export type StillArtifactPurpose = 'capture' | 'reconcile' | 'export';

export interface BuildStillArtifactSpecificationsParams {
  project: LocationProject;
  shot: Shot;
  purpose: StillArtifactPurpose;
}

function frameRoleForReferenceId(
  id: 'start' | 'mid' | 'end',
): NonNullable<StillArtifactSpecification['frameRole']> {
  if (id === 'start') return 'start';
  if (id === 'mid') return 'middle';
  return 'end';
}

/**
 * Build the full set of still artifacts a shot should have for the given purpose.
 * This is the only authoritative place that maps export settings → still specs.
 */
export function buildStillArtifactSpecificationsForShot(
  params: BuildStillArtifactSpecificationsParams,
): StillArtifactSpecification[] {
  const { project, shot } = params;
  const width = shot.exportSettings.width;
  const height = shot.exportSettings.height;
  const peopleVariants = getPeopleRenderVariants(shot.exportSettings.peopleExportMode);
  const projectedAvailable = canUseProjectedAppearance(project);
  const specs: StillArtifactSpecification[] = [];

  if (shot.exportSettings.includeViewport) {
    for (const peopleVariant of peopleVariants) {
      specs.push({
        kind: 'clay-viewport',
        appearance: 'clay',
        peopleVariant,
        width,
        height,
      });
    }
  }

  if (shot.exportSettings.includeProjectedViewport && projectedAvailable) {
    for (const peopleVariant of peopleVariants) {
      specs.push({
        kind: 'projected-viewport',
        appearance: 'projected',
        peopleVariant,
        width,
        height,
      });
    }
  }

  if (shouldExportViewportDepth(shot.exportSettings.depth)) {
    for (const peopleVariant of peopleVariants) {
      specs.push({
        kind: 'depth-viewport',
        appearance: 'depth',
        peopleVariant,
        width,
        height,
      });
    }
  }

  const characterPass = shot.exportSettings.characterPass;
  if (
    characterPass
    && characterPass.enabled
    && characterPass.includeStill
    && shotHasVisibleCharactersForPass(project, shot, characterPass)
  ) {
    const appearances: Array<'clay' | 'projected'> = ['clay'];
    if (projectedAvailable) appearances.push('projected');
    for (const appearance of appearances) {
      specs.push({
        kind: 'character-still',
        appearance,
        contentMode: 'characters_only',
        includeCharacterAttachments: characterPass.includeAttachedProps !== false,
        width,
        height,
        backgroundColor: characterPass.backgroundColor,
      });
    }
  }

  const referenceFrames = getCameraMoveReferenceFrames(shot.cameraKeyframes);
  if (referenceFrames.length > 0) {
    const wantClay = shot.exportSettings.includeCameraMoveReferenceFrames;
    const wantProjected = shot.exportSettings.includeProjectedCameraMoveReferenceFrames
      && projectedAvailable;
    const wantDepth = shouldExportDepthReferenceFrames(shot.exportSettings.depth, true);

    for (const frame of referenceFrames) {
      const frameRole = frameRoleForReferenceId(frame.id);
      if (wantClay) {
        for (const peopleVariant of peopleVariants) {
          specs.push({
            kind: 'clay-reference-frame',
            appearance: 'clay',
            peopleVariant,
            width,
            height,
            timeSeconds: frame.timeSeconds,
            frameRole,
          });
        }
      }
      if (wantProjected) {
        for (const peopleVariant of peopleVariants) {
          specs.push({
            kind: 'projected-reference-frame',
            appearance: 'projected',
            peopleVariant,
            width,
            height,
            timeSeconds: frame.timeSeconds,
            frameRole,
          });
        }
      }
      if (wantDepth) {
        for (const peopleVariant of peopleVariants) {
          specs.push({
            kind: 'depth-reference-frame',
            appearance: 'depth',
            peopleVariant,
            width,
            height,
            timeSeconds: frame.timeSeconds,
            frameRole,
          });
        }
      }
    }
  }

  // Always ensure at least a primary clay with-people viewport exists for capture
  // preview even when includeViewport is off — the shot card needs a preview.
  if (params.purpose === 'capture' || params.purpose === 'reconcile') {
    const hasPrimaryCandidate = specs.some(
      (spec) => spec.kind === 'clay-viewport' || spec.kind === 'projected-viewport',
    );
    if (!hasPrimaryCandidate) {
      specs.unshift({
        kind: 'clay-viewport',
        appearance: 'clay',
        peopleVariant: 'with_people',
        width,
        height,
      });
    }
  }

  return specs;
}

/**
 * Select the primary shot-card / camera-roll preview specification.
 * Prefers with-people projected when projection is valid, else clay with-people.
 * Never returns depth or character-only as primary.
 */
export function selectPrimaryStillSpecification(
  project: LocationProject,
  shot: Shot,
  specifications: readonly StillArtifactSpecification[],
): StillArtifactSpecification {
  const width = shot.exportSettings.width;
  const height = shot.exportSettings.height;
  const projectedAvailable = canUseProjectedAppearance(project);

  const viewportSpecs = specifications.filter(
    (spec) =>
      (spec.kind === 'clay-viewport' || spec.kind === 'projected-viewport')
      && !spec.frameRole
      && spec.contentMode !== 'characters_only',
  );

  // Prefer configured people variant that matches current export mode, with_people first.
  const preferredPeople = shot.exportSettings.peopleExportMode === 'clean_plate'
    ? 'clean_plate' as const
    : 'with_people' as const;

  if (projectedAvailable) {
    const projectedPreferred = viewportSpecs.find(
      (spec) =>
        spec.kind === 'projected-viewport'
        && (spec.peopleVariant === preferredPeople || !spec.peopleVariant),
    );
    if (projectedPreferred) return projectedPreferred;

    const projectedAny = viewportSpecs.find((spec) => spec.kind === 'projected-viewport');
    if (projectedAny) return projectedAny;
  }

  const clayPreferred = viewportSpecs.find(
    (spec) =>
      spec.kind === 'clay-viewport'
      && (spec.peopleVariant === preferredPeople || !spec.peopleVariant),
  );
  if (clayPreferred) return clayPreferred;

  const clayAny = viewportSpecs.find((spec) => spec.kind === 'clay-viewport');
  if (clayAny) return clayAny;

  // Guaranteed fallback — never depth / character-only.
  return {
    kind: 'clay-viewport',
    appearance: 'clay',
    peopleVariant: preferredPeople === 'clean_plate' ? 'clean_plate' : 'with_people',
    width,
    height,
  };
}

/** Priority score for materialization order (lower = earlier). */
export function stillArtifactMaterializationPriority(
  spec: StillArtifactSpecification,
  primaryKey: string,
): number {
  const key = stillArtifactKey(spec);
  if (key === primaryKey) return 0;

  if (spec.kind === 'clay-viewport' || spec.kind === 'projected-viewport') {
    if (spec.peopleVariant === 'with_people' || !spec.peopleVariant) return 1;
    return 2; // clean plate
  }
  if (spec.kind === 'depth-viewport') return 3;
  if (spec.kind === 'character-still') return 4;
  if (spec.frameRole || spec.kind.endsWith('reference-frame')) {
    const appearanceRank = spec.appearance === 'clay' ? 0 : spec.appearance === 'projected' ? 1 : 2;
    const roleRank = spec.frameRole === 'start' ? 0 : spec.frameRole === 'middle' ? 1 : 2;
    return 5 + appearanceRank * 3 + roleRank;
  }
  return 20;
}

export function sortStillSpecificationsByPriority(
  specs: readonly StillArtifactSpecification[],
  primaryKey: string,
): StillArtifactSpecification[] {
  return [...specs].sort(
    (a, b) =>
      stillArtifactMaterializationPriority(a, primaryKey)
      - stillArtifactMaterializationPriority(b, primaryKey),
  );
}
