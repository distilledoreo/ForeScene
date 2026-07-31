/**
 * Default AABB for semantic prop primitives (create + stage + camera framing).
 */

export function defaultPropDimensions(primitive: string): [number, number, number] {
  switch (primitive) {
    case 'shield':
      return [0.7, 1.0, 0.12];
    case 'sword':
      return [0.12, 1.1, 0.08];
    case 'table':
      return [1.6, 0.85, 0.9];
    case 'sphere':
      return [0.5, 0.5, 0.5];
    case 'cylinder':
      return [0.35, 1.0, 0.35];
    case 'disc':
      return [0.8, 0.08, 0.8];
    default:
      return [0.6, 0.6, 0.6];
  }
}
