import type { AutorigBodyRegionId, AutorigRegionCode } from './regions';
import { AUTORIG_REGION_CODE, AUTORIG_REGION_ID_BY_CODE } from './regions';

/** Display colors for the six user-visible body regions (sRGB 0–1). */
export const AUTORIG_REGION_COLORS: Record<AutorigBodyRegionId, [number, number, number]> = {
  head: [0.95, 0.72, 0.35],
  torso: [0.35, 0.72, 0.55],
  leftArm: [0.35, 0.55, 0.95],
  rightArm: [0.95, 0.55, 0.35],
  leftLeg: [0.45, 0.75, 0.95],
  rightLeg: [0.95, 0.65, 0.45],
};

export const AUTORIG_REGION_LABELS: Record<AutorigBodyRegionId, string> = {
  head: 'Head',
  torso: 'Torso',
  leftArm: 'Left arm',
  rightArm: 'Right arm',
  leftLeg: 'Left leg',
  rightLeg: 'Right leg',
};

const UNCERTAIN_TINT: [number, number, number] = [0.82, 0.84, 0.88];

/** Fill a tightly packed RGB buffer (3 floats per vertex) from region labels. */
export function fillRegionColorAttribute(params: {
  labels: Uint8Array;
  /** Optional confidence [0,1]; low values get a pale/uncertain tint. */
  confidence?: Float32Array | null;
  uncertainThreshold?: number;
  out?: Float32Array;
}): Float32Array {
  const { labels } = params;
  const out = params.out && params.out.length >= labels.length * 3
    ? params.out
    : new Float32Array(labels.length * 3);
  const threshold = params.uncertainThreshold ?? 0.22;
  for (let v = 0; v < labels.length; v += 1) {
    const code = labels[v]! as AutorigRegionCode;
    const region = AUTORIG_REGION_ID_BY_CODE[code];
    const base = region ? AUTORIG_REGION_COLORS[region] : AUTORIG_REGION_COLORS.torso;
    const uncertain = params.confidence != null && (params.confidence[v] ?? 1) < threshold;
    const r = uncertain ? base[0] * 0.55 + UNCERTAIN_TINT[0] * 0.45 : base[0];
    const g = uncertain ? base[1] * 0.55 + UNCERTAIN_TINT[1] * 0.45 : base[1];
    const b = uncertain ? base[2] * 0.55 + UNCERTAIN_TINT[2] * 0.45 : base[2];
    const o = v * 3;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
  return out;
}

/** CSS hex for toolbar / legend chips. */
export function regionColorCss(region: AutorigBodyRegionId): string {
  const [r, g, b] = AUTORIG_REGION_COLORS[region];
  const toByte = (c: number) => Math.round(Math.max(0, Math.min(1, c)) * 255);
  return `rgb(${toByte(r)}, ${toByte(g)}, ${toByte(b)})`;
}

export function regionCodeColorCss(code: number): string {
  const region = AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode];
  if (!region) return 'rgb(148, 163, 184)';
  return regionColorCss(region);
}

/** Guard unused import for tree-shaking clarity. */
void AUTORIG_REGION_CODE;
