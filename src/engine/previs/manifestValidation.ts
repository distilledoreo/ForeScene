/**
 * Hand-written PrevisProductionManifestV1 parser/validator.
 * Independent of React, Zustand, and network code.
 */

import {
  PREVIS_ASPECT_RATIOS,
  PREVIS_CAMERA_ANGLES,
  PREVIS_CAMERA_TEMPLATES,
  PREVIS_LENS_CLASSES,
  PREVIS_LOCATION_FEATURE_TYPES,
  PREVIS_LOCATION_SLOTS,
  PREVIS_LOCATION_TEMPLATES,
  PREVIS_MANIFEST_LIMITS,
  PREVIS_MANIFEST_VERSION,
  PREVIS_PROP_PRIMITIVES,
  PREVIS_RELATIVE_RELATIONS,
  type PrevisAspectRatio,
  type PrevisBlockingInstruction,
  type PrevisBlockingPlacement,
  type PrevisCameraAngle,
  type PrevisCameraTemplate,
  type PrevisCharacterDefinition,
  type PrevisLensClass,
  type PrevisLocationDefinition,
  type PrevisLocationFeatureType,
  type PrevisLocationSlot,
  type PrevisLocationTemplate,
  type PrevisProductionManifestV1,
  type PrevisPropDefinition,
  type PrevisPropPrimitive,
  type PrevisRelativeRelation,
  type PrevisShotDefinition,
} from './manifest';
import {
  PREVIS_DIAGNOSTIC_CODES,
  previsError,
  previsWarning,
  type PrevisDiagnostic,
} from './manifestDiagnostics';
import { isSupportedPrevisPosePreset } from './posePresets';

export interface PrevisManifestParseResult {
  manifest?: PrevisProductionManifestV1;
  errors: PrevisDiagnostic[];
  warnings: PrevisDiagnostic[];
}

export function parsePrevisProductionManifest(input: unknown): PrevisManifestParseResult {
  const errors: PrevisDiagnostic[] = [];
  const warnings: PrevisDiagnostic[] = [];

  const root = coerceJsonRoot(input, errors, warnings);
  if (!root) return { errors, warnings };

  if (root.version !== PREVIS_MANIFEST_VERSION) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.schemaVersion,
      `version must be ${PREVIS_MANIFEST_VERSION}.`,
      { path: 'version' },
    ));
  }

  if (!root.project || typeof root.project !== 'object' || Array.isArray(root.project)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.missingField,
      'project must be an object.',
      { path: 'project' },
    ));
    return { errors, warnings };
  }

  const projectRecord = root.project as Record<string, unknown>;
  const projectName = readNonemptyString(projectRecord.name, 'project.name', errors);
  const projectDescription = readOptionalString(
    projectRecord.description,
    'project.description',
    errors,
    warnings,
  );
  const aspectRatio = readEnum(
    projectRecord.aspectRatio,
    PREVIS_ASPECT_RATIOS,
    'project.aspectRatio',
    errors,
  ) as PrevisAspectRatio | undefined;

  let frameRate: number | undefined;
  if (projectRecord.frameRate !== undefined) {
    if (typeof projectRecord.frameRate !== 'number' || !Number.isFinite(projectRecord.frameRate)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.invalidType,
        'project.frameRate must be a finite number.',
        { path: 'project.frameRate' },
      ));
    } else if (projectRecord.frameRate < 1 || projectRecord.frameRate > 120) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.invalidRange,
        'project.frameRate must be between 1 and 120.',
        { path: 'project.frameRate' },
      ));
    } else {
      frameRate = projectRecord.frameRate;
    }
  }

  const locationIds = new Set<string>();
  const castIds = new Set<string>();
  const propIds = new Set<string>();
  const shotIds = new Set<string>();
  const shotNumbers = new Set<string>();

  const locations = parseLocations(root.locations, locationIds, errors, warnings);
  const cast = parseCast(root.cast, castIds, errors, warnings);
  const props = root.props === undefined
    ? undefined
    : parseProps(root.props, propIds, errors, warnings);
  const shots = parseShots(
    root.shots,
    {
      locationIds,
      castIds,
      propIds,
      shotIds,
      shotNumbers,
    },
    errors,
    warnings,
  );

  if (errors.length > 0 || !projectName || !aspectRatio) {
    return { errors, warnings };
  }

  const manifest: PrevisProductionManifestV1 = {
    version: PREVIS_MANIFEST_VERSION,
    project: {
      name: projectName,
      aspectRatio,
      ...(projectDescription !== undefined ? { description: projectDescription } : {}),
      ...(frameRate !== undefined ? { frameRate } : {}),
    },
    locations,
    cast,
    ...(props !== undefined ? { props } : {}),
    shots,
  };

  return { manifest, errors, warnings };
}

function parseLocations(
  value: unknown,
  locationIds: Set<string>,
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisLocationDefinition[] {
  if (!Array.isArray(value)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.missingField,
      'locations must be an array.',
      { path: 'locations' },
    ));
    return [];
  }
  if (value.length === 0) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.emptyField,
      'locations must contain at least one location.',
      { path: 'locations' },
    ));
    return [];
  }
  if (value.length > PREVIS_MANIFEST_LIMITS.maxLocations) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `locations exceeds the maximum of ${PREVIS_MANIFEST_LIMITS.maxLocations}.`,
      { path: 'locations' },
    ));
  }

  const result: PrevisLocationDefinition[] = [];
  value.forEach((entry, index) => {
    const path = `locations[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'location must be an object.', { path }));
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = readId(record.id, `${path}.id`, locationIds, errors);
    const name = readNonemptyString(record.name, `${path}.name`, errors);
    const description = readOptionalString(record.description, `${path}.description`, errors, warnings);
    const template = readEnum(
      record.template,
      PREVIS_LOCATION_TEMPLATES,
      `${path}.template`,
      errors,
    ) as PrevisLocationTemplate | undefined;

    if (template === 'custom_blueprint') {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.customBlueprintUnsupported,
        'custom_blueprint is reserved for a later milestone; use a built-in template.',
        { path: `${path}.template`, entityId: id },
      ));
    }

    let dimensions: PrevisLocationDefinition['dimensions'];
    if (record.dimensions !== undefined) {
      if (!record.dimensions || typeof record.dimensions !== 'object' || Array.isArray(record.dimensions)) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.invalidType,
          'dimensions must be an object.',
          { path: `${path}.dimensions` },
        ));
      } else {
        const dim = record.dimensions as Record<string, unknown>;
        dimensions = {};
        const width = readOptionalPositiveNumber(dim.width, `${path}.dimensions.width`, errors);
        const depth = readOptionalPositiveNumber(dim.depth, `${path}.dimensions.depth`, errors);
        const height = readOptionalPositiveNumber(dim.height, `${path}.dimensions.height`, errors);
        if (width !== undefined) dimensions.width = width;
        if (depth !== undefined) dimensions.depth = depth;
        if (height !== undefined) dimensions.height = height;
      }
    }

    let features: PrevisLocationDefinition['features'];
    if (record.features !== undefined) {
      if (!Array.isArray(record.features)) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.invalidType,
          'features must be an array.',
          { path: `${path}.features` },
        ));
      } else if (record.features.length > PREVIS_MANIFEST_LIMITS.maxFeaturesPerLocation) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.limitExceeded,
          `features exceeds ${PREVIS_MANIFEST_LIMITS.maxFeaturesPerLocation}.`,
          { path: `${path}.features` },
        ));
      } else {
        features = [];
        record.features.forEach((feature, featureIndex) => {
          const featurePath = `${path}.features[${featureIndex}]`;
          if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
            errors.push(previsError(
              PREVIS_DIAGNOSTIC_CODES.invalidType,
              'feature must be an object.',
              { path: featurePath },
            ));
            return;
          }
          const featureRecord = feature as Record<string, unknown>;
          const type = readEnum(
            featureRecord.type,
            PREVIS_LOCATION_FEATURE_TYPES,
            `${featurePath}.type`,
            errors,
          ) as PrevisLocationFeatureType | undefined;
          const featureName = readNonemptyString(featureRecord.name, `${featurePath}.name`, errors);
          const placement = readOptionalString(
            featureRecord.placement,
            `${featurePath}.placement`,
            errors,
            warnings,
          );
          if (type && featureName) {
            features!.push({
              type,
              name: featureName,
              ...(placement !== undefined ? { placement } : {}),
            });
          }
        });
      }
    }

    if (id && name && template) {
      result.push({
        id,
        name,
        template,
        ...(description !== undefined ? { description } : {}),
        ...(dimensions !== undefined ? { dimensions } : {}),
        ...(features !== undefined ? { features } : {}),
      });
    }
  });

  return result;
}

function parseCast(
  value: unknown,
  castIds: Set<string>,
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisCharacterDefinition[] {
  if (!Array.isArray(value)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.missingField,
      'cast must be an array.',
      { path: 'cast' },
    ));
    return [];
  }
  if (value.length === 0) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.emptyField,
      'cast must contain at least one character.',
      { path: 'cast' },
    ));
    return [];
  }
  if (value.length > PREVIS_MANIFEST_LIMITS.maxCast) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `cast exceeds the maximum of ${PREVIS_MANIFEST_LIMITS.maxCast}.`,
      { path: 'cast' },
    ));
  }

  const result: PrevisCharacterDefinition[] = [];
  value.forEach((entry, index) => {
    const path = `cast[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'character must be an object.', { path }));
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = readId(record.id, `${path}.id`, castIds, errors);
    const name = readNonemptyString(record.name, `${path}.name`, errors);
    if (record.type !== 'human_dummy') {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unsupportedValue,
        'character.type must be "human_dummy" in the MVP.',
        { path: `${path}.type`, entityId: id },
      ));
    }
    let height: number | undefined;
    if (record.height !== undefined) {
      height = readOptionalPositiveNumber(record.height, `${path}.height`, errors);
      if (
        height !== undefined
        && (height < PREVIS_MANIFEST_LIMITS.minHeightMeters
          || height > PREVIS_MANIFEST_LIMITS.maxHeightMeters)
      ) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.invalidRange,
          `height must be between ${PREVIS_MANIFEST_LIMITS.minHeightMeters} and ${PREVIS_MANIFEST_LIMITS.maxHeightMeters}.`,
          { path: `${path}.height`, entityId: id },
        ));
        height = undefined;
      }
    }
    const color = readOptionalString(record.color, `${path}.color`, errors, warnings);
    const defaultPose = readOptionalString(record.defaultPose, `${path}.defaultPose`, errors, warnings);
    if (defaultPose && !isSupportedPrevisPosePreset(defaultPose)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unsupportedValue,
        `Unknown defaultPose "${defaultPose}".`,
        { path: `${path}.defaultPose`, entityId: id },
      ));
    }

    if (id && name && record.type === 'human_dummy') {
      result.push({
        id,
        name,
        type: 'human_dummy',
        ...(height !== undefined ? { height } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(defaultPose !== undefined ? { defaultPose } : {}),
      });
    }
  });

  return result;
}

function parseProps(
  value: unknown,
  propIds: Set<string>,
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisPropDefinition[] {
  if (!Array.isArray(value)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.invalidType,
      'props must be an array when provided.',
      { path: 'props' },
    ));
    return [];
  }
  if (value.length > PREVIS_MANIFEST_LIMITS.maxProps) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `props exceeds the maximum of ${PREVIS_MANIFEST_LIMITS.maxProps}.`,
      { path: 'props' },
    ));
  }

  const result: PrevisPropDefinition[] = [];
  value.forEach((entry, index) => {
    const path = `props[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'prop must be an object.', { path }));
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = readId(record.id, `${path}.id`, propIds, errors);
    const name = readNonemptyString(record.name, `${path}.name`, errors);
    const primitive = readEnum(
      record.primitive,
      PREVIS_PROP_PRIMITIVES,
      `${path}.primitive`,
      errors,
    ) as PrevisPropPrimitive | undefined;
    let dimensions: [number, number, number] | undefined;
    if (record.dimensions !== undefined) {
      dimensions = readVec3(record.dimensions, `${path}.dimensions`, errors);
    }
    const color = readOptionalString(record.color, `${path}.color`, errors, warnings);

    if (id && name && primitive) {
      result.push({
        id,
        name,
        primitive,
        ...(dimensions ? { dimensions } : {}),
        ...(color !== undefined ? { color } : {}),
      });
    }
  });

  return result;
}

function parseShots(
  value: unknown,
  ids: {
    locationIds: Set<string>;
    castIds: Set<string>;
    propIds: Set<string>;
    shotIds: Set<string>;
    shotNumbers: Set<string>;
  },
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisShotDefinition[] {
  if (!Array.isArray(value)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.missingField,
      'shots must be an array.',
      { path: 'shots' },
    ));
    return [];
  }
  if (value.length === 0) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.emptyField,
      'shots must contain at least one shot.',
      { path: 'shots' },
    ));
    return [];
  }
  if (value.length > PREVIS_MANIFEST_LIMITS.maxShots) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `shots exceeds the maximum of ${PREVIS_MANIFEST_LIMITS.maxShots}.`,
      { path: 'shots' },
    ));
  }

  const result: PrevisShotDefinition[] = [];
  value.forEach((entry, index) => {
    const path = `shots[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'shot must be an object.', { path }));
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = readId(record.id, `${path}.id`, ids.shotIds, errors);
    const shotNumber = readNonemptyString(record.shotNumber, `${path}.shotNumber`, errors);
    if (shotNumber) {
      if (ids.shotNumbers.has(shotNumber)) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.duplicateShotNumber,
          `Duplicate shotNumber "${shotNumber}".`,
          { path: `${path}.shotNumber`, entityId: id },
        ));
      } else {
        ids.shotNumbers.add(shotNumber);
      }
    }
    const name = readNonemptyString(record.name, `${path}.name`, errors);
    const description = readOptionalString(record.description, `${path}.description`, errors, warnings) ?? '';
    if (record.description === undefined) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.missingField,
        'description is required.',
        { path: `${path}.description`, entityId: id },
      ));
    }
    const locationId = readNonemptyString(record.locationId, `${path}.locationId`, errors);
    if (locationId && !ids.locationIds.has(locationId)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unknownReference,
        `Unknown locationId "${locationId}".`,
        { path: `${path}.locationId`, entityId: id },
      ));
    }

    const subjects = parseStringArray(record.subjects, `${path}.subjects`, errors, true);
    for (const subject of subjects) {
      if (!ids.castIds.has(subject) && !ids.propIds.has(subject)) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.unknownReference,
          `Unknown subject "${subject}" (not in cast or props).`,
          { path: `${path}.subjects`, entityId: id },
        ));
      }
    }

    const blocking = record.blocking === undefined
      ? undefined
      : parseBlocking(record.blocking, `${path}.blocking`, ids, errors, warnings);

    const camera = parseCamera(record.camera, `${path}.camera`, ids, errors, warnings);

    let requirements: PrevisShotDefinition['requirements'];
    if (record.requirements !== undefined) {
      if (!record.requirements || typeof record.requirements !== 'object' || Array.isArray(record.requirements)) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.invalidType,
          'requirements must be an object.',
          { path: `${path}.requirements` },
        ));
      } else {
        const req = record.requirements as Record<string, unknown>;
        const visibleSubjects = req.visibleSubjects === undefined
          ? undefined
          : parseStringArray(req.visibleSubjects, `${path}.requirements.visibleSubjects`, errors, false);
        const visibleProps = req.visibleProps === undefined
          ? undefined
          : parseStringArray(req.visibleProps, `${path}.requirements.visibleProps`, errors, false);
        const notes = req.notes === undefined
          ? undefined
          : parseStringArray(req.notes, `${path}.requirements.notes`, errors, false);

        for (const subject of visibleSubjects ?? []) {
          if (!ids.castIds.has(subject)) {
            errors.push(previsError(
              PREVIS_DIAGNOSTIC_CODES.unknownReference,
              `Unknown visibleSubjects entry "${subject}".`,
              { path: `${path}.requirements.visibleSubjects`, entityId: id },
            ));
          }
        }
        for (const prop of visibleProps ?? []) {
          if (!ids.propIds.has(prop)) {
            errors.push(previsError(
              PREVIS_DIAGNOSTIC_CODES.unknownReference,
              `Unknown visibleProps entry "${prop}".`,
              { path: `${path}.requirements.visibleProps`, entityId: id },
            ));
          }
        }

        requirements = {
          ...(visibleSubjects ? { visibleSubjects } : {}),
          ...(visibleProps ? { visibleProps } : {}),
          ...(notes ? { notes } : {}),
        };
      }
    }

    if (id && shotNumber && name && locationId && camera) {
      result.push({
        id,
        shotNumber,
        name,
        description,
        locationId,
        subjects,
        camera,
        ...(blocking ? { blocking } : {}),
        ...(requirements ? { requirements } : {}),
      });
    }
  });

  return result;
}

function parseBlocking(
  value: unknown,
  path: string,
  ids: { castIds: Set<string>; propIds: Set<string> },
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisBlockingInstruction[] {
  if (!Array.isArray(value)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.invalidType,
      'blocking must be an array.',
      { path },
    ));
    return [];
  }
  if (value.length > PREVIS_MANIFEST_LIMITS.maxBlockingPerShot) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `blocking exceeds ${PREVIS_MANIFEST_LIMITS.maxBlockingPerShot}.`,
      { path },
    ));
  }

  const result: PrevisBlockingInstruction[] = [];
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'blocking entry must be an object.', { path: itemPath }));
      return;
    }
    const record = entry as Record<string, unknown>;
    const subject = readNonemptyString(record.subject, `${itemPath}.subject`, errors);
    if (subject && !ids.castIds.has(subject) && !ids.propIds.has(subject)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unknownReference,
        `Unknown blocking subject "${subject}".`,
        { path: `${itemPath}.subject` },
      ));
    }
    const placement = parsePlacement(record.placement, `${itemPath}.placement`, errors);
    const face = readOptionalString(record.face, `${itemPath}.face`, errors, warnings);
    if (face && !ids.castIds.has(face) && !ids.propIds.has(face)) {
      // Face can also be an anchor/location feature name; warn only for now.
      warnings.push(previsWarning(
        PREVIS_DIAGNOSTIC_CODES.unknownReference,
        `face "${face}" is not a cast/prop id; the solver will treat it as an anchor name if present.`,
        { path: `${itemPath}.face` },
      ));
    }
    const pose = readOptionalString(record.pose, `${itemPath}.pose`, errors, warnings);
    if (pose && !isSupportedPrevisPosePreset(pose)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unsupportedValue,
        `Unsupported pose "${pose}".`,
        { path: `${itemPath}.pose` },
      ));
    }

    if (subject && placement) {
      result.push({
        subject,
        placement,
        ...(face !== undefined ? { face } : {}),
        ...(pose !== undefined ? { pose } : {}),
      });
    }
  });
  return result;
}

function parsePlacement(
  value: unknown,
  path: string,
  errors: PrevisDiagnostic[],
): PrevisBlockingPlacement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'placement must be an object.', { path }));
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'location_slot') {
    const slot = readEnum(record.slot, PREVIS_LOCATION_SLOTS, `${path}.slot`, errors) as PrevisLocationSlot | undefined;
    if (!slot) return undefined;
    return { type: 'location_slot', slot };
  }
  if (record.type === 'relative') {
    const anchor = readNonemptyString(record.anchor, `${path}.anchor`, errors);
    const relation = readEnum(
      record.relation,
      PREVIS_RELATIVE_RELATIONS,
      `${path}.relation`,
      errors,
    ) as PrevisRelativeRelation | undefined;
    const secondaryAnchor = typeof record.secondaryAnchor === 'string'
      ? record.secondaryAnchor.trim()
      : undefined;
    if (!anchor || !relation) return undefined;
    if (relation === 'between' && !secondaryAnchor) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.invalidCombination,
        'relative.between requires secondaryAnchor.',
        { path: `${path}.secondaryAnchor` },
      ));
      return undefined;
    }
    return {
      type: 'relative',
      anchor,
      relation,
      ...(secondaryAnchor ? { secondaryAnchor } : {}),
    };
  }
  errors.push(previsError(
    PREVIS_DIAGNOSTIC_CODES.unsupportedValue,
    'placement.type must be "location_slot" or "relative".',
    { path: `${path}.type` },
  ));
  return undefined;
}

function parseCamera(
  value: unknown,
  path: string,
  ids: { castIds: Set<string>; propIds: Set<string> },
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisShotDefinition['camera'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.missingField, 'camera must be an object.', { path }));
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const template = readEnum(
    record.template,
    PREVIS_CAMERA_TEMPLATES,
    `${path}.template`,
    errors,
  ) as PrevisCameraTemplate | undefined;
  const subjects = parseStringArray(record.subjects, `${path}.subjects`, errors, true);
  for (const subject of subjects) {
    if (!ids.castIds.has(subject) && !ids.propIds.has(subject)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unknownReference,
        `Unknown camera subject "${subject}".`,
        { path: `${path}.subjects` },
      ));
    }
  }
  const foregroundSubject = readOptionalString(
    record.foregroundSubject,
    `${path}.foregroundSubject`,
    errors,
    warnings,
  );
  if (foregroundSubject && !ids.castIds.has(foregroundSubject) && !ids.propIds.has(foregroundSubject)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.unknownReference,
      `Unknown foregroundSubject "${foregroundSubject}".`,
      { path: `${path}.foregroundSubject` },
    ));
  }
  if (template === 'over_the_shoulder' && !foregroundSubject) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.invalidCombination,
      'over_the_shoulder requires camera.foregroundSubject.',
      { path: `${path}.foregroundSubject` },
    ));
  }
  if (template === 'two_shot' && subjects.length < 2) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.invalidCombination,
      'two_shot requires at least two camera.subjects.',
      { path: `${path}.subjects` },
    ));
  }
  const angle = record.angle === undefined
    ? undefined
    : readEnum(record.angle, PREVIS_CAMERA_ANGLES, `${path}.angle`, errors) as PrevisCameraAngle | undefined;
  const lensClass = record.lensClass === undefined
    ? undefined
    : readEnum(record.lensClass, PREVIS_LENS_CLASSES, `${path}.lensClass`, errors) as PrevisLensClass | undefined;

  if (!template) return undefined;
  return {
    template,
    subjects,
    ...(foregroundSubject !== undefined ? { foregroundSubject } : {}),
    ...(angle !== undefined ? { angle } : {}),
    ...(lensClass !== undefined ? { lensClass } : {}),
  };
}

function coerceJsonRoot(
  input: unknown,
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): Record<string, unknown> | undefined {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const payload = fenced ? fenced[1]! : trimmed;
    try {
      value = JSON.parse(payload);
      if (fenced) {
        warnings.push(previsWarning(
          'markdown_fence',
          'Stripped markdown code fence from manifest input.',
        ));
      }
    } catch {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'Manifest input is not valid JSON.'));
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'Manifest root must be an object.'));
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readId(
  value: unknown,
  path: string,
  seen: Set<string>,
  errors: PrevisDiagnostic[],
): string | undefined {
  const id = readNonemptyString(value, path, errors);
  if (!id) return undefined;
  if (id.length > PREVIS_MANIFEST_LIMITS.maxIdLength) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `id exceeds ${PREVIS_MANIFEST_LIMITS.maxIdLength} characters.`,
      { path },
    ));
    return undefined;
  }
  if (seen.has(id)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.duplicateId,
      `Duplicate id "${id}".`,
      { path, entityId: id },
    ));
    return undefined;
  }
  seen.add(id);
  return id;
}

function readNonemptyString(
  value: unknown,
  path: string,
  errors: PrevisDiagnostic[],
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be a string.`, { path }));
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.emptyField, `${path} must be nonempty.`, { path }));
    return undefined;
  }
  if (trimmed.length > PREVIS_MANIFEST_LIMITS.maxNameLength && path.endsWith('.name')) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `${path} exceeds ${PREVIS_MANIFEST_LIMITS.maxNameLength} characters.`,
      { path },
    ));
    return undefined;
  }
  if (trimmed.length > PREVIS_MANIFEST_LIMITS.maxDescriptionLength && path.endsWith('.description')) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `${path} exceeds ${PREVIS_MANIFEST_LIMITS.maxDescriptionLength} characters.`,
      { path },
    ));
    return undefined;
  }
  return trimmed;
}

function readOptionalString(
  value: unknown,
  path: string,
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be a string.`, { path }));
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    warnings.push(previsWarning(PREVIS_DIAGNOSTIC_CODES.emptyField, `${path} was empty and ignored.`, { path }));
    return undefined;
  }
  return trimmed;
}

function readOptionalPositiveNumber(
  value: unknown,
  path: string,
  errors: PrevisDiagnostic[],
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be a finite number.`, { path }));
    return undefined;
  }
  if (value <= 0) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidRange, `${path} must be positive.`, { path }));
    return undefined;
  }
  if (value > PREVIS_MANIFEST_LIMITS.maxDimensionMeters) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.limitExceeded,
      `${path} exceeds ${PREVIS_MANIFEST_LIMITS.maxDimensionMeters}m.`,
      { path },
    ));
    return undefined;
  }
  return value;
}

function readVec3(
  value: unknown,
  path: string,
  errors: PrevisDiagnostic[],
): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be a 3-number array.`, { path }));
    return undefined;
  }
  const nums = value.map((item, index) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.invalidType,
        `${path}[${index}] must be a finite number.`,
        { path: `${path}[${index}]` },
      ));
      return undefined;
    }
    if (item < PREVIS_MANIFEST_LIMITS.minDimensionMeters || item > PREVIS_MANIFEST_LIMITS.maxDimensionMeters) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.invalidRange,
        `${path}[${index}] must be between ${PREVIS_MANIFEST_LIMITS.minDimensionMeters} and ${PREVIS_MANIFEST_LIMITS.maxDimensionMeters}.`,
        { path: `${path}[${index}]` },
      ));
      return undefined;
    }
    return item;
  });
  if (nums.some((item) => item === undefined)) return undefined;
  return [nums[0]!, nums[1]!, nums[2]!];
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: PrevisDiagnostic[],
): T | undefined {
  if (typeof value !== 'string') {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be a string.`, { path }));
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.unsupportedValue,
      `${path} "${value}" is not supported. Allowed: ${allowed.join(', ')}.`,
      { path },
    ));
    return undefined;
  }
  return value as T;
}

function parseStringArray(
  value: unknown,
  path: string,
  errors: PrevisDiagnostic[],
  required: boolean,
): string[] {
  if (value === undefined || value === null) {
    if (required) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.missingField, `${path} is required.`, { path }));
    }
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be an array.`, { path }));
    return [];
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.invalidType,
        `${path}[${index}] must be a nonempty string.`,
        { path: `${path}[${index}]` },
      ));
      return;
    }
    result.push(entry.trim());
  });
  return result;
}
