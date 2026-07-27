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
    const buildWorkspace = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const panoViewerWorkspace = readFileSync(
      new URL('../src/components/workspaces/PanoViewerWorkspace.tsx', import.meta.url),
      'utf8',
    );
    const packageExport = readFileSync(new URL('../src/engine/packageExport.ts', import.meta.url), 'utf8');
    const splash = readFileSync(new URL('../src/components/common/SplashScreen.tsx', import.meta.url), 'utf8');

    expect(app).toContain("const isContinuityStage = appMode === 'continuity';");
    expect(app).toContain(') : isContinuityStage ? (');
    expect(app).toContain("const WorkflowGuidance = lazy(() => import('./components/common/WorkflowGuidance')");
    expect(app).toContain('{isContinuityStage && !helpOpen && (');
    expect(app).toContain('<Suspense fallback={null}>');
    expect(app).toContain('<WorkflowGuidance />');
    expect(app).toContain("import('./engine/projectIO')");
    expect(app).not.toContain("from './engine/projectIO'");
    expect(main).not.toContain('ensureHumanMannequinModel');
    expect(store).toContain("await import('../engine/renderers')");
    expect(store).not.toContain("from '../engine/renderers'");
    expect(secondCapture).toContain("await import('./renderers')");
    expect(secondCapture).not.toContain("from './renderers'");
    expect(viewport).toContain("from '../../engine/flyCamera'");
    expect(viewport).not.toContain("from '../../engine/renderers'");
    expect(viewport).toContain('window.requestIdleCallback?.(loadWhenIdle');
    expect(buildWorkspace).toContain("await import('../../engine/renderers')");
    expect(buildWorkspace).not.toContain("from '../../engine/renderers'");
    expect(buildWorkspace).not.toContain('projectIO');
    expect(panoViewerWorkspace).toContain("await import('../../engine/renderers')");
    expect(panoViewerWorkspace).not.toContain("from '../../engine/renderers'");
    expect(panoViewerWorkspace).not.toContain('projectIO');
    expect(packageExport).not.toContain('ensureHumanMannequinModel');
    expect(splash).toContain('preload="metadata"');
  });
});
