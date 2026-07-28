import {
  BlueprintDiagnostic,
  SET_BLUEPRINT_LIMITS,
  SET_BLUEPRINT_OBJECT_TYPES,
  SET_BLUEPRINT_SCHEMA_VERSION,
  SET_BLUEPRINT_STAGING_ROLES,
  SET_BLUEPRINT_SURFACE_STYLES,
  SetBlueprint,
  SetBlueprintLandmark,
  SetBlueprintObject,
  SetBlueprintObjectType,
  SetBlueprintParseResult,
  SetBlueprintSurfaceStyle,
} from '../domain/setBlueprint';
import type { Euler, StagingRole, Vec3 } from '../domain/types';

const ALLOWED_TYPES = new Set<string>(SET_BLUEPRINT_OBJECT_TYPES);
const ALLOWED_SURFACE_STYLES = new Set<string>(SET_BLUEPRINT_SURFACE_STYLES);
const ALLOWED_STAGING_ROLES = new Set<string>(SET_BLUEPRINT_STAGING_ROLES);

/**
 * Hand-written SetBlueprint parser.
 * Independent of React, Zustand, and network code.
 * Valid blueprints parse without mutation of the caller's input object graph
 * (the returned blueprint is a freshly built normalized document).
 */
export function parseSetBlueprint(input: unknown): SetBlueprintParseResult {
  const errors: BlueprintDiagnostic[] = [];
  const warnings: BlueprintDiagnostic[] = [];

  const root = coerceJsonRoot(input, errors);
  if (!root) {
    return { errors, warnings };
  }

  const schemaVersion = root.schemaVersion;
  if (schemaVersion !== SET_BLUEPRINT_SCHEMA_VERSION) {
    errors.push({
      code: 'schema_version',
      message: `schemaVersion must be ${SET_BLUEPRINT_SCHEMA_VERSION}.`,
      path: 'schemaVersion',
    });
  }

  const name = readNonemptyString(root.name, 'name', errors);
  const description = readOptionalString(root.description, 'description', errors, warnings);
  const units = root.units;
  if (units !== 'meters') {
    errors.push({
      code: 'units',
      message: 'units must be "meters".',
      path: 'units',
    });
  }

  const panoOrigin = root.panoOrigin === undefined
    ? undefined
    : readVec3(root.panoOrigin, 'panoOrigin', errors, { requireFinite: true, requireInRange: true });
  const panoRotation = root.panoRotation === undefined
    ? undefined
    : readEuler(root.panoRotation, 'panoRotation', errors);

  if (!Array.isArray(root.objects)) {
    errors.push({
      code: 'objects_missing',
      message: 'objects must be an array.',
      path: 'objects',
    });
  } else if (root.objects.length === 0) {
    errors.push({
      code: 'objects_empty',
      message: 'objects must contain at least one object.',
      path: 'objects',
    });
  } else if (root.objects.length > SET_BLUEPRINT_LIMITS.maxObjects) {
    errors.push({
      code: 'objects_limit',
      message: `objects exceeds the maximum of ${SET_BLUEPRINT_LIMITS.maxObjects}.`,
      path: 'objects',
    });
  }

  const objectKeys = new Set<string>();
  const objects: SetBlueprintObject[] = [];
  if (Array.isArray(root.objects)) {
    root.objects.forEach((raw, index) => {
      const parsed = parseObject(raw, index, objectKeys, errors, warnings);
      if (parsed) objects.push(parsed);
    });
  }

  const landmarks: SetBlueprintLandmark[] = [];
  if (root.landmarks !== undefined) {
    if (!Array.isArray(root.landmarks)) {
      errors.push({
        code: 'landmarks_type',
        message: 'landmarks must be an array when provided.',
        path: 'landmarks',
      });
    } else if (root.landmarks.length > SET_BLUEPRINT_LIMITS.maxLandmarks) {
      errors.push({
        code: 'landmarks_limit',
        message: `landmarks exceeds the maximum of ${SET_BLUEPRINT_LIMITS.maxLandmarks}.`,
        path: 'landmarks',
      });
    } else {
      const landmarkKeys = new Set<string>();
      root.landmarks.forEach((raw, index) => {
        const parsed = parseLandmark(raw, index, landmarkKeys, objectKeys, errors, warnings);
        if (parsed) landmarks.push(parsed);
      });
    }
  }

  const assumptions = parseAssumptions(root.assumptions, errors, warnings);

  rejectNativeProjectFields(root, warnings);

  if (errors.length > 0) {
    return { errors, warnings };
  }

  if (!name || units !== 'meters' || schemaVersion !== SET_BLUEPRINT_SCHEMA_VERSION) {
    return { errors, warnings };
  }

  const blueprint: SetBlueprint = {
    schemaVersion: SET_BLUEPRINT_SCHEMA_VERSION,
    name,
    units: 'meters',
    objects,
  };
  if (description !== undefined) blueprint.description = description;
  if (panoOrigin) blueprint.panoOrigin = panoOrigin;
  if (panoRotation) blueprint.panoRotation = panoRotation;
  if (landmarks.length > 0) blueprint.landmarks = landmarks;
  if (assumptions && assumptions.length > 0) blueprint.assumptions = assumptions;

  return { blueprint, errors, warnings };
}

/** Extract JSON from unknown input, including prose-wrapped model output. */
function coerceJsonRoot(
  input: unknown,
  errors: BlueprintDiagnostic[],
): Record<string, unknown> | undefined {
  if (input === null || input === undefined) {
    errors.push({ code: 'empty', message: 'Blueprint input is empty.', path: '' });
    return undefined;
  }

  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      errors.push({ code: 'empty', message: 'Blueprint input is empty.', path: '' });
      return undefined;
    }
    const extracted = extractJsonObject(trimmed);
    if (extracted === undefined || extracted === null) {
      errors.push({
        code: 'json_parse',
        message: 'Could not parse blueprint JSON. Provide a single JSON object with no markdown fences.',
        path: '',
      });
      return undefined;
    }
    value = extracted;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      code: 'root_type',
      message: 'Blueprint root must be a JSON object.',
      path: '',
    });
    return undefined;
  }

  return value as Record<string, unknown>;
}

function extractJsonObject(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Fall through — try fence or prose-wrapped JSON.
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as unknown;
    } catch {
      // continue
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseObject(
  raw: unknown,
  index: number,
  objectKeys: Set<string>,
  errors: BlueprintDiagnostic[],
  warnings: BlueprintDiagnostic[],
): SetBlueprintObject | undefined {
  const path = `objects[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'object_type', message: 'Object entry must be an object.', path });
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const key = readNonemptyString(record.key, `${path}.key`, errors);
  if (key) {
    if (objectKeys.has(key)) {
      errors.push({
        code: 'duplicate_object_key',
        message: `Duplicate object key "${key}".`,
        path: `${path}.key`,
        key,
      });
    } else {
      objectKeys.add(key);
    }
  }

  const name = readNonemptyString(record.name, `${path}.name`, errors, key);
  const type = readObjectType(record.type, `${path}.type`, errors, key);
  const position = readVec3(record.position, `${path}.position`, errors, {
    requireFinite: true,
    requireInRange: true,
    key,
  });
  const rotation = record.rotation === undefined
    ? undefined
    : readEuler(record.rotation, `${path}.rotation`, errors, key);
  const scale = record.scale === undefined
    ? undefined
    : readScale(record.scale, `${path}.scale`, errors, warnings, key);
  const dimensions = readDimensions(record.dimensions, `${path}.dimensions`, errors, key);
  const stagingRole = readStagingRole(record.stagingRole, `${path}.stagingRole`, errors, key);
  const surface = parseSurface(record.surface, `${path}.surface`, errors, key);

  if (!key || !name || !type || !position || !dimensions) return undefined;

  const object: SetBlueprintObject = {
    key,
    name,
    type,
    position,
    dimensions,
  };
  if (rotation) object.rotation = rotation;
  if (scale) object.scale = scale;
  if (stagingRole) object.stagingRole = stagingRole;
  if (surface) object.surface = surface;
  return object;
}

function parseLandmark(
  raw: unknown,
  index: number,
  landmarkKeys: Set<string>,
  objectKeys: Set<string>,
  errors: BlueprintDiagnostic[],
  warnings: BlueprintDiagnostic[],
): SetBlueprintLandmark | undefined {
  const path = `landmarks[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'landmark_type', message: 'Landmark entry must be an object.', path });
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const key = readNonemptyString(record.key, `${path}.key`, errors);
  if (key) {
    if (landmarkKeys.has(key)) {
      errors.push({
        code: 'duplicate_landmark_key',
        message: `Duplicate landmark key "${key}".`,
        path: `${path}.key`,
        key,
      });
    } else {
      landmarkKeys.add(key);
    }
  }

  const displayName = readNonemptyString(record.displayName, `${path}.displayName`, errors, key);
  const linkedObjectKey = readOptionalString(record.linkedObjectKey, `${path}.linkedObjectKey`, errors, warnings, key);
  if (linkedObjectKey && !objectKeys.has(linkedObjectKey)) {
    errors.push({
      code: 'landmark_link',
      message: `Landmark "${key ?? index}" links to unknown object key "${linkedObjectKey}".`,
      path: `${path}.linkedObjectKey`,
      key: key ?? undefined,
    });
  }

  const position = record.position === undefined
    ? undefined
    : readVec3(record.position, `${path}.position`, errors, {
      requireFinite: true,
      requireInRange: true,
      key,
    });
  const description = readOptionalString(record.description, `${path}.description`, errors, warnings, key);
  const tags = parseStringArray(record.tags, `${path}.tags`, errors, key);
  let promptCritical: boolean | undefined;
  if (record.promptCritical !== undefined) {
    if (typeof record.promptCritical !== 'boolean') {
      errors.push({
        code: 'prompt_critical_type',
        message: 'promptCritical must be a boolean when provided.',
        path: `${path}.promptCritical`,
        key: key ?? undefined,
      });
    } else {
      promptCritical = record.promptCritical;
    }
  }

  if (!key || !displayName) return undefined;

  const landmark: SetBlueprintLandmark = { key, displayName };
  if (linkedObjectKey) landmark.linkedObjectKey = linkedObjectKey;
  if (position) landmark.position = position;
  if (description !== undefined) landmark.description = description;
  if (tags) landmark.tags = tags;
  if (promptCritical !== undefined) landmark.promptCritical = promptCritical;
  return landmark;
}

function parseSurface(
  raw: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): SetBlueprintObject['surface'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      code: 'surface_type',
      message: 'surface must be an object when provided.',
      path,
      key,
    });
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const styleRaw = record.style;
  if (typeof styleRaw !== 'string' || !ALLOWED_SURFACE_STYLES.has(styleRaw)) {
    errors.push({
      code: 'surface_style',
      message: `surface.style must be one of: ${SET_BLUEPRINT_SURFACE_STYLES.join(', ')}.`,
      path: `${path}.style`,
      key,
    });
    return undefined;
  }
  const style = styleRaw as SetBlueprintSurfaceStyle;
  const color = readOptionalColor(record.color, `${path}.color`, errors, key);
  const secondaryColor = readOptionalColor(record.secondaryColor, `${path}.secondaryColor`, errors, key);
  const surface: SetBlueprintObject['surface'] = { style };
  if (color) surface.color = color;
  if (secondaryColor) surface.secondaryColor = secondaryColor;
  return surface;
}

function parseAssumptions(
  raw: unknown,
  errors: BlueprintDiagnostic[],
  warnings: BlueprintDiagnostic[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push({
      code: 'assumptions_type',
      message: 'assumptions must be an array of strings when provided.',
      path: 'assumptions',
    });
    return undefined;
  }
  const assumptions: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push({
        code: 'assumption_type',
        message: 'Each assumption must be a string.',
        path: `assumptions[${index}]`,
      });
      return;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      warnings.push({
        code: 'assumption_empty',
        message: 'Empty assumption entries are ignored.',
        path: `assumptions[${index}]`,
      });
      return;
    }
    assumptions.push(trimmed);
  });
  return assumptions;
}

function parseStringArray(
  raw: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push({
      code: 'tags_type',
      message: 'tags must be an array of strings when provided.',
      path,
      key,
    });
    return undefined;
  }
  const tags: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push({
        code: 'tag_type',
        message: 'Each tag must be a string.',
        path: `${path}[${index}]`,
        key,
      });
      return;
    }
    tags.push(entry);
  });
  return tags;
}

function readObjectType(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): SetBlueprintObjectType | undefined {
  if (typeof value !== 'string') {
    errors.push({
      code: 'object_type_missing',
      message: 'Object type must be a string.',
      path,
      key,
    });
    return undefined;
  }
  if (value === 'imported_model') {
    errors.push({
      code: 'imported_model_forbidden',
      message: 'imported_model is not allowed in SetBlueprint v1 (no mesh asset can be manufactured).',
      path,
      key,
    });
    return undefined;
  }
  if (!ALLOWED_TYPES.has(value)) {
    errors.push({
      code: 'object_type_unknown',
      message: `Unknown object type "${value}". Allowed: ${SET_BLUEPRINT_OBJECT_TYPES.join(', ')}.`,
      path,
      key,
    });
    return undefined;
  }
  return value as SetBlueprintObjectType;
}

function readStagingRole(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): StagingRole | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ALLOWED_STAGING_ROLES.has(value)) {
    errors.push({
      code: 'staging_role',
      message: `stagingRole must be one of: ${SET_BLUEPRINT_STAGING_ROLES.join(', ')}.`,
      path,
      key,
    });
    return undefined;
  }
  return value as StagingRole;
}

function readVec3(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  options: { requireFinite: boolean; requireInRange?: boolean; key?: string },
): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) {
    errors.push({
      code: 'vec3_shape',
      message: `${path} must be an array of three numbers.`,
      path,
      key: options.key,
    });
    return undefined;
  }
  const numbers = value.map((entry, axis) => {
    if (typeof entry !== 'number' || (options.requireFinite && !Number.isFinite(entry))) {
      errors.push({
        code: 'vec3_finite',
        message: `${path}[${axis}] must be a finite number.`,
        path: `${path}[${axis}]`,
        key: options.key,
      });
      return undefined;
    }
    if (options.requireInRange && Math.abs(entry) > SET_BLUEPRINT_LIMITS.maxPositionMeters) {
      errors.push({
        code: 'position_range',
        message: `${path}[${axis}] must be within ±${SET_BLUEPRINT_LIMITS.maxPositionMeters} meters.`,
        path: `${path}[${axis}]`,
        key: options.key,
      });
      return undefined;
    }
    return entry;
  });
  if (numbers.some((n) => n === undefined)) return undefined;
  return numbers as Vec3;
}

function readEuler(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): Euler | undefined {
  return readVec3(value, path, errors, { requireFinite: true, key });
}

function readScale(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  warnings: BlueprintDiagnostic[],
  key?: string,
): Vec3 | undefined {
  const scale = readVec3(value, path, errors, { requireFinite: true, key });
  if (!scale) return undefined;
  let valid = true;
  scale.forEach((component, axis) => {
    if (component <= 0) {
      errors.push({
        code: 'scale_positive',
        message: `${path}[${axis}] must be positive.`,
        path: `${path}[${axis}]`,
        key,
      });
      valid = false;
    } else if (
      component < SET_BLUEPRINT_LIMITS.extremeScaleMin
      || component > SET_BLUEPRINT_LIMITS.extremeScaleMax
    ) {
      warnings.push({
        code: 'scale_extreme',
        message: `${path}[${axis}] = ${component} is an extreme scale; left unchanged.`,
        path: `${path}[${axis}]`,
        key,
      });
    }
  });
  return valid ? scale : undefined;
}

function readDimensions(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): Vec3 | undefined {
  const dimensions = readVec3(value, path, errors, { requireFinite: true, key });
  if (!dimensions) return undefined;
  let valid = true;
  dimensions.forEach((component, axis) => {
    if (component < SET_BLUEPRINT_LIMITS.minDimensionMeters
      || component > SET_BLUEPRINT_LIMITS.maxDimensionMeters) {
      errors.push({
        code: 'dimension_range',
        message: `${path}[${axis}] must be between ${SET_BLUEPRINT_LIMITS.minDimensionMeters} and ${SET_BLUEPRINT_LIMITS.maxDimensionMeters} meters.`,
        path: `${path}[${axis}]`,
        key,
      });
      valid = false;
    }
  });
  return valid ? dimensions : undefined;
}

function readNonemptyString(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): string | undefined {
  if (typeof value !== 'string') {
    errors.push({
      code: 'string_type',
      message: `${path} must be a nonempty string.`,
      path,
      key,
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    errors.push({
      code: 'string_empty',
      message: `${path} must be a nonempty string.`,
      path,
      key,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalString(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  warnings: BlueprintDiagnostic[],
  key?: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    errors.push({
      code: 'string_type',
      message: `${path} must be a string when provided.`,
      path,
      key,
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    warnings.push({
      code: 'string_blank',
      message: `${path} is blank and will be omitted.`,
      path,
      key,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalColor(
  value: unknown,
  path: string,
  errors: BlueprintDiagnostic[],
  key?: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    errors.push({
      code: 'color_type',
      message: `${path} must be a hex color string (#rrggbb).`,
      path,
      key,
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  errors.push({
    code: 'color_format',
    message: `${path} must be a hex color (#rrggbb).`,
    path,
    key,
  });
  return undefined;
}

/** Soft-warn if the model accidentally echoed native LocationProject fields. */
function rejectNativeProjectFields(
  root: Record<string, unknown>,
  warnings: BlueprintDiagnostic[],
): void {
  const forbidden = [
    'id',
    'createdAt',
    'updatedAt',
    'shots',
    'panoRefs',
    'assets',
    'workflow',
    'settings',
    'productVersion',
    'scene',
  ] as const;
  for (const field of forbidden) {
    if (field in root) {
      warnings.push({
        code: 'native_field_ignored',
        message: `Native project field "${field}" is ignored in SetBlueprint input.`,
        path: field,
      });
    }
  }
}
