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
  PREVIS_ASSET_IMPORT_MODES,
  PREVIS_ASSET_TYPES,
  PREVIS_IMPORTED_CHARACTER_RIG_MODES,
  PREVIS_MANIFEST_LIMITS,
  PREVIS_MANIFEST_VERSIONS,
  PREVIS_SEMANTIC_ROLES,
  PREVIS_PROP_PRIMITIVES,
  PREVIS_RELATIVE_RELATIONS,
  type PrevisAspectRatio,
  type PrevisBlockingInstruction,
  type PrevisBlockingPlacement,
  type PrevisCameraAngle,
  type PrevisCameraTemplate,
  type PrevisCharacterDefinition,
  type PrevisAssetDefinition,
  type PrevisAssetImportMode,
  type PrevisAssetType,
  type PrevisImportedCharacterRigMode,
  type PrevisLensClass,
  type PrevisLocationDefinition,
  type PrevisLocationFeatureType,
  type PrevisLocationSlot,
  type PrevisLocationTemplate,
  type PrevisProductionManifestV1,
  type PrevisPropDefinition,
  type PrevisPropPrimitive,
  type PrevisRelativeRelation,
  type PrevisSemanticRole,
  type PrevisShotDefinition,
  type PrevisShotMotion,
  type PrevisShotMotionKeyframe,
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

  if (!(PREVIS_MANIFEST_VERSIONS as readonly number[]).includes(root.version as number)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.schemaVersion,
      `version must be ${PREVIS_MANIFEST_VERSIONS.join(' or ')}.`,
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
  const operatingMode = projectRecord.operatingMode === undefined
    ? undefined
    : readEnum(
      projectRecord.operatingMode,
      ['greenfield', 'existing-project-refinement'] as const,
      'project.operatingMode',
      errors,
    );

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
  const assetIds = new Set<string>();
  const shotIds = new Set<string>();
  const shotNumbers = new Set<string>();

  const locations = parseLocations(root.locations, locationIds, errors, warnings);
  const cast = parseCast(root.cast, castIds, errors, warnings);
  const props = root.props === undefined
    ? undefined
    : parseProps(root.props, propIds, errors, warnings);
  const assets = root.assets === undefined
    ? undefined
    : parseAssets(root.assets, assetIds, errors, warnings);
  if (cast.length === 0 && (assets?.length ?? 0) === 0) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.emptyField,
      'cast must contain at least one character, or assets must declare a subject.',
      { path: 'cast' },
    ));
  }

  const shots = parseShots(
    root.shots,
    {
      locationIds,
      castIds,
      propIds,
      assetIds,
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
    version: root.version === 2 ? 2 : 1,
    project: {
      name: projectName,
      aspectRatio,
      ...(projectDescription !== undefined ? { description: projectDescription } : {}),
      ...(frameRate !== undefined ? { frameRate } : {}),
      ...(operatingMode !== undefined ? { operatingMode } : {}),
    },
    locations,
    cast,
    ...(props !== undefined ? { props } : {}),
    ...(assets !== undefined ? { assets } : {}),
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
    const type = record.type;
    if (type !== 'human_dummy' && type !== 'imported_character') {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unsupportedValue,
        'character.type must be "human_dummy" or "imported_character".',
        { path: `${path}.type`, entityId: id },
      ));
    }
    const name = record.name === undefined && type === 'imported_character'
      ? id
      : readNonemptyString(record.name, `${path}.name`, errors);
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

    if (type === 'imported_character') {
      const source = readNonemptyString(record.source, `${path}.source`, errors);
      const rigMode = readEnum(
        record.rigMode,
        PREVIS_IMPORTED_CHARACTER_RIG_MODES,
        `${path}.rigMode`,
        errors,
      ) as PrevisImportedCharacterRigMode | undefined;
      if (source && !/\.(?:glb|gltf|fbx)$/i.test(source)) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.unsupportedValue,
          'source must point to a GLB, embedded glTF, or FBX file.',
          { path: `${path}.source`, entityId: id },
        ));
      }
      if (!source) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.missingImportedCharacterSource,
          'Imported characters require an explicit model source path.',
          { path: `${path}.source`, entityId: id },
        ));
      }
      const rigPackage = readOptionalString(
        record.rigPackage,
        `${path}.rigPackage`,
        errors,
        warnings,
      );
      if (rigMode === 'saved-rig') {
        if (!rigPackage) {
          errors.push(previsError(
            PREVIS_DIAGNOSTIC_CODES.missingSavedRigPackage,
            'rigPackage is required when rigMode is "saved-rig".',
            { path: `${path}.rigPackage`, entityId: id },
          ));
        } else if (!/\.(?:fsrig|panorig)$/i.test(rigPackage) || /[\\/]\s*$/.test(rigPackage)) {
          errors.push(previsError(
            PREVIS_DIAGNOSTIC_CODES.unsupportedSavedRigExtension,
            'rigPackage must point to a .fsrig or legacy .panorig file.',
            { path: `${path}.rigPackage`, entityId: id },
          ));
        }
      } else if (rigPackage !== undefined) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.unexpectedRigPackage,
          'rigPackage is only allowed when rigMode is "saved-rig".',
          { path: `${path}.rigPackage`, entityId: id },
        ));
      }
      if (id && name && source && rigMode) {
        result.push({
          id,
          name,
          type: 'imported_character',
          source,
          rigMode,
          ...(rigPackage !== undefined ? { rigPackage } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(defaultPose !== undefined ? { defaultPose } : {}),
        });
      }
    } else if (id && name && type === 'human_dummy') {
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

function parseAssets(
  value: unknown,
  assetIds: Set<string>,
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisAssetDefinition[] {
  if (!Array.isArray(value)) {
    errors.push(previsError(
      PREVIS_DIAGNOSTIC_CODES.invalidType,
      'assets must be an array when provided.',
      { path: 'assets' },
    ));
    return [];
  }
  const result: PrevisAssetDefinition[] = [];
  value.forEach((entry, index) => {
    const path = `assets[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'asset must be an object.', { path }));
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = readId(record.id, `${path}.id`, assetIds, errors);
    const type = readEnum(record.type, PREVIS_ASSET_TYPES, `${path}.type`, errors) as PrevisAssetType | undefined;
    const source = readOptionalString(record.source, `${path}.source`, errors, warnings);
    const importMode = record.importMode === undefined
      ? undefined
      : readEnum(record.importMode, PREVIS_ASSET_IMPORT_MODES, `${path}.importMode`, errors) as PrevisAssetImportMode | undefined;
    const semanticRole = record.semanticRole === undefined
      ? undefined
      : readEnum(record.semanticRole, PREVIS_SEMANTIC_ROLES, `${path}.semanticRole`, errors) as PrevisSemanticRole | undefined;
    const required = typeof record.required === 'boolean' ? record.required : undefined;
    const rigMode = record.rigMode === undefined
      ? undefined
      : readEnum(record.rigMode, PREVIS_IMPORTED_CHARACTER_RIG_MODES, `${path}.rigMode`, errors) as PrevisImportedCharacterRigMode | undefined;
    const rigPackage = readOptionalString(record.rigPackage, `${path}.rigPackage`, errors, warnings);
    const replaceProxy = readOptionalString(record.replaceProxy, `${path}.replaceProxy`, errors, warnings);

    if (type === 'imported_model' && importMode === 'character') {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.semanticTypeMismatch,
        'An ordinary imported_model cannot use importMode "character".',
        { path: `${path}.importMode`, entityId: id },
      ));
    }
    if (type === 'imported_model' && semanticRole === 'character') {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.semanticTypeMismatch,
        'semanticRole "character" requires type imported_character or saved_rig, not imported_model.',
        { path: `${path}.semanticRole`, entityId: id },
      ));
    }
    if (type === 'imported_model' && (rigMode || rigPackage)) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.unexpectedCharacterRig,
        'Ordinary imported models cannot declare rigMode or rigPackage.',
        { path: `${path}.rigMode`, entityId: id },
      ));
    }
    if ((type === 'imported_character' || type === 'saved_rig' || importMode === 'character' || importMode === 'saved_rig')
      && (rigMode === 'saved-rig' || type === 'saved_rig' || importMode === 'saved_rig')
      && !rigPackage) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.missingSavedRigPackage,
        'rigPackage is required when the asset is declared as a saved-rig character.',
        { path: `${path}.rigPackage`, entityId: id },
      ));
    }
    if ((type === 'imported_model' || type === 'imported_character' || type === 'panorama' || type === 'image' || type === 'video')
      && !source
      && required !== false) {
      errors.push(previsError(
        PREVIS_DIAGNOSTIC_CODES.missingAssetSource,
        `Asset "${id ?? path}" requires a source path.`,
        { path: `${path}.source`, entityId: id },
      ));
    }

    if (id && type) {
      result.push({
        id,
        type,
        ...(source !== undefined ? { source } : {}),
        ...(importMode !== undefined ? { importMode } : {}),
        ...(semanticRole !== undefined ? { semanticRole } : {}),
        ...(required !== undefined ? { required } : {}),
        ...(rigMode !== undefined ? { rigMode } : {}),
        ...(rigPackage !== undefined ? { rigPackage } : {}),
        ...(replaceProxy !== undefined ? { replaceProxy } : {}),
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
    assetIds: Set<string>;
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
      if (!ids.castIds.has(subject) && !ids.propIds.has(subject) && !ids.assetIds.has(subject)) {
        errors.push(previsError(
          PREVIS_DIAGNOSTIC_CODES.unknownReference,
          `Unknown subject "${subject}" (not in cast, props, or assets).`,
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

    const motion = record.motion === undefined
      ? undefined
      : parseShotMotion(record.motion, `${path}.motion`, ids, errors, warnings);

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
        ...(motion ? { motion } : {}),
      });
    }
  });

  return result;
}

function parseShotMotion(
  value: unknown,
  path: string,
  ids: { castIds: Set<string>; propIds: Set<string>; assetIds?: Set<string> },
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisShotMotion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'motion must be an object.', { path }));
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const durationSeconds = readOptionalPositiveNumber(record.durationSeconds, `${path}.durationSeconds`, errors);
  const renderControlVideo = record.renderControlVideo === undefined
    ? undefined
    : Boolean(record.renderControlVideo);
  if (record.renderControlVideo !== undefined && typeof record.renderControlVideo !== 'boolean') {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path}.renderControlVideo must be a boolean.`, { path: `${path}.renderControlVideo` }));
  }
  if (!Array.isArray(record.keyframes) || record.keyframes.length < 2) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidRange, `${path}.keyframes must contain at least two entries.`, { path: `${path}.keyframes` }));
    return undefined;
  }
  const keyframes = record.keyframes.flatMap((entry, index) => {
    const itemPath = `${path}.keyframes[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'motion keyframe must be an object.', { path: itemPath }));
      return [];
    }
    const item = entry as Record<string, unknown>;
    const timeSeconds = readNonnegativeNumber(item.timeSeconds, `${itemPath}.timeSeconds`, errors);
    let camera: PrevisShotMotionKeyframe['camera'] | undefined;
    if (item.camera !== undefined) {
      if (!item.camera || typeof item.camera !== 'object' || Array.isArray(item.camera)) {
        errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'camera must be an object.', { path: `${itemPath}.camera` }));
      } else {
        const raw = item.camera as Record<string, unknown>;
        const position = raw.position === undefined ? undefined : readFiniteVec3(raw.position, `${itemPath}.camera.position`, errors);
        const target = raw.target === undefined ? undefined : readFiniteVec3(raw.target, `${itemPath}.camera.target`, errors);
        const fovDegrees = raw.fovDegrees === undefined ? undefined : readOptionalPositiveNumber(raw.fovDegrees, `${itemPath}.camera.fovDegrees`, errors);
        camera = { ...(position ? { position } : {}), ...(target ? { target } : {}), ...(fovDegrees !== undefined ? { fovDegrees } : {}) };
      }
    }
    const staging = parseMotionStaging(item.staging, `${itemPath}.staging`, ids, errors, warnings);
    return timeSeconds === undefined ? [] : [{ timeSeconds, ...(camera ? { camera } : {}), ...(staging ? { staging } : {}) }];
  });
  for (let index = 1; index < keyframes.length; index += 1) {
    if (keyframes[index]!.timeSeconds <= keyframes[index - 1]!.timeSeconds) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidRange, 'motion keyframe times must be strictly increasing.', { path: `${path}.keyframes` }));
      break;
    }
  }
  if (durationSeconds === undefined) return undefined;
  if (keyframes.length < 2 || keyframes[keyframes.length - 1]!.timeSeconds !== durationSeconds) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidRange, 'motion durationSeconds must equal the final keyframe time.', { path }));
    return undefined;
  }
  return { durationSeconds, ...(renderControlVideo !== undefined ? { renderControlVideo } : {}), keyframes };
}

function parseMotionStaging(
  value: unknown,
  path: string,
  ids: { castIds: Set<string>; propIds: Set<string>; assetIds?: Set<string> },
  errors: PrevisDiagnostic[],
  warnings: PrevisDiagnostic[],
): PrevisShotMotionKeyframe['staging'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'staging must be an array.', { path }));
    return undefined;
  }
  return value.flatMap((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'staging entry must be an object.', { path: itemPath }));
      return [];
    }
    const item = entry as Record<string, unknown>;
    const subject = readNonemptyString(item.subject, `${itemPath}.subject`, errors);
    if (subject && !ids.castIds.has(subject) && !ids.propIds.has(subject) && !ids.assetIds?.has(subject)) errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.unknownReference, `Unknown motion subject "${subject}".`, { path: `${itemPath}.subject` }));
    const visible = item.visible === undefined ? undefined : Boolean(item.visible);
    if (item.visible !== undefined && typeof item.visible !== 'boolean') errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'visible must be a boolean.', { path: `${itemPath}.visible` }));
    let transform: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] } | undefined;
    if (item.transform !== undefined) {
      if (!item.transform || typeof item.transform !== 'object' || Array.isArray(item.transform)) errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, 'transform must be an object.', { path: `${itemPath}.transform` }));
      else {
        const raw = item.transform as Record<string, unknown>;
        const position = raw.position === undefined ? undefined : readFiniteVec3(raw.position, `${itemPath}.transform.position`, errors);
        const rotation = raw.rotation === undefined ? undefined : readFiniteVec3(raw.rotation, `${itemPath}.transform.rotation`, errors);
        const scale = raw.scale === undefined ? undefined : readFiniteVec3(raw.scale, `${itemPath}.transform.scale`, errors);
        transform = { ...(position ? { position } : {}), ...(rotation ? { rotation } : {}), ...(scale ? { scale } : {}) };
      }
    }
    const posePreset = readOptionalString(item.posePreset, `${itemPath}.posePreset`, errors, warnings);
    return subject ? [{ subject, ...(visible !== undefined ? { visible } : {}), ...(transform ? { transform } : {}), ...(posePreset ? { posePreset } : {}) }] : [];
  });
}

function parseBlocking(
  value: unknown,
  path: string,
  ids: { castIds: Set<string>; propIds: Set<string>; assetIds?: Set<string> },
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
    if (subject && !ids.castIds.has(subject) && !ids.propIds.has(subject) && !ids.assetIds?.has(subject)) {
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
  ids: { castIds: Set<string>; propIds: Set<string>; assetIds?: Set<string> },
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
    if (!ids.castIds.has(subject) && !ids.propIds.has(subject) && !ids.assetIds?.has(subject)) {
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

function readNonnegativeNumber(value: unknown, path: string, errors: PrevisDiagnostic[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be a finite number.`, { path }));
    return undefined;
  }
  if (value < 0) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidRange, `${path} must be nonnegative.`, { path }));
    return undefined;
  }
  return value;
}

function readFiniteVec3(
  value: unknown,
  path: string,
  errors: PrevisDiagnostic[],
): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    errors.push(previsError(PREVIS_DIAGNOSTIC_CODES.invalidType, `${path} must be a 3-number array.`, { path }));
    return undefined;
  }
  return [value[0] as number, value[1] as number, value[2] as number];
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
