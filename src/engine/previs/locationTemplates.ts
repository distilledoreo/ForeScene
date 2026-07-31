/**
 * Built-in graybox location template library.
 * Each template yields primitives + named anchors relative to a zone origin.
 */

import type { SceneObjectType, Vec3 } from '../../domain/types';
import type { PrevisLocationDefinition, PrevisLocationTemplate } from './manifest';
import { offsetByOrigin } from './spatialLayout';

export interface CompiledTemplatePrimitive {
  /** Stable local ref within the location (e.g. "floor", "wall-left"). */
  ref: string;
  name: string;
  type: SceneObjectType;
  /** Floor-contact or center position in location-local space (agent create semantics). */
  position: Vec3;
  rotation?: Vec3;
  dimensions?: Vec3;
  stagingRole?: 'set' | 'prop' | 'person';
  color?: string;
}

export interface CompiledTemplateAnchor {
  /** Stable anchor key used by blocking (e.g. "center", "entrance"). */
  key: string;
  displayName: string;
  /** World-ready after zone offset; stored local here. */
  position: Vec3;
  description?: string;
}

export interface CompiledLocationTemplate {
  template: PrevisLocationTemplate;
  primitives: CompiledTemplatePrimitive[];
  anchors: CompiledTemplateAnchor[];
  /** Approximate usable stage size. */
  bounds: { width: number; depth: number; height: number };
}

export function compileLocationTemplate(
  location: PrevisLocationDefinition,
  zoneOrigin: Vec3,
): CompiledLocationTemplate {
  const local = buildLocalTemplate(location);
  return {
    ...local,
    primitives: local.primitives.map((primitive) => ({
      ...primitive,
      position: offsetByOrigin(primitive.position, zoneOrigin),
    })),
    anchors: local.anchors.map((anchor) => ({
      ...anchor,
      position: offsetByOrigin(anchor.position, zoneOrigin),
    })),
  };
}

function buildLocalTemplate(location: PrevisLocationDefinition): CompiledLocationTemplate {
  switch (location.template) {
    case 'ruins':
      return romanRuins(location);
    case 'armory':
      return armoryInterior(location);
    case 'exterior_courtyard':
      return exteriorCourtyard(location);
    case 'interior_room':
      return interiorRoom(location);
    case 'corridor':
      return corridor(location);
    case 'empty_stage':
    default:
      return emptyStage(location);
  }
}

function emptyStage(location: PrevisLocationDefinition): CompiledLocationTemplate {
  const width = location.dimensions?.width ?? 14;
  const depth = location.dimensions?.depth ?? 14;
  const height = location.dimensions?.height ?? 4;
  return {
    template: 'empty_stage',
    bounds: { width, depth, height },
    primitives: [
      {
        ref: 'floor',
        name: `${location.name} Floor`,
        type: 'floor',
        position: [0, 0, 0],
        dimensions: [width, 0.08, depth],
        stagingRole: 'set',
      },
      {
        ref: 'backdrop',
        name: `${location.name} Backdrop`,
        type: 'background_card',
        position: [0, height / 2, -depth / 2 + 0.2],
        dimensions: [width * 0.9, height, 0.08],
        stagingRole: 'set',
        color: '#6b7280',
      },
    ],
    anchors: [
      { key: 'center', displayName: 'Center', position: [0, 0, 0] },
      { key: 'entrance', displayName: 'Entrance', position: [0, 0, depth / 2 - 1] },
      { key: 'exit', displayName: 'Exit', position: [0, 0, -depth / 2 + 1] },
      { key: 'left', displayName: 'Left', position: [-width / 4, 0, 0] },
      { key: 'right', displayName: 'Right', position: [width / 4, 0, 0] },
      { key: 'foreground', displayName: 'Foreground', position: [0, 0, depth / 3] },
      { key: 'background', displayName: 'Background', position: [0, 0, -depth / 3] },
    ],
  };
}

function romanRuins(location: PrevisLocationDefinition): CompiledLocationTemplate {
  const width = location.dimensions?.width ?? 18;
  const depth = location.dimensions?.depth ?? 16;
  const height = location.dimensions?.height ?? 4.5;
  return {
    template: 'ruins',
    bounds: { width, depth, height },
    primitives: [
      {
        ref: 'floor',
        name: `${location.name} Ground`,
        type: 'floor',
        position: [0, 0, 0],
        dimensions: [width, 0.1, depth],
        stagingRole: 'set',
        color: '#8b8680',
      },
      {
        ref: 'left-wall',
        name: 'Left Wall',
        type: 'wall',
        position: [-width / 2 + 0.2, 0, 0],
        rotation: [0, 90, 0],
        dimensions: [depth * 0.7, height * 0.75, 0.25],
        stagingRole: 'set',
      },
      {
        ref: 'right-wall',
        name: 'Right Wall',
        type: 'wall',
        position: [width / 2 - 0.2, 0, 0],
        rotation: [0, -90, 0],
        dimensions: [depth * 0.7, height * 0.7, 0.25],
        stagingRole: 'set',
      },
      {
        ref: 'arch-entrance',
        name: 'Entrance Arch',
        type: 'arch',
        position: [0, 0, depth / 2 - 0.5],
        dimensions: [3.4, 3.6, 0.4],
        stagingRole: 'set',
      },
      {
        ref: 'platform',
        name: 'Raised Platform',
        type: 'box',
        position: [0, 0, -depth / 4],
        dimensions: [4, 0.6, 3],
        stagingRole: 'set',
        color: '#9a9590',
      },
      {
        ref: 'col-1',
        name: 'Background Column A',
        type: 'column',
        position: [-3, 0, -depth / 2 + 1.5],
        dimensions: [0.7, height, 0.7],
        stagingRole: 'set',
      },
      {
        ref: 'col-2',
        name: 'Background Column B',
        type: 'column',
        position: [3, 0, -depth / 2 + 1.5],
        dimensions: [0.7, height, 0.7],
        stagingRole: 'set',
      },
      {
        ref: 'rubble',
        name: 'Rubble Mass',
        type: 'terrain_mass',
        position: [width / 3, 0, depth / 4],
        dimensions: [2.5, 0.9, 2],
        stagingRole: 'set',
      },
    ],
    anchors: [
      { key: 'center', displayName: 'Center', position: [0, 0, 0] },
      { key: 'entrance', displayName: 'Entrance', position: [0, 0, depth / 2 - 1.5] },
      { key: 'exit', displayName: 'Exit', position: [0, 0, -depth / 2 + 2] },
      { key: 'left', displayName: 'Left Wall', position: [-width / 3, 0, 0] },
      { key: 'right', displayName: 'Right Wall', position: [width / 3, 0, 0] },
      { key: 'platform', displayName: 'Raised Platform', position: [0, 0.6, -depth / 4] },
      { key: 'background', displayName: 'Background Columns', position: [0, 0, -depth / 2 + 2.5] },
      { key: 'foreground', displayName: 'Foreground', position: [0, 0, depth / 3] },
    ],
  };
}

function armoryInterior(location: PrevisLocationDefinition): CompiledLocationTemplate {
  const width = location.dimensions?.width ?? 12;
  const depth = location.dimensions?.depth ?? 10;
  const height = location.dimensions?.height ?? 3.2;
  return {
    template: 'armory',
    bounds: { width, depth, height },
    primitives: [
      {
        ref: 'floor',
        name: `${location.name} Floor`,
        type: 'floor',
        position: [0, 0, 0],
        dimensions: [width, 0.08, depth],
        stagingRole: 'set',
      },
      {
        ref: 'back-wall',
        name: 'Back Wall',
        type: 'wall',
        position: [0, 0, -depth / 2 + 0.15],
        dimensions: [width - 0.4, height, 0.2],
        stagingRole: 'set',
      },
      {
        ref: 'left-wall',
        name: 'Left Wall',
        type: 'wall',
        position: [-width / 2 + 0.15, 0, 0],
        rotation: [0, 90, 0],
        dimensions: [depth - 0.4, height, 0.2],
        stagingRole: 'set',
      },
      {
        ref: 'right-wall',
        name: 'Right Wall',
        type: 'wall',
        position: [width / 2 - 0.15, 0, 0],
        rotation: [0, -90, 0],
        dimensions: [depth - 0.4, height, 0.2],
        stagingRole: 'set',
      },
      {
        ref: 'main-door',
        name: 'Main Door',
        type: 'doorway',
        position: [0, 0, depth / 2 - 0.2],
        dimensions: [2.2, 2.6, 0.25],
        stagingRole: 'set',
      },
      {
        ref: 'weapon-rack',
        name: 'Weapon Rack',
        type: 'box',
        position: [-width / 2 + 1.2, 0, -1],
        dimensions: [0.4, 2.2, 2.4],
        stagingRole: 'set',
        color: '#5b4636',
      },
      {
        ref: 'work-table',
        name: 'Work Table',
        type: 'box',
        position: [width / 4, 0, 0],
        dimensions: [2.2, 0.9, 1.0],
        stagingRole: 'prop',
        color: '#6b5344',
      },
      {
        ref: 'barricade',
        name: 'Barricade',
        type: 'box',
        position: [-1.5, 0, depth / 4],
        dimensions: [2.0, 1.1, 0.5],
        stagingRole: 'prop',
        color: '#4b5563',
      },
    ],
    anchors: [
      { key: 'center', displayName: 'Center', position: [0, 0, 0] },
      { key: 'entrance', displayName: 'Main Door', position: [0, 0, depth / 2 - 1.2] },
      { key: 'exit', displayName: 'Exit', position: [0, 0, depth / 2 - 1.2] },
      { key: 'main_door', displayName: 'Main Door', position: [0, 0, depth / 2 - 1.2] },
      { key: 'back_wall', displayName: 'Back Wall', position: [0, 0, -depth / 2 + 1.5] },
      { key: 'weapon_rack', displayName: 'Weapon Rack', position: [-width / 2 + 2.2, 0, -1] },
      { key: 'work_table', displayName: 'Work Table', position: [width / 4, 0, 1.2] },
      { key: 'barricade', displayName: 'Barricade Position', position: [-1.5, 0, depth / 4 + 1] },
      { key: 'left', displayName: 'Left', position: [-width / 4, 0, 0] },
      { key: 'right', displayName: 'Right', position: [width / 4, 0, 0] },
      { key: 'foreground', displayName: 'Foreground', position: [0, 0, depth / 3] },
      { key: 'background', displayName: 'Background', position: [0, 0, -depth / 3] },
    ],
  };
}

function exteriorCourtyard(location: PrevisLocationDefinition): CompiledLocationTemplate {
  const width = location.dimensions?.width ?? 20;
  const depth = location.dimensions?.depth ?? 18;
  const height = location.dimensions?.height ?? 4;
  return {
    template: 'exterior_courtyard',
    bounds: { width, depth, height },
    primitives: [
      {
        ref: 'floor',
        name: `${location.name} Courtyard`,
        type: 'floor',
        position: [0, 0, 0],
        dimensions: [width, 0.08, depth],
        stagingRole: 'set',
        color: '#a8a29e',
      },
      {
        ref: 'gate',
        name: 'Courtyard Gate',
        type: 'arch',
        position: [0, 0, depth / 2 - 0.4],
        dimensions: [4, 4, 0.45],
        stagingRole: 'set',
      },
      {
        ref: 'left-col',
        name: 'Left Pillar',
        type: 'column',
        position: [-width / 3, 0, -depth / 4],
        dimensions: [0.8, height, 0.8],
        stagingRole: 'set',
      },
      {
        ref: 'right-col',
        name: 'Right Pillar',
        type: 'column',
        position: [width / 3, 0, -depth / 4],
        dimensions: [0.8, height, 0.8],
        stagingRole: 'set',
      },
      {
        ref: 'far-wall',
        name: 'Far Wall',
        type: 'wall',
        position: [0, 0, -depth / 2 + 0.2],
        dimensions: [width * 0.6, height * 0.8, 0.25],
        stagingRole: 'set',
      },
      {
        ref: 'tree',
        name: 'Courtyard Tree',
        type: 'tree_blob',
        position: [width / 3, 0, depth / 4],
        dimensions: [2.2, 3.5, 2.2],
        stagingRole: 'set',
      },
    ],
    anchors: [
      { key: 'center', displayName: 'Center', position: [0, 0, 0] },
      { key: 'entrance', displayName: 'Entrance', position: [0, 0, depth / 2 - 1.5] },
      { key: 'exit', displayName: 'Exit', position: [0, 0, -depth / 2 + 2] },
      { key: 'left', displayName: 'Left', position: [-width / 4, 0, 0] },
      { key: 'right', displayName: 'Right', position: [width / 4, 0, 0] },
      { key: 'foreground', displayName: 'Foreground', position: [0, 0, depth / 3] },
      { key: 'background', displayName: 'Background', position: [0, 0, -depth / 3] },
    ],
  };
}

function interiorRoom(location: PrevisLocationDefinition): CompiledLocationTemplate {
  const width = location.dimensions?.width ?? 8;
  const depth = location.dimensions?.depth ?? 7;
  const height = location.dimensions?.height ?? 3;
  return {
    template: 'interior_room',
    bounds: { width, depth, height },
    primitives: [
      {
        ref: 'floor',
        name: `${location.name} Floor`,
        type: 'floor',
        position: [0, 0, 0],
        dimensions: [width, 0.08, depth],
        stagingRole: 'set',
      },
      {
        ref: 'back-wall',
        name: 'Back Wall',
        type: 'wall',
        position: [0, 0, -depth / 2 + 0.12],
        dimensions: [width - 0.3, height, 0.18],
        stagingRole: 'set',
      },
      {
        ref: 'left-wall',
        name: 'Left Wall',
        type: 'wall',
        position: [-width / 2 + 0.12, 0, 0],
        rotation: [0, 90, 0],
        dimensions: [depth - 0.3, height, 0.18],
        stagingRole: 'set',
      },
      {
        ref: 'right-wall',
        name: 'Right Wall',
        type: 'wall',
        position: [width / 2 - 0.12, 0, 0],
        rotation: [0, -90, 0],
        dimensions: [depth - 0.3, height, 0.18],
        stagingRole: 'set',
      },
      {
        ref: 'door',
        name: 'Doorway',
        type: 'doorway',
        position: [0, 0, depth / 2 - 0.15],
        dimensions: [1.8, 2.4, 0.22],
        stagingRole: 'set',
      },
    ],
    anchors: [
      { key: 'center', displayName: 'Center', position: [0, 0, 0] },
      { key: 'entrance', displayName: 'Entrance', position: [0, 0, depth / 2 - 1] },
      { key: 'exit', displayName: 'Exit', position: [0, 0, depth / 2 - 1] },
      { key: 'left', displayName: 'Left', position: [-width / 4, 0, 0] },
      { key: 'right', displayName: 'Right', position: [width / 4, 0, 0] },
      { key: 'foreground', displayName: 'Foreground', position: [0, 0, depth / 3] },
      { key: 'background', displayName: 'Background', position: [0, 0, -depth / 3] },
    ],
  };
}

function corridor(location: PrevisLocationDefinition): CompiledLocationTemplate {
  const width = location.dimensions?.width ?? 4;
  const depth = location.dimensions?.depth ?? 16;
  const height = location.dimensions?.height ?? 3;
  return {
    template: 'corridor',
    bounds: { width, depth, height },
    primitives: [
      {
        ref: 'floor',
        name: `${location.name} Floor`,
        type: 'floor',
        position: [0, 0, 0],
        dimensions: [width, 0.08, depth],
        stagingRole: 'set',
      },
      {
        ref: 'left-wall',
        name: 'Left Corridor Wall',
        type: 'wall',
        position: [-width / 2 + 0.1, 0, 0],
        rotation: [0, 90, 0],
        dimensions: [depth - 0.2, height, 0.16],
        stagingRole: 'set',
      },
      {
        ref: 'right-wall',
        name: 'Right Corridor Wall',
        type: 'wall',
        position: [width / 2 - 0.1, 0, 0],
        rotation: [0, -90, 0],
        dimensions: [depth - 0.2, height, 0.16],
        stagingRole: 'set',
      },
      {
        ref: 'far-arch',
        name: 'Far Arch',
        type: 'arch',
        position: [0, 0, -depth / 2 + 0.4],
        dimensions: [width - 0.4, height, 0.35],
        stagingRole: 'set',
      },
    ],
    anchors: [
      { key: 'center', displayName: 'Center', position: [0, 0, 0] },
      { key: 'entrance', displayName: 'Entrance', position: [0, 0, depth / 2 - 1] },
      { key: 'exit', displayName: 'Exit', position: [0, 0, -depth / 2 + 1.5] },
      { key: 'left', displayName: 'Left', position: [-width / 4, 0, 0] },
      { key: 'right', displayName: 'Right', position: [width / 4, 0, 0] },
      { key: 'foreground', displayName: 'Foreground', position: [0, 0, depth / 3] },
      { key: 'background', displayName: 'Background', position: [0, 0, -depth / 3] },
    ],
  };
}

/** Normalize anchor lookup keys (Main Door → main_door / entrance). */
export function normalizeAnchorKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}
