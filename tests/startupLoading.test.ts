import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('startup loading boundaries', () => {
  it('does not mount Continuity Stage rendering work before a mode is selected', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../src/state/useContinuityStore.ts', import.meta.url), 'utf8');
    const secondCapture = readFileSync(
      new URL('../src/engine/prepareSuggestedSecondCapture.ts', import.meta.url),
      'utf8',
    );
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const splash = readFileSync(new URL('../src/components/common/SplashScreen.tsx', import.meta.url), 'utf8');

    expect(app).toContain("const isContinuityStage = appMode === 'continuity';");
    expect(app).toContain(') : isContinuityStage ? (');
    expect(app).toContain('{isContinuityStage && !helpOpen && <WorkflowGuidance />}');
    expect(main).not.toContain('ensureHumanMannequinModel');
    expect(store).toContain("await import('../engine/renderers')");
    expect(store).not.toContain("from '../engine/renderers'");
    expect(secondCapture).toContain("await import('./renderers')");
    expect(secondCapture).not.toContain("from './renderers'");
    expect(viewport).toContain('void ensureHumanMannequinModel().catch');
    expect(splash).toContain('preload="metadata"');
  });
});
