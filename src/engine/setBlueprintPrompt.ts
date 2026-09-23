import {
  SET_BLUEPRINT_LIMITS,
  SET_BLUEPRINT_OBJECT_TYPES,
  SET_BLUEPRINT_SCHEMA_VERSION,
  SET_BLUEPRINT_STAGING_ROLES,
  SET_BLUEPRINT_SURFACE_STYLES,
} from '../domain/setBlueprint';

/** Shared schema fragment used by the system prompt so it cannot drift from the validator allowlist. */
export function describeSetBlueprintSchema(): string {
  return [
    `schemaVersion: ${SET_BLUEPRINT_SCHEMA_VERSION} (required)`,
    'name: nonempty string (required)',
    'description: string (optional)',
    'units: "meters" (required)',
    'panoOrigin: [x, y, z] meters (optional; default camera-height origin when omitted)',
    'panoRotation: [rx, ry, rz] degrees Euler (optional; default [0,0,0])',
    'objects: array of SetBlueprintObject (required, 1–250)',
    'landmarks: array of SetBlueprintLandmark (optional, max 100)',
    'assumptions: string[] (optional)',
    '',
    'SetBlueprintObject:',
    '  key: unique nonempty string',
    '  name: nonempty string',
    `  type: one of ${SET_BLUEPRINT_OBJECT_TYPES.join(', ')}`,
    '  position: [centerX, centerY, centerZ] meters (finite, within ±500; center of every object)',
    '  rotation: [rx, ry, rz] degrees (optional; default [0,0,0])',
    '  scale: [sx, sy, sz] (optional; default [1,1,1]; must be positive)',
    '  dimensions: [width, height, depth] meters (0.01–1000)',
    '  hostWallKey: key of a wall in objects (doorway only, optional; useful when walls overlap)',
    `  clearanceAboveMeters: ${SET_BLUEPRINT_LIMITS.minStairClearanceMeters}–${SET_BLUEPRINT_LIMITS.maxStairClearanceMeters} (stairs only, optional; default 2.1)`,
    `  stagingRole: ${SET_BLUEPRINT_STAGING_ROLES.join(' | ')} (optional)`,
    `  surface.style: ${SET_BLUEPRINT_SURFACE_STYLES.join(' | ')} (optional)`,
    '  surface.color / surface.secondaryColor: #rrggbb (optional)',
    '',
    'SetBlueprintLandmark:',
    '  key: unique nonempty string',
    '  displayName: nonempty string',
    '  linkedObjectKey: object key (optional)',
    '  position: [x, y, z] (optional; inferred from linked object when omitted)',
    '  description: string (optional)',
    '  tags: string[] (optional)',
    '  promptCritical: boolean (optional; default true)',
    '',
    `Limits: max ${SET_BLUEPRINT_LIMITS.maxObjects} objects, max ${SET_BLUEPRINT_LIMITS.maxLandmarks} landmarks,`,
    `positions within ±${SET_BLUEPRINT_LIMITS.maxPositionMeters} m,`,
    `dimensions ${SET_BLUEPRINT_LIMITS.minDimensionMeters}–${SET_BLUEPRINT_LIMITS.maxDimensionMeters} m.`,
  ].join('\n');
}

/**
 * Authoritative system prompt for SetBlueprint generation.
 * Keep in the repository so the UI, manual paste workflow, and providers share one contract.
 */
export function buildSetBlueprintSystemPrompt(): string {
  return [
    'You generate graybox film-set spatial blocking as a SetBlueprint JSON document for ForeScene.',
    '',
    'Output rules:',
    '- Respond with JSON only. No markdown fences. No prose before or after the JSON object.',
    '- Emit raw JSON punctuation. Do not escape brackets, underscores, or ordinary JSON punctuation (write [0, 1.65, 0] and hall_floor — never \\[0, 1.65, 0] or hall\\_floor).',
    `- schemaVersion must be ${SET_BLUEPRINT_SCHEMA_VERSION}.`,
    '- units must be "meters".',
    '- Coordinate system: Y-up. Positive Z is the default forward direction from the capture origin.',
    '- Do not emit native ForeScene fields (ids, timestamps, shots, camera keyframes, panoRefs, assets, workflow, settings, productVersion, schemaVersion strings for LocationProject).',
    '- Do not emit imported_model objects. An LLM cannot manufacture mesh assets.',
    '',
    'Spatial guidance:',
    '- Use individual continuous wall objects rather than one vague "room" object.',
    '- Prefer realistic dimensions for architecture, props, and people.',
    '- Place each doorway so its volume overlaps one compatible wall with the same yaw; ForeScene cuts that wall automatically. Use hostWallKey when more than one wall overlaps. Do not split a wall around a doorway.',
    '- A standalone arch is visible geometry; use doorway for a semantic wall opening.',
    '- Place stairs so their top meets an upper floor/slab. ForeScene cuts the nearest eligible upper layer inside the stair clearance footprint; it does not remove walls or props.',
    '- Every position is the object center, including floors, walls, doorways, stairs, and people. Rotations are degrees and dimensions are [X width, Y height, Z depth].',
    '- For a ground floor with top at Y=0, set centerY to -height/2. For a ground-level upright object, set centerY to height/2. At upper levels, add the level elevation to those center values.',
    '- Include enough open floor for the described action.',
    '- Prefer a clear capture origin near the center of the set, typically eye height (~1.65 m) on Y.',
    '',
    'Allowed primitives:',
    SET_BLUEPRINT_OBJECT_TYPES.map((type) => `- ${type}`).join('\n'),
    '',
    'Schema:',
    describeSetBlueprintSchema(),
  ].join('\n');
}

export function buildSetBlueprintUserPrompt(params: {
  description: string;
  approximateWidthMeters?: number;
  approximateDepthMeters?: number;
  detailLevel?: 'simple' | 'standard' | 'detailed';
  constraints?: string;
}): string {
  const lines = [
    'Create a SetBlueprint for the following set description:',
    params.description.trim(),
  ];
  if (params.approximateWidthMeters !== undefined || params.approximateDepthMeters !== undefined) {
    const width = params.approximateWidthMeters ?? '?';
    const depth = params.approximateDepthMeters ?? '?';
    lines.push('', `Approximate footprint: ${width} × ${depth} meters (width × depth).`);
  }
  if (params.detailLevel) {
    lines.push(`Detail level: ${params.detailLevel}.`);
  }
  if (params.constraints?.trim()) {
    lines.push('', 'Additional constraints:', params.constraints.trim());
  }
  lines.push('', 'Return the full SetBlueprint JSON object now.');
  return lines.join('\n');
}

/** Prompt used when asking a model to repair a failed blueprint. */
export function buildSetBlueprintRepairPrompt(params: {
  originalOutput: string;
  errorMessages: string[];
}): string {
  return [
    'The previous SetBlueprint JSON failed validation.',
    'Return a corrected full SetBlueprint JSON object only (no markdown, no commentary).',
    '',
    'Validation errors:',
    ...params.errorMessages.map((message) => `- ${message}`),
    '',
    'Previous output to correct:',
    params.originalOutput,
  ].join('\n');
}
