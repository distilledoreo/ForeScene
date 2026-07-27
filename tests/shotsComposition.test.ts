import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Shots composition structure', () => {
  it('ShotsWorkspace composes plan-named controllers and components', () => {
    const shots = readFileSync(join(root, 'src/components/workspaces/ShotsWorkspace.tsx'), 'utf8');
    expect(shots).toContain('useShotCameraController');
    expect(shots).toContain('useVideoAuthoringController');
    expect(shots).toContain('useShotRenderController');
    expect(shots).toContain('useShotStagingController');
    expect(shots).toContain('ShotsCaptureChrome');
    expect(shots).toContain('ShotsLibrary');
    expect(shots).toContain('ShotSettings');
    expect(shots).toContain('ContinuityComparePanel');
    expect(shots).toContain('SequenceStoryboardView');
    expect(shots).toContain('attachKeyframePreviewToShot');
  });

  it('named controller and component modules exist', () => {
    const paths = [
      'src/hooks/useShotCameraController.ts',
      'src/hooks/useVideoAuthoringController.ts',
      'src/hooks/useShotRenderController.ts',
      'src/hooks/useShotStagingController.ts',
      'src/components/shots/ShotsCaptureChrome.tsx',
      'src/components/shots/ShotsLibrary.tsx',
      'src/components/shots/ShotSettings.tsx',
      'src/components/shots/ContinuityComparePanel.tsx',
      'src/components/shots/SequenceStoryboardView.tsx',
      'src/engine/videoAuthoringMachine.ts',
      'src/state/slices/types.ts',
      '.github/workflows/ci.yml',
    ];
    for (const rel of paths) {
      const text = readFileSync(join(root, rel), 'utf8');
      expect(text.length).toBeGreaterThan(20);
    }
  });
});
