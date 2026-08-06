import type { MaterializedStillArtifact, StillArtifactKind } from '../domain/types';
import type { PeopleRenderVariant } from './peopleExport';
import type { SceneContentMode } from './shotSceneState';

export interface StillArtifactSpecification {
  kind: StillArtifactKind;
  appearance: 'clay' | 'projected' | 'depth';
  peopleVariant?: PeopleRenderVariant;
  contentMode?: SceneContentMode;
  width: number;
  height: number;
  timeSeconds?: number;
  frameRole?: MaterializedStillArtifact['frameRole'];
  backgroundColor?: string;
  includeCharacterAttachments?: boolean;
}

export function stillArtifactKey(spec: StillArtifactSpecification): string {
  const parts = [spec.kind];
  if (spec.peopleVariant) parts.push(spec.peopleVariant);
  else if (spec.contentMode === 'characters_only') parts.push('characters_only');
  else if (spec.contentMode === 'clean_plate') parts.push('clean_plate');
  if (spec.frameRole) parts.push(spec.frameRole);
  else if (spec.timeSeconds !== undefined) parts.push(String(spec.timeSeconds));
  return parts.join(':');
}

export function stillArtifactKeyForStored(artifact: MaterializedStillArtifact): string {
  return artifact.key;
}
