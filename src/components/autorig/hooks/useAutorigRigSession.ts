/**
 * Session-facing helpers for the guided autorig wizard.
 * Heavy WebGL / worker orchestration still lives in AutorigRigWizardDialog
 * until the persistent preview + worker session lands (PR 80C).
 */

export type AutorigPreparingPhase =
  | 'idle'
  | 'labeling'
  | 'weights'
  | 'ready';

export function preparingMessage(phase: AutorigPreparingPhase): string | null {
  if (phase === 'idle' || phase === 'ready') return null;
  return 'Preparing pose preview…';
}
