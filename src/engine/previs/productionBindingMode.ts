/**
 * Production binding validation modes.
 *
 * Greenfield runs create entities during compile; prepared runs require
 * bindings up front; refinement runs preserve IDs and permit only declared edits.
 */

export type ProductionBindingMode = 'greenfield' | 'prepared' | 'refinement';

export type ProductionIntegrityMode =
  | 'manual'
  | 'legacy_previs'
  | 'gated_production'
  | 'greenfield_production';

export function resolveProductionBindingMode(
  mode: ProductionIntegrityMode = 'gated_production',
): ProductionBindingMode {
  switch (mode) {
    case 'greenfield_production':
      return 'greenfield';
    case 'legacy_previs':
      return 'greenfield';
    case 'manual':
      return 'prepared';
  }
  return 'prepared';
}

export function requiresPresenceContract(mode: ProductionIntegrityMode): boolean {
  return mode === 'gated_production' || mode === 'greenfield_production';
}
