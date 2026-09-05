import {
  PREVIS_CAMERA_ANGLES,
  PREVIS_CAMERA_TEMPLATES,
  PREVIS_LENS_CLASSES,
  PREVIS_LOCATION_SLOTS,
  PREVIS_RELATIVE_RELATIONS,
  type PrevisBlockingInstruction,
  type PrevisCameraAngle,
  type PrevisCameraTemplate,
  type PrevisLensClass,
  type PrevisProductionManifestV1,
  type PrevisShotDefinition,
  type PrevisShotMotion,
  type PrevisShotMotionKeyframe,
} from '../../src/engine/previs/manifest';
import type { V3AgentContract, V3AgentIntent } from './v3AgentContract';

export interface V3AgentPlanCamera {
  template: PrevisCameraTemplate;
  subjects: string[];
  foregroundSubject?: string;
  angle?: PrevisCameraAngle;
  lensClass?: PrevisLensClass;
}

export interface V3AgentCandidatePlan {
  version: 1;
  shots: Array<{
    shotNumber: '01' | '02' | '03';
    camera: V3AgentPlanCamera;
    blocking: PrevisBlockingInstruction[];
    motion?: PrevisShotMotion;
  }>;
}

export interface V3AgentPlanValidation {
  ok: boolean;
  plan?: V3AgentCandidatePlan;
  errors: string[];
}

const SHOT_NUMBERS = ['01', '02', '03'] as const;
const CAMERA_KEYS = new Set(['template', 'subjects', 'foregroundSubject', 'angle', 'lensClass']);
const PLAN_KEYS = new Set(['version', 'shots']);
const SHOT_KEYS = new Set(['shotNumber', 'camera', 'blocking', 'motion']);
const BLOCKING_KEYS = new Set(['subject', 'placement', 'face', 'pose']);
const SLOT_PLACEMENT_KEYS = new Set(['type', 'slot']);
const RELATIVE_PLACEMENT_KEYS = new Set(['type', 'anchor', 'relation', 'secondaryAnchor']);
const MOTION_KEYS = new Set(['durationSeconds', 'renderControlVideo', 'keyframes']);
const KEYFRAME_KEYS = new Set(['timeSeconds', 'camera', 'staging']);
const MOTION_CAMERA_KEYS = new Set(['position', 'target', 'fovDegrees']);
const STAGING_KEYS = new Set(['subject', 'visible', 'transform', 'posePreset']);
const TRANSFORM_KEYS = new Set(['position', 'rotation', 'scale']);

export const V3_AGENT_PLAN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ForeScene V3-Agent candidate plan',
  description: 'Creative decisions only. Do not change assets, locations, continuity, or deliverables. Include each shot exactly once.',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'shots'],
  properties: {
    version: { const: 1 },
    shots: { type: 'array', minItems: 3, maxItems: 3, items: { $ref: '#/$defs/shot' } },
  },
  $defs: {
    subject: { type: 'string', enum: ['hand-monster', 'joseph-amputated', 'joseph-final', 'shield', 'wrist-blade'] },
    vec3: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
    shot: {
      type: 'object',
      additionalProperties: false,
      required: ['shotNumber', 'camera'],
      properties: {
        shotNumber: { enum: SHOT_NUMBERS },
        camera: { $ref: '#/$defs/camera' },
        blocking: { type: 'array', items: { $ref: '#/$defs/blocking' } },
        motion: { $ref: '#/$defs/motion' },
      },
      if: { properties: { shotNumber: { const: '02' } } },
      then: { required: ['motion'] },
      else: { not: { required: ['motion'] } },
    },
    camera: {
      type: 'object',
      additionalProperties: false,
      required: ['template', 'subjects'],
      properties: {
        template: { enum: PREVIS_CAMERA_TEMPLATES },
        subjects: { type: 'array', minItems: 1, items: { $ref: '#/$defs/subject' } },
        foregroundSubject: { $ref: '#/$defs/subject' },
        angle: { enum: PREVIS_CAMERA_ANGLES },
        lensClass: { enum: PREVIS_LENS_CLASSES },
      },
    },
    blocking: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'placement'],
      properties: {
        subject: { $ref: '#/$defs/subject' },
        placement: {
          oneOf: [
            {
              type: 'object', additionalProperties: false, required: ['type', 'slot'],
              properties: { type: { const: 'location_slot' }, slot: { enum: PREVIS_LOCATION_SLOTS } },
            },
            {
              type: 'object', additionalProperties: false, required: ['type', 'anchor', 'relation'],
              properties: {
                type: { const: 'relative' },
                anchor: { $ref: '#/$defs/subject' },
                relation: { enum: PREVIS_RELATIVE_RELATIONS },
                secondaryAnchor: { $ref: '#/$defs/subject' },
              },
            },
          ],
        },
        face: { type: 'string', description: 'The subject id or named location anchor to face.' },
        pose: { type: 'string', description: 'A supported ForeScene pose preset.' },
      },
    },
    motion: {
      type: 'object', additionalProperties: false, required: ['durationSeconds', 'keyframes'],
      properties: {
        durationSeconds: { const: 3 },
        renderControlVideo: { type: 'boolean' },
        keyframes: {
          type: 'array', minItems: 2, items: { $ref: '#/$defs/keyframe' },
          description: 'Times must increase strictly, starting at 0 and ending at 3 seconds. Camera and staging positions are absolute world coordinates, not location-relative offsets.',
        },
      },
    },
    keyframe: {
      type: 'object', additionalProperties: false, required: ['timeSeconds'],
      properties: {
        timeSeconds: { type: 'number', minimum: 0, maximum: 3 },
        camera: {
          type: 'object', additionalProperties: false,
          properties: {
            position: { $ref: '#/$defs/vec3' },
            target: { $ref: '#/$defs/vec3' },
            fovDegrees: { type: 'number', exclusiveMinimum: 0 },
          },
        },
        staging: { type: 'array', items: { $ref: '#/$defs/staging' } },
      },
    },
    staging: {
      type: 'object', additionalProperties: false, required: ['subject'],
      properties: {
        subject: { $ref: '#/$defs/subject' },
        visible: { type: 'boolean' },
        posePreset: { type: 'string' },
        transform: {
          type: 'object', additionalProperties: false,
          properties: {
            position: { $ref: '#/$defs/vec3' },
            rotation: { $ref: '#/$defs/vec3', description: 'Euler rotation in radians.' },
            scale: { $ref: '#/$defs/vec3' },
          },
        },
      },
    },
  },
};

function extraKeys(record: Record<string, unknown>, allowed: Set<string>, path: string, errors: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(`${path} has unsupported field "${key}".`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteVec3(value: unknown, path: string, errors: string[]): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    errors.push(`${path} must be a finite [x, y, z] triple.`);
    return undefined;
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], path: string, errors: string[]): T | undefined {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    errors.push(`${path} must be one of: ${allowed.join(', ')}.`);
    return undefined;
  }
  return value as T;
}

function parseCamera(value: unknown, knownSubjects: Set<string>, path: string, errors: string[]): V3AgentPlanCamera | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  extraKeys(value, CAMERA_KEYS, path, errors);
  const template = parseEnum(value.template, PREVIS_CAMERA_TEMPLATES, `${path}.template`, errors);
  if (!Array.isArray(value.subjects) || value.subjects.length === 0 || value.subjects.some((item) => typeof item !== 'string')) {
    errors.push(`${path}.subjects must be a non-empty string array.`);
    return template ? { template, subjects: [] } : undefined;
  }
  const subjects = value.subjects as string[];
  for (const subject of subjects) {
    if (!knownSubjects.has(subject)) errors.push(`${path}.subjects contains unknown subject "${subject}".`);
  }
  const foregroundSubject = value.foregroundSubject === undefined
    ? undefined
    : typeof value.foregroundSubject === 'string' && knownSubjects.has(value.foregroundSubject)
      ? value.foregroundSubject
      : (errors.push(`${path}.foregroundSubject is unknown.`), undefined);
  const angle = value.angle === undefined ? undefined : parseEnum(value.angle, PREVIS_CAMERA_ANGLES, `${path}.angle`, errors);
  const lensClass = value.lensClass === undefined ? undefined : parseEnum(value.lensClass, PREVIS_LENS_CLASSES, `${path}.lensClass`, errors);
  if (!template) return undefined;
  return {
    template,
    subjects,
    ...(foregroundSubject ? { foregroundSubject } : {}),
    ...(angle ? { angle } : {}),
    ...(lensClass ? { lensClass } : {}),
  };
}

function parseBlocking(
  value: unknown,
  knownSubjects: Set<string>,
  path: string,
  errors: string[],
): PrevisBlockingInstruction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return [];
  }
  const instructions: PrevisBlockingInstruction[] = [];
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${itemPath} must be an object.`);
      return;
    }
    extraKeys(entry, BLOCKING_KEYS, itemPath, errors);
    const subject = typeof entry.subject === 'string' ? entry.subject : '';
    if (!subject || !knownSubjects.has(subject)) errors.push(`${itemPath}.subject is unknown.`);
    if (!isRecord(entry.placement)) {
      errors.push(`${itemPath}.placement must be an object.`);
      return;
    }
    const extras = {
      ...(typeof entry.face === 'string' ? { face: entry.face } : {}),
      ...(typeof entry.pose === 'string' ? { pose: entry.pose } : {}),
    };
    const placement = entry.placement;
    if (placement.type === 'location_slot') {
      extraKeys(placement, SLOT_PLACEMENT_KEYS, `${itemPath}.placement`, errors);
      const slot = parseEnum(placement.slot, PREVIS_LOCATION_SLOTS, `${itemPath}.placement.slot`, errors);
      if (subject && slot) instructions.push({ subject, placement: { type: 'location_slot', slot }, ...extras });
      return;
    }
    if (placement.type === 'relative') {
      extraKeys(placement, RELATIVE_PLACEMENT_KEYS, `${itemPath}.placement`, errors);
      const relation = parseEnum(placement.relation, PREVIS_RELATIVE_RELATIONS, `${itemPath}.placement.relation`, errors);
      const anchor = typeof placement.anchor === 'string' ? placement.anchor : '';
      if (!anchor || !knownSubjects.has(anchor)) errors.push(`${itemPath}.placement.anchor is unknown.`);
      if (placement.secondaryAnchor !== undefined && (typeof placement.secondaryAnchor !== 'string' || !knownSubjects.has(placement.secondaryAnchor))) {
        errors.push(`${itemPath}.placement.secondaryAnchor is unknown.`);
      }
      if (subject && relation && anchor) {
        instructions.push({
          subject,
          placement: {
            type: 'relative',
            anchor,
            relation,
            ...(typeof placement.secondaryAnchor === 'string' ? { secondaryAnchor: placement.secondaryAnchor } : {}),
          },
          ...extras,
        });
      }
      return;
    }
    errors.push(`${itemPath}.placement.type must be location_slot or relative.`);
  });
  return instructions;
}

function parseMotionCamera(value: unknown, path: string, errors: string[]): PrevisShotMotionKeyframe['camera'] | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  extraKeys(value, MOTION_CAMERA_KEYS, path, errors);
  return {
    ...(value.position !== undefined ? { position: finiteVec3(value.position, `${path}.position`, errors) } : {}),
    ...(value.target !== undefined ? { target: finiteVec3(value.target, `${path}.target`, errors) } : {}),
    ...(value.fovDegrees !== undefined
      ? {
          fovDegrees: typeof value.fovDegrees === 'number' && Number.isFinite(value.fovDegrees) && value.fovDegrees > 0
            ? value.fovDegrees
            : (errors.push(`${path}.fovDegrees must be a finite positive number.`), undefined),
        }
      : {}),
  };
}

function parseMotion(value: unknown, knownSubjects: Set<string>, path: string, errors: string[]): PrevisShotMotion | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  extraKeys(value, MOTION_KEYS, path, errors);
  if (typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds !== 3) {
    errors.push(`${path}.durationSeconds must be 3.`);
  }
  if (value.renderControlVideo !== undefined && typeof value.renderControlVideo !== 'boolean') {
    errors.push(`${path}.renderControlVideo must be a boolean.`);
  }
  if (!Array.isArray(value.keyframes) || value.keyframes.length < 2) {
    errors.push(`${path}.keyframes must contain at least two entries.`);
    return undefined;
  }
  const keyframes: PrevisShotMotionKeyframe[] = [];
  value.keyframes.forEach((entry, index) => {
    const itemPath = `${path}.keyframes[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${itemPath} must be an object.`);
      return;
    }
    extraKeys(entry, KEYFRAME_KEYS, itemPath, errors);
    if (typeof entry.timeSeconds !== 'number' || !Number.isFinite(entry.timeSeconds)) {
      errors.push(`${itemPath}.timeSeconds must be a finite number.`);
      return;
    }
    const staging = entry.staging === undefined
      ? undefined
      : Array.isArray(entry.staging)
        ? entry.staging.flatMap((item, stagingIndex) => {
            const stagingPath = `${itemPath}.staging[${stagingIndex}]`;
            if (!isRecord(item)) {
              errors.push(`${stagingPath} must be an object.`);
              return [];
            }
            extraKeys(item, STAGING_KEYS, stagingPath, errors);
            const subject = typeof item.subject === 'string' ? item.subject : '';
            if (!subject || !knownSubjects.has(subject)) errors.push(`${stagingPath}.subject is unknown.`);
            let transform: NonNullable<PrevisShotMotionKeyframe['staging']>[number]['transform'];
            if (item.transform !== undefined) {
              if (!isRecord(item.transform)) errors.push(`${stagingPath}.transform must be an object.`);
              else {
                extraKeys(item.transform, TRANSFORM_KEYS, `${stagingPath}.transform`, errors);
                transform = {
                  ...(item.transform.position !== undefined ? { position: finiteVec3(item.transform.position, `${stagingPath}.transform.position`, errors) } : {}),
                  ...(item.transform.rotation !== undefined ? { rotation: finiteVec3(item.transform.rotation, `${stagingPath}.transform.rotation`, errors) } : {}),
                  ...(item.transform.scale !== undefined ? { scale: finiteVec3(item.transform.scale, `${stagingPath}.transform.scale`, errors) } : {}),
                };
              }
            }
            return subject
              ? [{
                  subject,
                  ...(typeof item.visible === 'boolean' ? { visible: item.visible } : {}),
                  ...(transform ? { transform } : {}),
                  ...(typeof item.posePreset === 'string' ? { posePreset: item.posePreset } : {}),
                }]
              : [];
          })
        : (errors.push(`${itemPath}.staging must be an array.`), undefined);
    keyframes.push({
      timeSeconds: entry.timeSeconds,
      ...(entry.camera !== undefined ? { camera: parseMotionCamera(entry.camera, `${itemPath}.camera`, errors) } : {}),
      ...(staging ? { staging } : {}),
    });
  });
  if (keyframes[0]?.timeSeconds !== 0) errors.push(`${path} must start at timeSeconds 0.`);
  if (keyframes[keyframes.length - 1]?.timeSeconds !== 3) errors.push(`${path} must end at timeSeconds 3.`);
  for (let index = 1; index < keyframes.length; index += 1) {
    if (keyframes[index]!.timeSeconds <= keyframes[index - 1]!.timeSeconds) {
      errors.push(`${path}.keyframes times must be strictly increasing.`);
      break;
    }
  }
  return {
    durationSeconds: 3,
    ...(typeof value.renderControlVideo === 'boolean' ? { renderControlVideo: value.renderControlVideo } : {}),
    keyframes,
  };
}

export function validateV3AgentCandidatePlan(
  value: unknown,
  contract: V3AgentContract,
): V3AgentPlanValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['candidate-plan.json must be an object.'] };
  extraKeys(value, PLAN_KEYS, 'plan', errors);
  if (value.version !== 1) errors.push('plan.version must be 1.');
  if (!Array.isArray(value.shots)) return { ok: false, errors: [...errors, 'plan.shots must be an array.'] };
  if (value.shots.length !== 3) errors.push('plan must contain exactly shots 01, 02, and 03.');
  const knownSubjects = new Set(contract.knownSubjects);
  const seen = new Set<string>();
  const shots: V3AgentCandidatePlan['shots'] = [];
  value.shots.forEach((entry, index) => {
    const path = `plan.shots[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object.`);
      return;
    }
    extraKeys(entry, SHOT_KEYS, path, errors);
    const shotNumber = entry.shotNumber;
    if (shotNumber !== '01' && shotNumber !== '02' && shotNumber !== '03') {
      errors.push(`${path}.shotNumber must be 01, 02, or 03.`);
      return;
    }
    if (seen.has(shotNumber)) errors.push(`Duplicate shot ${shotNumber}.`);
    seen.add(shotNumber);
    const camera = parseCamera(entry.camera, knownSubjects, `${path}.camera`, errors);
    const blocking = parseBlocking(entry.blocking ?? [], knownSubjects, `${path}.blocking`, errors);
    if (shotNumber === '02') {
      if (entry.motion === undefined) errors.push(`${path}.motion is required.`);
      const motion = entry.motion === undefined ? undefined : parseMotion(entry.motion, knownSubjects, `${path}.motion`, errors);
      if (camera) shots.push({ shotNumber, camera, blocking, ...(motion ? { motion } : {}) });
      return;
    }
    if (entry.motion !== undefined) errors.push(`${path}.motion is not allowed on still shots.`);
    if (camera) shots.push({ shotNumber, camera, blocking });
  });
  for (const expected of SHOT_NUMBERS) {
    if (!seen.has(expected)) errors.push(`Missing shot ${expected}.`);
  }
  shots.sort((left, right) => left.shotNumber.localeCompare(right.shotNumber));
  return errors.length === 0 && shots.length === 3
    ? { ok: true, plan: { version: 1, shots }, errors }
    : { ok: false, errors };
}

export function buildV3AgentProductionManifest(
  contract: V3AgentContract,
  intent: V3AgentIntent,
  candidatePlan: V3AgentCandidatePlan,
): PrevisProductionManifestV1 {
  const intentByShot = new Map(intent.shots.map((shot) => [shot.shotNumber, shot]));
  const planByShot = new Map<string, V3AgentCandidatePlan['shots'][number]>(
    candidatePlan.shots.map((shot) => [shot.shotNumber, shot]),
  );
  const shots: PrevisShotDefinition[] = contract.shots.map((shot) => {
    const assignment = intentByShot.get(shot.shotNumber);
    const plan = planByShot.get(shot.shotNumber);
    if (!plan) throw new Error(`Candidate plan is missing shot ${shot.shotNumber}.`);
    const notes = [
      assignment?.assignment,
      ...(assignment?.continuity ?? []),
      assignment?.locationNote,
    ].filter((note): note is string => Boolean(note));
    return {
      id: shot.id,
      shotNumber: shot.shotNumber,
      name: shot.name,
      description: assignment?.assignment ?? shot.name,
      locationId: shot.locationId,
      subjects: [...shot.subjects],
      blocking: plan.blocking,
      camera: plan.camera,
      requirements: {
        visibleSubjects: shot.requiredSubjects.filter((subject) => !['shield', 'wrist-blade'].includes(subject)),
        ...(shot.requiredSubjects.some((subject) => subject === 'shield' || subject === 'wrist-blade')
          ? { visibleProps: shot.requiredSubjects.filter((subject) => subject === 'shield' || subject === 'wrist-blade') }
          : {}),
        ...(notes.length > 0 ? { notes } : {}),
      },
      ...(plan.motion ? { motion: plan.motion } : {}),
    };
  });
  return {
    version: 2,
    project: structuredClone(contract.project),
    locations: structuredClone(contract.locations),
    cast: structuredClone(contract.cast),
    assets: structuredClone(contract.assets),
    props: structuredClone(contract.props),
    shots,
  };
}
