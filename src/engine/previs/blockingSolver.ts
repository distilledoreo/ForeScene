/**
 * Semantic blocking solver — location slots + relative placement + grounding.
 *
 * Two-pass batch:
 * 1. Resolve every subject position (relative placement may still be sequential).
 * 2. Resolve facing/rotation after all positions exist (order-independent).
 */

import type { Vec3 } from '../../domain/types';
import type {
  PrevisBlockingInstruction,
  PrevisLocationSlot,
  PrevisRelativeRelation,
} from './manifest';
import { resolveFacingYaw } from './facingSolver';
import { normalizeAnchorKey } from './locationTemplates';
import { addXZ, separateOnGround } from './spatialLayout';
import { resolvePrevisPosePresetId } from './posePresets';

export interface BlockingSolveContext {
  /** Anchor key → world position (floor contact). */
  anchors: Record<string, Vec3>;
  /** Subject/prop id → current world position (floor contact). */
  subjects: Record<string, Vec3>;
  /** Minimum XZ spacing between human dummies. */
  minCharacterSpacing?: number;
}

export interface BlockingSolveResult {
  position: Vec3;
  rotation: Vec3;
  posePreset?: string;
  warnings: string[];
}

const SLOT_FALLBACK: Record<PrevisLocationSlot, Vec3> = {
  center: [0, 0, 0],
  left: [-2, 0, 0],
  right: [2, 0, 0],
  foreground: [0, 0, 2.5],
  background: [0, 0, -2.5],
  entrance: [0, 0, 4],
  exit: [0, 0, -4],
};

const RELATION_OFFSET: Record<Exclude<PrevisRelativeRelation, 'between'>, { x: number; z: number }> = {
  left_of: { x: -1.2, z: 0 },
  right_of: { x: 1.2, z: 0 },
  in_front_of: { x: 0, z: 1.2 },
  behind: { x: 0, z: -1.2 },
  beside: { x: 1.1, z: 0 },
  across_from: { x: 0, z: 2.2 },
  near: { x: 0.8, z: 0.4 },
  far_from: { x: 3.5, z: 0 },
  just_inside: { x: 0, z: -1.0 },
  just_outside: { x: 0, z: 1.0 },
};

/** Resolve placement only (no facing). Used by pass 1 of the batch solver. */
export function resolveBlockingPosition(
  instruction: PrevisBlockingInstruction,
  context: BlockingSolveContext,
): { position: Vec3; warnings: string[] } {
  const warnings: string[] = [];
  let position = resolvePlacement(instruction, context, warnings);

  const minSpacing = context.minCharacterSpacing ?? 0.85;
  for (const [otherId, otherPos] of Object.entries(context.subjects)) {
    if (otherId === instruction.subject) continue;
    position = separateOnGround(position, otherPos, minSpacing);
  }

  position = [position[0], 0, position[2]];
  return { position, warnings };
}

export function solveBlockingInstruction(
  instruction: PrevisBlockingInstruction,
  context: BlockingSolveContext,
): BlockingSolveResult {
  const { position, warnings } = resolveBlockingPosition(instruction, context);
  return finalizeFacingAndPose(instruction, position, context, warnings);
}

function finalizeFacingAndPose(
  instruction: PrevisBlockingInstruction,
  position: Vec3,
  context: BlockingSolveContext,
  warnings: string[],
): BlockingSolveResult {
  let faceTarget: Vec3 | undefined;
  if (instruction.face) {
    faceTarget = resolveNamedPoint(instruction.face, {
      ...context,
      // Prefer the subject's final position map (pass-2 context).
      subjects: context.subjects,
    });
    if (!faceTarget) {
      warnings.push(`face target "${instruction.face}" not found; using default yaw.`);
    }
  }

  const yaw = resolveFacingYaw({ from: position, faceTarget });
  const posePreset = instruction.pose
    ? resolvePrevisPosePresetId(instruction.pose)
    : undefined;
  if (instruction.pose && !posePreset) {
    warnings.push(`pose "${instruction.pose}" not resolved.`);
  }

  return {
    position,
    rotation: [0, yaw, 0],
    ...(posePreset ? { posePreset } : {}),
    warnings,
  };
}

function resolvePlacement(
  instruction: PrevisBlockingInstruction,
  context: BlockingSolveContext,
  warnings: string[],
): Vec3 {
  const placement = instruction.placement;
  if (placement.type === 'location_slot') {
    const fromAnchor = resolveNamedPoint(placement.slot, context)
      ?? resolveNamedPoint(slotDisplayName(placement.slot), context);
    if (fromAnchor) return [...fromAnchor] as Vec3;
    warnings.push(`slot "${placement.slot}" missing; using fallback.`);
    return [...SLOT_FALLBACK[placement.slot]] as Vec3;
  }

  const anchorPos = resolveNamedPoint(placement.anchor, context);
  if (!anchorPos) {
    warnings.push(`anchor "${placement.anchor}" missing; placing at center.`);
    return resolveNamedPoint('center', context) ?? [0, 0, 0];
  }

  if (placement.relation === 'between') {
    const secondary = placement.secondaryAnchor
      ? resolveNamedPoint(placement.secondaryAnchor, context)
      : undefined;
    if (!secondary) {
      warnings.push('between missing secondaryAnchor; using near-anchor.');
      return addXZ(anchorPos, { z: 0.5 });
    }
    return [
      (anchorPos[0] + secondary[0]) / 2,
      0,
      (anchorPos[2] + secondary[2]) / 2,
    ];
  }

  const offset = RELATION_OFFSET[placement.relation];
  return addXZ(anchorPos, offset);
}

function resolveNamedPoint(name: string, context: BlockingSolveContext): Vec3 | undefined {
  if (context.subjects[name]) return context.subjects[name];
  if (context.anchors[name]) return context.anchors[name];
  const normalized = normalizeAnchorKey(name);
  if (context.anchors[normalized]) return context.anchors[normalized];
  for (const [key, value] of Object.entries(context.anchors)) {
    if (normalizeAnchorKey(key) === normalized) return value;
  }
  for (const [key, value] of Object.entries(context.subjects)) {
    if (normalizeAnchorKey(key) === normalized) return value;
  }
  return undefined;
}

function slotDisplayName(slot: PrevisLocationSlot): string {
  switch (slot) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    default:
      return slot;
  }
}

/**
 * Two-pass blocking batch:
 * 1. Positions (sequential so relative anchors to other subjects still work)
 * 2. Facing/rotation using the complete position map
 */
export function solveBlockingBatch(
  instructions: PrevisBlockingInstruction[],
  context: BlockingSolveContext,
): Record<string, BlockingSolveResult> {
  const subjects = { ...context.subjects };
  const positionWarnings: Record<string, string[]> = {};
  const positions: Record<string, Vec3> = {};

  for (const instruction of instructions) {
    const placed = resolveBlockingPosition(instruction, { ...context, subjects });
    positions[instruction.subject] = placed.position;
    subjects[instruction.subject] = placed.position;
    positionWarnings[instruction.subject] = placed.warnings;
  }

  const faceContext: BlockingSolveContext = { ...context, subjects: { ...subjects } };
  const results: Record<string, BlockingSolveResult> = {};
  for (const instruction of instructions) {
    const position = positions[instruction.subject]!;
    results[instruction.subject] = finalizeFacingAndPose(
      instruction,
      position,
      faceContext,
      [...(positionWarnings[instruction.subject] ?? [])],
    );
  }
  return results;
}
