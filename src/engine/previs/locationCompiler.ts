/**
 * Location / cast / prop compilers → Agent API plan commands.
 */

import type { ForeSceneAgentCommand, ForeSceneAgentPlan } from '../agent/protocol';
import type {
  PrevisCharacterDefinition,
  PrevisLocationDefinition,
  PrevisProductionManifestV1,
  PrevisPropDefinition,
} from './manifest';
import { compileLocationTemplate, normalizeAnchorKey } from './locationTemplates';
import { locationPrimitiveBlockers } from './manifestDiff';
import { locationZoneOrigin, sceneExtentWithinLimits } from './spatialLayout';
import type { PrevisEntityMapping } from './runState';
import type { Vec3 } from '../../domain/types';
import { previsError, type PrevisDiagnostic } from './manifestDiagnostics';
import { defaultPropDimensions } from './propDimensions';

/** Agent plan refs may only contain letters, digits, _ or -. */
export function previsRef(...parts: string[]): string {
  const joined = parts
    .map((part) => part.trim().replace(/[^a-zA-Z0-9_-]+/g, '_'))
    .filter(Boolean)
    .join('_');
  const cleaned = joined.replace(/^[^a-zA-Z]+/, '') || `ref_${joined}`;
  return cleaned.slice(0, 64);
}

export interface LocationBlockerAabb {
  /**
   * Plan-local ref at compile time; resolved to live object id after location apply
   * (via entities[`locations.${id}`].refs).
   */
  objectId: string;
  type?: string;
  min: Vec3;
  max: Vec3;
}

export interface CompiledProductionContext {
  /** locationId → zone origin */
  locationOrigins: Record<string, Vec3>;
  /** locationId → anchor key → world position */
  locationAnchors: Record<string, Record<string, Vec3>>;
  /**
   * locationId → solid AABBs for camera collision / occlusion.
   * objectId is a plan ref until entity.refs resolve it to a live id.
   */
  locationBlockers: Record<string, LocationBlockerAabb[]>;
  /** Stable entity mappings for run-state. */
  entities: Record<string, PrevisEntityMapping>;
  /** Plan-local refs created so far. */
  refs: Record<string, string>;
}

export interface CompilePhaseResult {
  ok: boolean;
  plan: ForeSceneAgentPlan;
  context: CompiledProductionContext;
  diagnostics: PrevisDiagnostic[];
  /** Expected entity keys written after apply (for run-state). */
  entityKeys: string[];
  /** Imported cast entries are resolved by the CLI through the browser file-input API. */
  importedCharacters?: Array<{
    entityKey: string;
    character: Extract<PrevisCharacterDefinition, { type: 'imported_character' }>;
  }>;
}

export function createEmptyCompiledContext(): CompiledProductionContext {
  return {
    locationOrigins: {},
    locationAnchors: {},
    locationBlockers: {},
    entities: {},
    refs: {},
  };
}

export function compileLocationsPhase(
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext = createEmptyCompiledContext(),
): CompilePhaseResult {
  const diagnostics: PrevisDiagnostic[] = [];
  const commands: ForeSceneAgentCommand[] = [];
  const entityKeys: string[] = [];
  const next = cloneContext(context);
  const origins: Vec3[] = [];

  manifest.locations.forEach((location, index) => {
    const entityKey = `locations.${location.id}`;
    if (next.entities[entityKey]?.objectIds?.length) {
      // Idempotent: already compiled.
      return;
    }

    const origin = locationZoneOrigin(index);
    origins.push(origin);
    next.locationOrigins[location.id] = origin;

    const compiled = compileLocationTemplate(location, origin);
    const objectRefs: string[] = [];
    const anchors: Record<string, string> = {};
    const anchorPositions: Record<string, Vec3> = {};

    // Build blockers with the same plan refs used for object.create so the
    // camera solver can request real shot.stageObject(visible:false) overrides.
    const primitiveEntries = compiled.primitives.map((primitive) => {
      const ref = previsRef('loc', location.id, primitive.ref);
      return { primitive, ref };
    });

    next.locationBlockers[location.id] = locationPrimitiveBlockers(
      location,
      primitiveEntries.map(({ primitive, ref }) => ({
        type: primitive.type,
        position: primitive.position,
        dimensions: primitive.dimensions,
        rotation: primitive.rotation,
        ref,
      })),
    );

    for (const { primitive, ref } of primitiveEntries) {
      objectRefs.push(ref);
      commands.push({
        op: 'object.create',
        ref,
        object: {
          type: primitive.type,
          name: primitive.name,
          position: primitive.position,
          ...(primitive.rotation ? { rotation: primitive.rotation } : {}),
          ...(primitive.dimensions ? { dimensions: primitive.dimensions } : {}),
          ...(primitive.stagingRole ? { stagingRole: primitive.stagingRole } : {}),
        },
      });
      if (primitive.color) {
        commands.push({
          op: 'object.update',
          object: { ref },
          updates: { color: primitive.color },
        });
      }
    }

    for (const anchor of compiled.anchors) {
      const ref = previsRef('loc', location.id, 'anchor', anchor.key);
      const key = normalizeAnchorKey(anchor.key);
      anchors[key] = ref;
      anchors[anchor.key] = ref;
      anchorPositions[key] = anchor.position;
      anchorPositions[anchor.key] = anchor.position;
      // Also index display name.
      anchors[normalizeAnchorKey(anchor.displayName)] = ref;
      anchorPositions[normalizeAnchorKey(anchor.displayName)] = anchor.position;

      commands.push({
        op: 'landmark.create',
        ref,
        landmark: {
          name: `${location.id}_${anchor.key}`,
          displayName: anchor.displayName,
          position: [anchor.position[0], 1.2, anchor.position[2]],
          description: anchor.description ?? `${location.name} — ${anchor.displayName}`,
          visible: false,
          promptCritical: false,
          tags: ['previs-anchor', location.id, anchor.key],
        },
      });
    }

    next.locationAnchors[location.id] = anchorPositions;
    next.entities[entityKey] = {
      objectIds: objectRefs,
      anchors,
      zoneOrigin: origin,
      refs: Object.fromEntries(objectRefs.map((ref) => [ref, ref])),
    };
    entityKeys.push(entityKey);
  });

  if (!sceneExtentWithinLimits([
    ...origins,
    ...Object.values(next.locationOrigins),
  ])) {
    diagnostics.push(previsError(
      'scene_extent',
      'Compiled location zones exceed configured scene safety limits.',
      { path: 'locations' },
    ));
  }

  const plan: ForeSceneAgentPlan = {
    version: 1,
    planId: `previs-locations-${manifest.project.name}`.slice(0, 80),
    description: `Previs locations for ${manifest.project.name}`,
    commands,
  };

  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    plan,
    context: next,
    diagnostics,
    entityKeys,
  };
}

export function compileCastPhase(
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
): CompilePhaseResult {
  const diagnostics: PrevisDiagnostic[] = [];
  const commands: ForeSceneAgentCommand[] = [];
  const entityKeys: string[] = [];
  const importedCharacters: NonNullable<CompilePhaseResult['importedCharacters']> = [];
  const next = cloneContext(context);

  // Park cast near first location origin, off to the side; shots stage them.
  const parkOrigin = next.locationOrigins[manifest.locations[0]?.id ?? ''] ?? [0, 0, 0];

  manifest.cast.forEach((character, index) => {
    const entityKey = `cast.${character.id}`;
    if (character.type === 'imported_character') {
      importedCharacters.push({ entityKey, character });
      return;
    }
    if (next.entities[entityKey]?.objectId) return;

    const ref = previsRef('cast', character.id);
    const height = character.height ?? 1.75;
    const position: Vec3 = [
      parkOrigin[0] + 8 + index * 1.2,
      0,
      parkOrigin[2] + 8,
    ];

    commands.push({
      op: 'object.create',
      ref,
      object: {
        type: 'human_dummy',
        name: character.name,
        position,
        dimensions: [0.55, height, 0.55],
        stagingRole: 'person',
      },
    });
    if (character.color) {
      commands.push({
        op: 'object.update',
        object: { ref },
        updates: { color: character.color },
      });
    }

    next.entities[entityKey] = { objectId: ref, refs: { [ref]: ref } };
    next.refs[character.id] = ref;
    entityKeys.push(entityKey);
  });

  return {
    ok: true,
    plan: {
      version: 1,
      planId: `previs-cast-${manifest.project.name}`.slice(0, 80),
      description: `Previs cast for ${manifest.project.name}`,
      commands,
    },
    context: next,
    diagnostics,
    entityKeys,
    importedCharacters,
  };
}

export function compilePropsPhase(
  manifest: PrevisProductionManifestV1,
  context: CompiledProductionContext,
): CompilePhaseResult {
  const diagnostics: PrevisDiagnostic[] = [];
  const commands: ForeSceneAgentCommand[] = [];
  const entityKeys: string[] = [];
  const next = cloneContext(context);
  const props = manifest.props ?? [];
  const parkOrigin = next.locationOrigins[manifest.locations[0]?.id ?? ''] ?? [0, 0, 0];

  props.forEach((prop, index) => {
    const entityKey = `props.${prop.id}`;
    if (next.entities[entityKey]?.objectId) return;

    const ref = previsRef('prop', prop.id);
    const mapped = mapPropPrimitive(prop);
    const position: Vec3 = [
      parkOrigin[0] + 10 + index * 1.0,
      0,
      parkOrigin[2] + 10,
    ];

    commands.push({
      op: 'object.create',
      ref,
      object: {
        type: mapped.type,
        name: prop.name,
        position,
        dimensions: prop.dimensions ?? mapped.dimensions,
        stagingRole: 'prop',
      },
    });
    if (prop.color ?? mapped.color) {
      commands.push({
        op: 'object.update',
        object: { ref },
        updates: { color: prop.color ?? mapped.color },
      });
    }

    next.entities[entityKey] = { objectId: ref, refs: { [ref]: ref } };
    next.refs[prop.id] = ref;
    entityKeys.push(entityKey);
  });

  return {
    ok: true,
    plan: {
      version: 1,
      planId: `previs-props-${manifest.project.name}`.slice(0, 80),
      description: `Previs props for ${manifest.project.name}`,
      commands,
    },
    context: next,
    diagnostics,
    entityKeys,
  };
}

function mapPropPrimitive(prop: PrevisPropDefinition): {
  type: 'box' | 'column' | 'terrain_mass' | 'background_card';
  dimensions: [number, number, number];
  color?: string;
} {
  const dimensions = prop.dimensions ?? defaultPropDimensions(prop.primitive);
  switch (prop.primitive) {
    case 'sphere':
      return { type: 'terrain_mass', dimensions, color: '#94a3b8' };
    case 'cylinder':
      return { type: 'column', dimensions, color: '#78716c' };
    case 'disc':
      return { type: 'box', dimensions, color: '#a8a29e' };
    case 'shield':
      return { type: 'box', dimensions, color: '#64748b' };
    case 'sword':
      return { type: 'box', dimensions, color: '#cbd5e1' };
    case 'table':
      return { type: 'box', dimensions, color: '#6b5344' };
    case 'custom_simple':
    case 'box':
    default:
      return { type: 'box', dimensions, color: '#78716c' };
  }
}

function cloneContext(context: CompiledProductionContext): CompiledProductionContext {
  return {
    locationOrigins: { ...context.locationOrigins },
    locationAnchors: Object.fromEntries(
      Object.entries(context.locationAnchors).map(([key, value]) => [key, { ...value }]),
    ),
    locationBlockers: Object.fromEntries(
      Object.entries(context.locationBlockers).map(([key, value]) => [
        key,
        value.map((box) => ({
          objectId: box.objectId,
          type: box.type,
          min: [...box.min] as Vec3,
          max: [...box.max] as Vec3,
        })),
      ]),
    ),
    entities: structuredClone(context.entities),
    refs: { ...context.refs },
  };
}

export function locationDefinitionById(
  manifest: PrevisProductionManifestV1,
  locationId: string,
): PrevisLocationDefinition | undefined {
  return manifest.locations.find((location) => location.id === locationId);
}

export function characterById(
  manifest: PrevisProductionManifestV1,
  id: string,
): PrevisCharacterDefinition | undefined {
  return manifest.cast.find((character) => character.id === id);
}
