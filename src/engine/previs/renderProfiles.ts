/**
 * Render profiles for production runs — resolution, appearance, and pass policy.
 */

export const RENDER_PROFILE_VERSION = 1;

export type RenderProfileId = 'rapid-review' | 'delivery' | 'control-video';

export type RenderAppearance = 'clay' | 'projected' | 'depth';
export type RenderPeopleVariant = 'with_people' | 'clean_plate';
export type RenderContentMode = 'full_scene' | 'characters_only';
export type RenderSampling = 'single' | 'adaptive';
export type RenderQuality = 'draft' | 'standard' | 'final';

export interface RenderProfile {
  id: RenderProfileId;
  version: number;
  width: number;
  height: number;
  appearance: RenderAppearance;
  /** Resolve calibrated shot panoramas as projected delivery, while keeping explicitly unlinked shots clay. */
  panoramaPolicy: 'profile' | 'projected_when_linked';
  /** When primary appearance cannot be produced, fall back to this pass. */
  fallbackAppearance?: RenderAppearance;
  peopleVariant?: RenderPeopleVariant;
  content?: RenderContentMode;
  /** Number of samples for static shots in the current review phase. */
  staticSampling: RenderSampling;
  /** Event-aware motion sampling for bounded review frames. */
  motionSampling: RenderSampling;
  /** Draft/standard/final tier used by review planning and renderer adapters. */
  antialiasing: RenderQuality;
  /** Draft/standard/final shadow tier used by review planning and renderer adapters. */
  shadows: RenderQuality;
  /** Include a depth review pass when the selected production phase requests it. */
  renderDepth: boolean;
  /** Include a clean-plate review pass when the selected production phase requests it. */
  renderCleanPlate: boolean;
  /** Include a characters-only review pass when the selected production phase requests it. */
  renderCharactersOnly: boolean;
  renderVideo: boolean;
  /** Skip final package export during rapid review. */
  skipPackage: boolean;
  /** When false, render at each shot's export resolution instead of width/height. */
  overrideDimensions: boolean;
}

/** Review-quality first pass — low resolution, single clay frame, no video export. */
export const RAPID_REVIEW_PROFILE: RenderProfile = {
  id: 'rapid-review',
  version: RENDER_PROFILE_VERSION,
  width: 640,
  height: 360,
  appearance: 'clay',
  panoramaPolicy: 'profile',
  fallbackAppearance: 'clay',
  peopleVariant: 'with_people',
  content: 'full_scene',
  staticSampling: 'single',
  motionSampling: 'adaptive',
  antialiasing: 'draft',
  shadows: 'draft',
  renderDepth: false,
  renderCleanPlate: false,
  renderCharactersOnly: false,
  renderVideo: false,
  skipPackage: true,
  overrideDimensions: true,
};

/** Full delivery profile — shot export resolution, control videos when requested. */
export const DELIVERY_PROFILE: RenderProfile = {
  id: 'delivery',
  version: RENDER_PROFILE_VERSION,
  width: 1920,
  height: 1080,
  appearance: 'clay',
  panoramaPolicy: 'projected_when_linked',
  peopleVariant: 'with_people',
  content: 'full_scene',
  staticSampling: 'single',
  motionSampling: 'single',
  antialiasing: 'standard',
  shadows: 'standard',
  renderDepth: false,
  renderCleanPlate: false,
  renderCharactersOnly: false,
  renderVideo: true,
  skipPackage: false,
  overrideDimensions: false,
};

/** Control-video only pass at 1080p clay. */
export const CONTROL_VIDEO_PROFILE: RenderProfile = {
  id: 'control-video',
  version: RENDER_PROFILE_VERSION,
  width: 1920,
  height: 1080,
  appearance: 'clay',
  panoramaPolicy: 'projected_when_linked',
  peopleVariant: 'with_people',
  content: 'full_scene',
  staticSampling: 'single',
  motionSampling: 'single',
  antialiasing: 'standard',
  shadows: 'standard',
  renderDepth: false,
  renderCleanPlate: false,
  renderCharactersOnly: false,
  renderVideo: true,
  skipPackage: false,
  overrideDimensions: false,
};

const PROFILE_REGISTRY: Record<RenderProfileId, RenderProfile> = {
  'rapid-review': RAPID_REVIEW_PROFILE,
  delivery: DELIVERY_PROFILE,
  'control-video': CONTROL_VIDEO_PROFILE,
};

export function getRenderProfile(id: RenderProfileId): RenderProfile {
  return PROFILE_REGISTRY[id];
}

export function resolveRenderProfileForMode(mode: ProductionMode): RenderProfile {
  switch (mode) {
    case 'rapid-review':
      return RAPID_REVIEW_PROFILE;
    case 'delivery':
    case 'previs':
      return DELIVERY_PROFILE;
    default:
      return RAPID_REVIEW_PROFILE;
  }
}

export type ProductionMode = 'rapid-review' | 'delivery' | 'previs';

export function renderProfileFingerprint(profile: RenderProfile): string {
  return [
    profile.id,
    profile.version,
    profile.width,
    profile.height,
    profile.appearance,
    profile.panoramaPolicy,
    profile.fallbackAppearance ?? '',
    profile.peopleVariant ?? '',
    profile.content ?? '',
    profile.staticSampling,
    profile.motionSampling,
    profile.antialiasing,
    profile.shadows,
    profile.renderDepth ? '1' : '0',
    profile.renderCleanPlate ? '1' : '0',
    profile.renderCharactersOnly ? '1' : '0',
    profile.renderVideo ? '1' : '0',
    profile.overrideDimensions ? '1' : '0',
  ].join('|');
}

export function resolveRenderAppearanceForShot(
  profile: RenderProfile,
  shot: { linkedPanoId?: string | null },
): RenderAppearance {
  if (profile.panoramaPolicy !== 'projected_when_linked') return profile.appearance;
  if (typeof shot.linkedPanoId === 'string' && shot.linkedPanoId.length > 0) return 'projected';
  if (shot.linkedPanoId === null) return 'clay';
  return profile.appearance;
}
