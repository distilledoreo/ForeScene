import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createInitialVideoAuthoringState,
  reduceVideoAuthoring,
  tryReduceVideoAuthoring,
} from '../src/engine/videoAuthoringMachine';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Shots composition structure', () => {
  it('mounts plan-named components as real JSX (not dead re-exports)', () => {
    const shots = readFileSync(join(root, 'src/components/workspaces/ShotsWorkspace.tsx'), 'utf8');
    // Real element mounts — not only import identifiers.
    expect(shots).toMatch(/<ShotsCaptureChrome[\s\S]*?>[\s\S]*?<\/ShotsCaptureChrome>/);
    expect(shots).toMatch(/<ShotsLibrary[\s\S]*?\/>|<ShotsLibrary[\s\S]*?>/);
    expect(shots).toMatch(/<ShotSettings[\s\S]*?>[\s\S]*?<\/ShotSettings>/);
    // Inline library sheet / precision drawer replaced by composed components.
    expect(shots).not.toContain('<PrecisionDrawer');
    expect(shots).not.toContain('<ShotsLibraryCard');
    // Capture state driven by video authoring controller, not parallel useState.
    expect(shots).toMatch(/const videoCaptureState = videoAuthoring\.captureState/);
    expect(shots).toMatch(/const isPreviewingCameraMove = videoAuthoring\.isPreviewing/);
    expect(shots).toMatch(/const captureMode: CaptureMode = videoAuthoring\.mode/);
    expect(shots).not.toMatch(/useState<VideoCaptureState>/);
    expect(shots).not.toMatch(/useState<CaptureMode>/);
    // Still-capture lifecycle lives in the dedicated controller (not inline orchestration).
    expect(shots).toMatch(/useStillCaptureController\(/);
    expect(shots).not.toMatch(/const captureStill = useCallback/);
    expect(shots).not.toMatch(/const snapshotPreview = useCallback/);
    // Camera-move authoring + MP4 export lives in the dedicated controller.
    expect(shots).toMatch(/useCameraMoveController\(/);
    expect(shots).not.toMatch(/const appendSequentialCapture = useCallback/);
    expect(shots).not.toMatch(/const exportCameraMoveVideo = useCallback/);
    // Camera-move preview + timeline orchestration lives in the dedicated controller.
    expect(shots).toMatch(/useCameraMovePreviewController\(/);
    expect(shots).not.toMatch(/const previewCameraMove = useCallback/);
    expect(shots).not.toMatch(/const stopCameraMovePreview = useCallback/);
  });

  it('ShotsCaptureChrome ships data-shots-capture-chrome and data-shots-shutter', () => {
    const chrome = readFileSync(join(root, 'src/components/shots/ShotsCaptureChrome.tsx'), 'utf8');
    expect(chrome).toContain('data-shots-capture-chrome');
    expect(chrome).toContain('data-shots-shutter');
    expect(chrome).toContain('data-capture-shutter');
    expect(chrome).toContain('export function ShotsCaptureChrome');
  });

  it('video authoring machine is the capture source of truth for illegal transitions', () => {
    let state = createInitialVideoAuthoringState({ mode: 'video', captureState: 'finished', keyframeCount: 2 });
    const illegal = tryReduceVideoAuthoring(state, { type: 'CAPTURE_POSE', keyframeCountAfter: 3 });
    expect(illegal.ok).toBe(false);
    state = reduceVideoAuthoring(state, { type: 'CONTINUE_MOVE' });
    expect(state.captureState).toBe('capturing');
    state = reduceVideoAuthoring(state, { type: 'CAPTURE_POSE', keyframeCountAfter: 3 });
    expect(state.keyframeCount).toBe(3);
    state = reduceVideoAuthoring(state, { type: 'FINISH_MOVE' });
    expect(state.captureState).toBe('finished');
  });

  it('named controller and component modules exist', () => {
    const paths = [
      'src/hooks/useShotCameraController.ts',
      'src/hooks/useVideoAuthoringController.ts',
      'src/hooks/useShotRenderController.ts',
      'src/hooks/useShotStagingController.ts',
      'src/components/shots/useStillCaptureController.ts',
      'src/components/shots/useCameraMoveController.ts',
      'src/components/shots/useCameraMovePreviewController.ts',
      'src/components/shots/ShotsCaptureChrome.tsx',
      'src/components/shots/ShotsLibrary.tsx',
      'src/components/shots/ShotSettings.tsx',
      'src/state/slices/projectSlice.ts',
      'src/state/slices/selectionSlice.ts',
      'src/state/slices/historySlice.ts',
      'src/state/slices/historyRuntime.ts',
      'src/state/slices/workflowSlice.ts',
      'src/state/slices/sessionSlice.ts',
      'src/state/slices/touchProject.ts',
    ];
    for (const rel of paths) {
      const text = readFileSync(join(root, rel), 'utf8');
      expect(text.length).toBeGreaterThan(20);
    }
    const store = readFileSync(join(root, 'src/state/useProjectStore.ts'), 'utf8');
    expect(store).toContain('createProjectSlice');
    expect(store).toContain('createSelectionSlice');
    expect(store).toContain('createHistorySlice');
    expect(store).toContain('createWorkflowSlice');
    expect(store).toContain('createSessionSlice');
  });
});
