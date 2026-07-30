import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ui revamp fidelity surfaces', () => {
  it('floats the stage rail over a full-bleed workspace instead of a separate header strip', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    const shell = readFileSync(new URL('../src/components/workspaces/WorkspaceShell.tsx', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<main className="absolute inset-0">');
    expect(app).toContain('pointer-events-none absolute inset-x-0 top-0 z-40');
    expect(app).toContain('bg-surface-overlay/75');
    expect(app).not.toContain('border-b border-subtle bg-surface-header');
    expect(app).not.toContain('flex h-screen w-full flex-col');
    expect(app).not.toContain('ReviewWorkspace');
    expect(app).not.toContain("id: 'review'");
    expect(styles).toContain('--stage-header-safe');
    expect(shell).toContain('reserveHeader');
    expect(shell).toContain('pt-[var(--stage-header-safe)]');
    expect(reference).toContain('FullBleedLayout reserveHeader');
    expect(shots).toContain('FullBleedLayout reserveHeader');
    expect(exportWorkspace).toContain('FullBleedLayout reserveHeader');
    expect(build).toContain('<FullBleedLayout>');
    expect(build).not.toContain('reserveHeader');
  });

  it('declares ForeScene favicon assets in the app shell', () => {
    const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const faviconSvg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
    const faviconIco = readFileSync(new URL('../public/favicon.ico', import.meta.url));
    expect(shell).toContain('rel="icon"');
    expect(shell).toContain('/favicon.svg');
    expect(shell).toContain('/favicon.ico');
    expect(faviconSvg).toContain('#0d9488');
    expect(faviconIco.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  });

  it('uses theme-aware shot viewfinder chrome', () => {
    const overlay = readFileSync(new URL('../src/components/viewers/ShotViewfinderOverlay.tsx', import.meta.url), 'utf8');
    expect(overlay).toContain('useThemeStore');
    expect(overlay).toContain('border-[var(--accent)]');
    expect(overlay).toContain("variant?: 'full' | 'compact'");
    expect(overlay).toContain('data-shot-viewfinder={variant}');
    expect(overlay).not.toContain('border-teal-500');
  });

  it('uses full-bleed shot viewfinder framing in the shots viewport', () => {
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    expect(viewport).toContain('variant="full"');
    expect(viewport).not.toContain('computeCenteredFrameRendererRects');
  });

  it('keeps empty pano viewer materials theme-aware in dark mode', () => {
    const panoViewer = readFileSync(new URL('../src/components/viewers/PanoViewer.tsx', import.meta.url), 'utf8');
    expect(panoViewer).toContain('THEME_COLORS[params.theme].empty');
    expect(panoViewer).not.toContain('THEME_COLORS.light.empty');
  });

  it('uses an iPhone-style camera chrome for shots capture', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const stillCapture = readFileSync(new URL('../src/components/shots/useStillCaptureController.ts', import.meta.url), 'utf8');
    const cameraMove = readFileSync(new URL('../src/components/shots/useCameraMoveController.ts', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings + '\n' + stillCapture + '\n' + cameraMove;
    expect(shots).toContain('data-shots-camera-shell');
    expect(shots).toContain('data-shots-shutter');
    expect(shots).toContain('data-shots-mode-switcher');
    expect(shots).toContain('data-shots-library-thumb');
    const libraryCard = readFileSync(new URL('../src/components/common/ShotsLibraryCard.tsx', import.meta.url), 'utf8');
    expect(libraryCard).toContain('data-shots-library-delete');
    expect(libraryCard).toContain('AnchoredMenuPopover');
    expect(libraryCard).toContain('onRequestDelete');
    expect(shots).toContain('data-shots-camera-move-status');
    expect(shots).toContain('MP4 export is not supported in this browser. Try Chrome or Edge.');
    expect(shots).toContain('data-shots-settings-trigger');
    expect(shots).toContain('data-shots-video-duration');
    expect(shots).toContain('VIDEO_DURATION_UI_MIN_SECONDS');
    expect(shots).toContain('VIDEO_DURATION_UI_MAX_SECONDS');
    expect(shots).toContain('type="range"');
    expect(shots).toContain('landShotFraming');
    expect(shots).toContain('keepFlying: true');
    expect(shots).toContain('captureStill');
    expect(shots).toContain("captureMode === 'still'");
    expect(shots).toContain("captureMode === 'video'");
    expect(shots).toContain('viewfinder stays live');
    expect(shots).toContain('AppearanceModeToggle');
    expect(shots).toContain('data-shots-dual-output-hint');
    expect(shots).toContain('useStillCaptureController');
    expect(shots).toContain('useCameraMoveController');
    expect(stillCapture).toContain('renderShotProjectedFrame');
    expect(stillCapture).toContain('runSettledSequentially');
    expect(shotsWorkspace).not.toContain('data-shots-action-dock');
    expect(shotsWorkspace).not.toContain('data-shots-land-fork');
    expect(shotsWorkspace).not.toContain('ShotInfoCard');
  });

  it('exposes clay/projected appearance controls and double-tap W sprint', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const shortcuts = readFileSync(new URL('../src/engine/buildShortcuts.ts', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const exportSettingsPanel = readFileSync(new URL('../src/components/export/ExportSettingsPanel.tsx', import.meta.url), 'utf8');
    const packageExport = readFileSync(new URL('../src/engine/packageExport.ts', import.meta.url), 'utf8');
    const help = readFileSync(new URL('../src/components/workspaces/HelpWorkspace.tsx', import.meta.url), 'utf8');

    expect(build).toContain('AppearanceModeToggle');
    expect(build).toContain('double-tap W to sprint');
    expect(build).not.toContain('Ctrl sprint');
    expect(viewport).toContain('reduceForwardSprint');
    expect(viewport).toContain("event.code === 'KeyW'");
    expect(viewport).not.toContain("keys.has('ControlLeft')");
    expect(shortcuts).not.toContain("'ControlLeft'");
    expect(shortcuts).not.toContain("'ControlRight'");
    expect(reference).toContain('ProjectedStylePanel');
    expect(exportWorkspace).toContain('ExportSettingsPanel');
    expect(exportSettingsPanel).toContain('includeProjectedViewport');
    expect(exportSettingsPanel).toContain('includeProjectedCameraMoveVideo');
    expect(packageExport).toContain('viewport_projected.png');
    expect(packageExport).toContain('viewport_projected_motion.mp4');
    expect(packageExport).toContain("appearance: 'projected'");
    expect(help).toContain('Projected Style');
    expect(help).toContain('double-tap W');
  });

  it('keeps optimized origins as a capture plan without relocating existing panorama pixels', () => {
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const projectedPanel = readFileSync(new URL('../src/components/common/ProjectedStylePanel.tsx', import.meta.url), 'utf8');
    const coveragePanel = readFileSync(new URL('../src/components/common/CoverageOptimizerPanel.tsx', import.meta.url), 'utf8');
    expect(reference).not.toContain('onApplyPanoramaOrigins');
    expect(projectedPanel).not.toContain('onApplyPanoramaOrigins');
    expect(coveragePanel).not.toContain('data-coverage-apply-pair');
    expect(coveragePanel).toContain('data-coverage-apply-capture-a');
    expect(coveragePanel).toContain('data-coverage-apply-capture');
    expect(coveragePanel).toContain('Existing panorama origins are never rewritten');
    expect(coveragePanel).toContain('data-coverage-use-selection-bounds');
    expect(coveragePanel).toContain('Restrict optimizer to an analysis region');
    expect(coveragePanel).toContain('Metrics above are room-local');
  });

  it('guards both successful and failed coverage extraction against stale analysis identity', () => {
    const coveragePanel = readFileSync(
      new URL('../src/components/common/CoverageOptimizerPanel.tsx', import.meta.url),
      'utf8',
    );
    expect(coveragePanel).toMatch(/const scene = await extractCoverageScene[\s\S]*if \(analysisIdRef\.current !== analysisId\) return;/);
    expect(coveragePanel).toMatch(/catch \(error\) \{\s+if \(analysisIdRef\.current !== analysisId\) return;/);
  });

  it('pauses automatic shot frame preview renders while fly camera or Stage is active', () => {
    // Behavioral gate coverage lives in tests/shotFramePreview.test.ts.
    // Keep a light inventory check that Shots still routes through the helper,
    // without locking exact useEffect dependency-array wiring.
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    expect(shotsWorkspace).toContain('shouldStartAutomaticShotFrameRender');
    expect(shotsWorkspace).toContain('shotCameraFlying');
    expect(shotsWorkspace).toContain('stagingMode');
    expect(shotsWorkspace).not.toContain('flyCameraRevision');
  });

  it('keeps filmstrip overlay dots decorative and surfaces warning details on demand', () => {
    const filmstrip = readFileSync(new URL('../src/components/common/ShotFilmstrip.tsx', import.meta.url), 'utf8');
    expect(filmstrip).toContain('aria-hidden');
    expect(filmstrip).toContain('pointer-events-none');
    expect(filmstrip).toContain('WarningPopover');
    expect(filmstrip).not.toContain('Shot ${shot.shotNumber} options');
  });

  it('keeps native graybox download in build and surfaces it in the reference starting modal', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const guidance = readFileSync(new URL('../src/components/common/WorkflowGuidance.tsx', import.meta.url), 'utf8');
    const referenceGuide = readFileSync(new URL('../src/components/common/GrayboxReferenceGuide.tsx', import.meta.url), 'utf8');
    const defaults = readFileSync(new URL('../src/domain/defaults.ts', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../src/state/slices/projectSlice.ts', import.meta.url), 'utf8');
    const session = readFileSync(new URL('../src/state/slices/sessionSlice.ts', import.meta.url), 'utf8');
    const renderers = readFileSync(new URL('../src/engine/renderers.ts', import.meta.url), 'utf8');
    expect(build).toContain('Download Graybox 360');
    expect(build).toContain('Download Projected 360');
    expect(build).toContain('data-build-download-projected-360');
    expect(build).toContain('Re-render after scene changes');
    expect(build).toContain('data-build-rerender-graybox');
    expect(build).toContain('data-build-graybox-cta');
    expect(build).toContain('handleRenderGraybox');
    expect(build).toContain('hint="Creates the latest graybox 360 for the Reference step."');
    expect(build).toContain('data-build-free-camera-toggle');
    expect(build).toContain('data-build-render-distance-toggle');
    expect(build).toContain('data-build-render-distance-slider');
    expect(build).toContain('freeCameraActive');
    expect(build).toContain('data-object-surface-style');
    expect(build).toContain('1m × 1m checkerboard');
    expect(build).toContain('getPrimitiveShortcutLabel');
    expect(build).toContain('data-build-shortcuts-hint');
    expect(build).not.toContain('grayboxDownloadPrompt');
    expect(build).toContain('letterboxEnabled: false');
    expect(guidance).toContain('showReferencePromptBuilder');
    expect(guidance).toContain('seenObjectiveWorkspaces.includes(\'reference\')');
    expect(guidance).toMatch(/activeDialog === 'advance' && Boolean\(advancePrompt\)[\s\S]*onClose=\{handleAdvanceDismiss\}/);
    expect(guidance).toContain("type GuidanceDialog = 'none' | 'objective' | 'advance' | 'alignmentIntro' | 'alignmentRetry'");
    expect(guidance).toContain('lastHandledObjectiveRequest');
    expect(referenceGuide).toContain('Your graybox 360 is ready');
    expect(referenceGuide).toContain('Download the graybox image.');
    expect(defaults).toContain('DEFAULT_GRAYBOX_PANO_WIDTH = 4096');
    expect(defaults).toContain('DEFAULT_GRAYBOX_PANO_HEIGHT = 2048');
    expect(store).toContain('isCaptureOriginNearPano(captureOrigin, existing)');
    expect(session).toContain('isRenderingGraybox: false');
    expect(store).toContain('shotCameraFlying: false');
    expect(store).toMatch(/setProject:[\s\S]*isExportingPackage: false/);
    expect(renderers).toContain('disposeRenderer');
    expect(renderers).toContain('forceContextLoss');
  });

  it('keeps the default Build orbit centered and consumes free-camera shortcuts before Build actions', () => {
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(viewport).toContain('const freeCameraModeRef = useRef(freeCameraActive);');
    expect(viewport).toContain('if (!modeChanged || isShotFraming) return;');
    expect(viewport).toContain("window.addEventListener('keydown', onKeyDown, true);");
    expect(viewport).toContain('event.stopImmediatePropagation();');
    expect(viewport).toMatch(/if \(event\.code === 'Escape'\) \{[\s\S]*\n\s*if \(event\.target && \(event\.target as HTMLElement\)\.closest/);
    expect(viewport).toContain("? 'cursor-grab active:cursor-grabbing'");
    expect(viewport).toContain("verticalPositionClassName={freeCameraActive ? 'bottom-[12rem]' : undefined}");
    expect(build).toContain('const editingChromeVisible = !freeCameraActive && !renderDistanceOpen;');
    expect(build).toContain('showTransformGizmo={Boolean(');
    expect(build).toContain("buildMode === 'pano_origin'");
    expect(build).toContain('|| buildMode === \'pano_origin\'');
    expect(build).toContain("editingChromeVisible && (");
    expect(build).toContain('selectionToolsVisible');
    expect(build).toContain('data-build-selection-dock-toggle');
    expect(build).toContain('data-build-selection-docked');
    expect(build).toContain('mt-[var(--stage-header-safe)]');
    expect(build).toContain('Esc exits');
    expect(build).toContain('tap Free camera to edit');
    expect(build).toContain('handleMovePanoOrigin');
    expect(build).toContain('onRotatePanoOrigin');
    expect(build).toContain('shouldWarnOnOriginMove');
    expect(build).toContain('data-build-origin-coaching');
    expect(build).toContain('data-build-origin-controls');
    expect(build).toContain('data-build-free-camera-control');
  });

  it('surfaces reference alignment yaw/opacity on viewer chrome', () => {
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    expect(reference).toContain('data-reference-alignment-chrome');
    expect(reference).toContain('data-reference-yaw-slider');
    expect(reference).toContain('Graybox fade');
    expect(reference).toContain('data-panoramas-card');
    expect(reference).toContain('data-reference-settings-gear');
    expect(reference).toContain('SecondCaptureForkPanel');
    expect(reference).toContain('data-reference-pano-origins');
    expect(reference).toContain('resolveCompareGraybox');
    expect(reference).toContain('compareGraybox');
    expect(reference).toContain('activePano?.origin ?? project.scene.panoOrigin');
  });

  it('exposes remove controls for pano references in reference settings', () => {
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../src/state/slices/projectSlice.ts', import.meta.url), 'utf8');
    const session = readFileSync(new URL('../src/state/slices/sessionSlice.ts', import.meta.url), 'utf8');
    expect(reference).toContain('data-pano-reference-list');
    expect(reference).toContain('data-remove-pano');
    expect(reference).toContain('Remove Uploaded Pano');
    expect(reference).toContain('removePanoReference');
    expect(store).toContain('removePanoReference:');
    expect(store).toContain('importStyledPano:');
    expect(session).toContain('pendingSecondCapturePlan');
    expect(session).toContain('setPendingSecondCapturePlan');
  });

  it('keeps second-capture seed download status truthful', () => {
    const fork = readFileSync(new URL('../src/components/common/SecondCaptureForkPanel.tsx', import.meta.url), 'utf8');
    expect(fork).toContain('data-second-capture-seed-status');
    expect(fork).toContain('Download seed again');
    expect(fork).toContain('data-second-capture-download-seed-again');
  });

  it('keeps second-capture progress ETA markers in the fork panel', () => {
    const fork = readFileSync(new URL('../src/components/common/SecondCaptureForkPanel.tsx', import.meta.url), 'utf8');
    expect(fork).toContain('data-second-capture-progress');
    expect(fork).toContain('data-second-capture-eta');
    expect(fork).toContain('About ');
    expect(fork).toContain('remaining');
    expect(fork).toContain('prepareSuggestedSecondCapture');
    expect(fork).toContain('export function SecondCaptureForkContent');
  });

  it('embeds second-capture fork in the reference advance modal', () => {
    const guidance = readFileSync(new URL('../src/components/common/WorkflowGuidance.tsx', import.meta.url), 'utf8');
    expect(guidance).toContain('showSecondCaptureFork');
    expect(guidance).toContain('SecondCaptureForkContent');
    expect(guidance).toContain("completedStep === 'reference'");
  });

  it('simplifies projected style with a happy-path blend toggle', () => {
    const panel = readFileSync(new URL('../src/components/common/ProjectedStylePanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('data-projected-blend-toggle');
    expect(panel).toContain('data-projected-style-advanced');
    expect(panel).toContain('Blend both captures');
  });

  it('coaches Build users after the capture origin moves for a second pano', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(build).toContain('data-build-second-capture-coach');
    expect(build).toContain('resolveStyledImportMode');
  });

  it('keeps advanced shot tools in settings rather than the camera chrome', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    expect(shots).toContain('data-shots-advanced-settings');
    expect(shots).toContain('Download PNG');
    expect(shots).toContain('Pano match');
    expect(shots).toContain('Video mode (advanced)');
    expect(shots).not.toContain("label={isRenderingFrame ? 'Rendering...' : 'Render Shot Preview'}");
  });

  it('labels export settings with scene defaults and shot overrides', () => {
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const exportSettingsPanel = readFileSync(new URL('../src/components/export/ExportSettingsPanel.tsx', import.meta.url), 'utf8');
    expect(exportWorkspace).toContain('ExportSettingsPanel');
    expect(exportSettingsPanel).toContain('data-export-settings-scope');
    expect(exportSettingsPanel).toContain('Scene Export Settings');
    expect(exportSettingsPanel).toContain('Customize this shot');
    expect(exportSettingsPanel).toContain('Reset to scene settings');
    expect(exportSettingsPanel).toContain('data-export-inheritance-badge');
    expect(exportSettingsPanel).toContain('draftDimensions');
    expect(exportSettingsPanel).toContain('data-export-nested-boolean-field');
    expect(exportSettingsPanel).toContain('characterPass.includeMotion');
    expect(exportSettingsPanel).toContain('depth.includeViewportStill');
  });

  it('uses camera-style bottom chrome without a floating shot dossier', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(styles).toContain('--shots-overlay-bottom-safe');
    expect(shots).toContain('data-shots-camera-chrome');
    expect(shots).toContain('data-shots-library');
    expect(shots).not.toContain('data-shots-info-safe-area');
    expect(shots).not.toContain('ShotFilmstrip');
  });

  it('keeps shot filmstrip component available for other surfaces', () => {
    const filmstrip = readFileSync(new URL('../src/components/common/ShotFilmstrip.tsx', import.meta.url), 'utf8');
    const shotInfoCard = readFileSync(new URL('../src/components/common/ShotInfoCard.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(shotInfoCard).toContain('data-shot-info-card="floating"');
    expect(shotInfoCard).toContain('bg-surface-overlay');
    expect(filmstrip).toContain("appearance?: 'default' | 'overlay'");
    expect(filmstrip).toContain('data-shot-filmstrip={appearance}');
    expect(filmstrip).toContain('ring-2 ring-[var(--accent)]');
    expect(filmstrip).toContain('MoreHorizontal');
    expect(styles).toContain('--filmstrip-overlay');
  });

  it('renders shots viewport in camera-framing mode without build selection chrome', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    expect(shots).toContain('shotFraming={shotFraming}');
    expect(shots).toContain('cameraReseedGeneration');
    expect(shots).toContain('objectEditingActive={stagingMode}');
    expect(shots).toContain('onSelectObject={stagingMode ? selectStagedObject : undefined}');
    expect(viewport).toContain('(shotFramingRef.current && !objectEditingActiveRef.current)');
    expect(viewport).toContain('showSceneGuides: shotFraming ? false : showSceneGuides');
    expect(viewport).toContain('if (framing && !objectEditingActiveRef.current) return;');
    expect(viewport).toContain('objectEditingActiveRef.current = objectEditingActive');
    expect(viewport).toContain('const preserveCamera = Boolean(framing);');
    expect(viewport).toContain('preserveCamera: Boolean(shotFramingRef.current)');
    expect(viewport).toContain('if (!options.preserveCamera)');
  });

  it('disables fog for shot-framing viewfinder scenes while keeping Build fog', () => {
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    expect(viewport).toContain("fog: !shotFraming && appearance !== 'depth'");
    expect(viewport).toContain("fogDistance: shotFraming || appearance === 'depth' ? undefined : renderDistance");
    // Both must be present in the same buildScene options object.
    expect(viewport).toMatch(
      /buildScene\(\s*project,\s*\{[\s\S]*?fog:\s*!shotFraming && appearance !== 'depth'[\s\S]*?fogDistance:\s*shotFraming \|\| appearance === 'depth' \? undefined : renderDistance/,
    );
  });

  it('isolates build placement to explicit SceneViewport props instead of global build mode', () => {
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(viewport).not.toContain('getBuildInteractionState');
    expect(viewport).not.toContain('useProjectStore');
    expect(viewport).not.toContain('buildMode');
    expect(viewport).not.toContain('activePrimitive');
    expect(viewport).toContain('placementTypeRef.current');
    expect(viewport).toContain('originPlacementActiveRef.current');
    expect(viewport).toContain('snapToGridRef.current');
    expect(shots).not.toContain('placementType');
    expect(shots).not.toContain('originPlacementActive');
    expect(shots).not.toContain('onPlaceObject');
    expect(shots).not.toContain('onMovePanoOrigin');
    expect(build).toContain('placementType={buildMode === \'place\' ? activePrimitive : undefined}');
    expect(build).toContain('originPlacementActive={buildMode === \'pano_origin\'}');
    expect(build).toContain('onPlaceObject={placeObject}');
  });

  it('adds filmstrip scroll affordances', () => {
    const filmstrip = readFileSync(new URL('../src/components/common/ShotFilmstrip.tsx', import.meta.url), 'utf8');
    expect(filmstrip).toContain('ChevronLeft');
    expect(filmstrip).toContain('Scroll shots left');
  });

  it('keeps accent-tone primary actions for main workflow CTAs', () => {
    const primaryCta = readFileSync(new URL('../src/components/common/PrimaryCTA.tsx', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    expect(primaryCta).toContain("tone?: 'accent' | 'success'");
    expect(primaryCta).toContain('bg-[var(--accent)]');
    expect(reference).not.toContain('tone="success"');
    expect(shots).not.toContain('tone="success"');
    expect(exportWorkspace).not.toContain('tone="success"');
  });

  it('renders reference workspace with landmark markers, strip, and accent approve CTA', () => {
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    expect(reference).toContain('PanoLandmarkMarkers');
    expect(reference).toContain('LandmarkStrip');
    expect(reference).toContain('panoOrigin={panoOrigin}');
    expect(reference).toContain('Approve as Reference');
    expect(reference).toContain('rounded-[18px]');
  });

  it('renders build transform gizmo affordances and hides scene guides by default', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const gizmo = readFileSync(new URL('../src/engine/transformGizmo.ts', import.meta.url), 'utf8');
    expect(build).toContain('showSceneGuides');
    expect(build).toContain('useState(false)');
    expect(build).toContain('showTransformGizmo');
    expect(build).toContain('RotateCw');
    expect(build).toContain('ZoomIn');
    expect(viewport).toContain('createGizmoGroup');
    expect(viewport).toContain('gizmoMode');
    expect(viewport).toContain('onMoveObjectInSpace');
    expect(viewport).toContain('showSceneGuides');
    expect(gizmo).toContain('0x14b8a6');
  });

  it('exposes build undo/redo controls and history batching on the viewport', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const projectSlice = readFileSync(new URL('../src/state/slices/projectSlice.ts', import.meta.url), 'utf8');
    const historySlice = readFileSync(new URL('../src/state/slices/historySlice.ts', import.meta.url), 'utf8');
    const historyRuntime = readFileSync(new URL('../src/state/slices/historyRuntime.ts', import.meta.url), 'utf8');
    expect(build).toContain('data-build-undo');
    expect(build).toContain('data-build-redo');
    expect(build).toContain('Undo Build edit');
    expect(build).toContain('history: \'coalesce\'');
    expect(build).toContain('undoBuild');
    expect(build).toContain('onEditBatchStart={beginBuildHistoryBatch}');
    expect(viewport).toContain('onEditBatchStart');
    expect(viewport).toContain('startEditBatch');
    expect(historySlice).toContain('beginBuildHistoryBatch');
    expect(historySlice).toContain('undoBuild');
    expect(projectSlice).toContain('options?.history');
    expect(historyRuntime).toContain('history?: BuildHistoryMode');
  });

  it('ends the production path at export handoff without a review stage', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../src/engine/workflow.ts', import.meta.url), 'utf8');
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    expect(app).toContain("id: 'export'");
    expect(app).not.toContain("id: 'review'");
    expect(workflow).toContain("['build', 'reference', 'shots', 'export']");
    expect(workflow).toContain('normalizeWorkspace');
    expect(workflow).not.toContain("return ['Import an AI result frame in Review first.']");
    expect(shots).toContain('setWorkspace');
    expect(shots).toContain('data-shots-shutter');
  });

  it('offers a simple 360 viewer mode with download current view', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const modeStore = readFileSync(new URL('../src/state/useAppModeStore.ts', import.meta.url), 'utf8');
    const chooser = readFileSync(new URL('../src/components/common/ModeChooser.tsx', import.meta.url), 'utf8');
    const panoViewer = readFileSync(new URL('../src/components/workspaces/PanoViewerWorkspace.tsx', import.meta.url), 'utf8');
    expect(modeStore).toContain('BRAND.prefs.appMode');
    expect(modeStore).toContain('BRAND.legacyPrefs.appMode');
    expect(modeStore).toContain("'studio' | 'panoViewer'");
    expect(app).toContain('ModeChooser');
    expect(app).toContain('PanoViewerWorkspace');
    expect(app).toContain('Simple 360 Viewer');
    expect(app).toContain('Open ForeScene');
    expect(app).toContain('data-brand-menu-trigger');
    expect(app).toContain('ChevronDown');
    expect(app).toContain('Open app menu');
    expect(chooser).toContain('data-mode-chooser');
    expect(chooser).toContain('Just view a 360 pano');
    expect(panoViewer).toContain('Download current view');
    expect(panoViewer).toContain('renderPanoPerspectiveCrop');
    expect(panoViewer).toContain('downloadDataUrl');
    expect(panoViewer).toContain('data-pano-viewer-workspace');
    expect(panoViewer).toContain('data-pano-viewer-isolated');
    // Must not mutate the ForeScene studio project from simple viewer.
    expect(panoViewer).not.toContain("from '../../state/useProjectStore'");
    expect(panoViewer).not.toContain('importCanonicalPano');
    expect(panoViewer).toContain('useState');
  });

  it('uses sequential capture state empty|capturing|finished without export-on-shutter', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const cameraMoveCtrl = readFileSync(new URL('../src/components/shots/useCameraMoveController.ts', import.meta.url), 'utf8');
    const stillCaptureCtrl = readFileSync(new URL('../src/components/shots/useStillCaptureController.ts', import.meta.url), 'utf8');
    const cameraMovePreviewCtrl = readFileSync(new URL('../src/components/shots/useCameraMovePreviewController.ts', import.meta.url), 'utf8');
    // Concat workspace + chrome + settings + controllers for symbol checks; data-attrs stay on workspace JSX.
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings + '\n' + cameraMoveCtrl + '\n' + stillCaptureCtrl + '\n' + cameraMovePreviewCtrl;
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const strip = readFileSync(new URL('../src/components/workspaces/KeyframeStrip.tsx', import.meta.url), 'utf8');
    expect(shots).toContain("VideoCaptureState");
    // data-attrs live on workspace/chrome JSX (not the camera-move controller).
    expect(shots).toContain('data-shots-video-capture-state');
    expect(shots).toContain('appendSequentialCapture');
    expect(shots).toContain('finishSequentialCapture');
    expect(shots).toContain('continueSequentialCapture');
    expect(shots).toContain('retakeVideoMove');
    expect(shotsWorkspace).toContain('data-shots-video-retake');
    expect(shotsWorkspace).toContain('data-shots-video-rec-badge');
    expect(shots).toContain('KeyframeStrip');
    expect(strip).toContain('data-camera-keyframe-strip');
    expect(strip).toContain('data-camera-keyframe-node');
    expect(strip).toContain('data-camera-keyframe-segment');
    expect(strip).toContain('data-camera-keyframe-capture-next');
    expect(strip).toContain('data-camera-keyframe-finish');
    expect(strip).toContain('data-camera-keyframe-continue');
    expect(strip).toContain('data-camera-keyframe-insert');
    expect(strip).toContain('data-camera-keyframe-update-pose');
    expect(strip).toContain('data-camera-keyframe-stop-preview');
    expect(strip).toContain('Stop preview');
    expect(shotsWorkspace).toContain('data-shots-video-refresh-thumbnail');
    expect(shots).toContain('interpolateObjectOverrides');
    expect(shots).toContain('viewportObjectOverrides');
    // Progressive disclosure (no Simple/Pro split): compact actions then optional timeline.
    expect(shots).not.toContain("type VideoAuthoringMode = 'simple' | 'pro'");
    expect(shots).not.toContain('data-shots-video-mode-simple');
    expect(shotsWorkspace).toContain('data-shots-video-compact-actions');
    expect(shotsWorkspace).toContain('data-shots-video-edit-timeline');
    expect(shotsWorkspace).toContain('data-shots-video-finished');
    expect(shotsWorkspace).toContain('data-shots-video-export');
    expect(shotsWorkspace).toContain('data-shots-video-next-shot');
    expect(shots).toContain('completeVideoAndNextShot');
    expect(shots).toContain('resumeVideoAfterNextShotRef');
    expect(shots).toContain('UNDO_RESTORED');
    expect(shots).toContain('videoAuthoring.dispatch');
    expect(shots).toContain('thumbnailFreshAfterFinishRef');
    expect(shotsWorkspace).toMatch(/showTimeline = timelineOpen \|\| cameraMoveKeyframes\.length > 2/);
    // Intermediate sequential captures must not thrash snapshotPreview.
    expect(shots).toMatch(/if \(wasEmpty\) \{\s*snapshotPreview/);
    expect(shots).toMatch(/finishSequentialCapture[\s\S]*snapshotPreview/);
    // Next shot reuses finish thumbnail only after a successful primary still render.
    expect(shots).toMatch(/!thumbnailFreshAfterFinishRef\.current/);
    expect(shots).toContain('markThumbnailFreshOnSuccess');
    expect(stillCaptureCtrl).toMatch(/markThumbnailFreshOnSuccess[\s\S]*thumbnailFreshAfterFinishRef\.current = true/);
    // Captured moves show a keyframe filmstrip / path preview (not only Export).
    expect(shots).toContain('CameraMovePreviewStrip');
    expect(shots).toContain('captureKeyframeThumb');
    expect(shots).toContain('buildKeyframeThumbCacheFromKeyframes');
    expect(shots).toContain('shouldCommitKeyframeThumb');
    // History restore: workspace effect calls controller; controller owns generation bump.
    expect(shotsWorkspace).toContain('shotCameraHistoryRestoreGeneration');
    expect(shotsWorkspace).toContain('handleHistoryRestore');
    expect(cameraMoveCtrl).toMatch(/keyframeThumbGenerationRef\.current \+= 1/);
    expect(cameraMoveCtrl).toMatch(/buildKeyframeThumbCacheFromKeyframes\(restoredKeyframes\)/);
    // Cross-module: restore generation in workspace precedes thumb invalidation in controller.
    expect(shots).toMatch(/shotCameraHistoryRestoreGeneration[\s\S]*keyframeThumbGenerationRef\.current \+= 1/);
    const previewStrip = readFileSync(new URL('../src/components/workspaces/CameraMovePreviewStrip.tsx', import.meta.url), 'utf8');
    expect(previewStrip).toContain('data-camera-move-preview-strip');
    expect(previewStrip).toContain('data-camera-move-preview-play');
    // Re-entering Video preserves existing keyframes and restores capture state from them.
    // Only Retake / explicit clear wipes the sequence — never auto-capture Start on enter.
    const enterVideoModeBody = shots.match(
      /const enterVideoMode = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
    )?.[0] ?? '';
    expect(enterVideoModeBody).toContain("type: 'ENTER_VIDEO'");
    expect(enterVideoModeBody).not.toContain('updateCameraMoveKeyframes([])');
    expect(enterVideoModeBody).not.toContain("slot: 'start'");
    const retakeVideoMoveBody = shots.match(
      /const retakeVideoMove = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
    )?.[0] ?? '';
    expect(retakeVideoMoveBody).toContain('updateCameraMoveKeyframes([])');
    expect(retakeVideoMoveBody).toContain("type: 'RETAKE'");
    // Sequential append must keep the live fly pose.
    expect(shots).toMatch(/appendSequentialCapture[\s\S]*updateShot\(selectedShot\.id, \{[\s\S]*camera: pose/);
    expect(shots).toMatch(/startFlyCamera[\s\S]*if \(selectedShot && !shotCameraFlying\)/);
    // Fly re-seed is driven by an explicit camera reseed token, not live camera churn.
    expect(viewport).toContain('cameraReseedGeneration');
    expect(viewport).toContain('shouldReseedShotFramingViewport');
    expect(viewport).toContain('shotFraming?.cameraReseedGeneration');
    expect(viewport).not.toMatch(/useEffect\([\s\S]*shotFraming\?\.camera\.fovDegrees[\s\S]*\],\s*\)/);
    // Export must not be gated on !shotCameraFlying; shutter must not export after second pose.
    expect(shots).not.toMatch(/if \(shotCameraFlying \|\| !cameraMoveReady\)/);
    expect(shots).not.toContain("type VideoShutterPhase = 'record' | 'stop' | 'export'");
    expect(shots).not.toMatch(/if \(videoPhase === 'record'\)/);
    // Preview after capture should read latest store project (not stale closure only).
    expect(shots).toContain('useProjectStore.getState().project');
    // Instructional copy is state-aware (no old fly-to-end / end-set guidance).
    expect(shots).not.toContain('Fly to end · press stop');
    expect(shots).not.toContain('End set · export when ready');
    expect(shots).toContain('Pose the first camera position · capture start');
  });

  it('keeps keyframe strip as primary editor and easing in the advanced drawer', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const cameraMoveCtrl = readFileSync(new URL('../src/components/shots/useCameraMoveController.ts', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings + '\n' + cameraMoveCtrl;
    expect(shotsWorkspace).toContain('data-camera-keyframe-easing');
    expect(shots).toContain('updateIntermediateCameraKeyframeTime');
    expect(shots).toContain('removeIntermediateCameraKeyframe');
    // Old drawer intermediate list/add path must not remain the primary editor.
    expect(shots).not.toContain('data-camera-keyframe-editor');
    expect(shots).not.toContain('data-camera-keyframe-add');
    expect(shots).not.toContain('data-camera-intermediate-keyframe');
    expect(shots).not.toContain('Add in-between keyframe');
    expect(shotsWorkspace).toContain('Set Start');
    expect(shotsWorkspace).toContain('Set End');
  });

  it('keeps hidden staged objects recoverable from the staging list', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    expect(shots).toContain('filterStagingObjectList');
    expect(shots).toContain('data-shots-staging-scope-people-props');
    expect(shots).toContain("title={object.visible ? undefined : 'Hidden in this shot'}");
    expect(shots).toContain('aria-label="Hidden in this shot"');
    expect(shots).toContain("object.visible ? '' : 'opacity-55'");
  });

  it('keeps export multi-select reconciled and add-camera local to export', () => {
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const exportSettingsPanel = readFileSync(new URL('../src/components/export/ExportSettingsPanel.tsx', import.meta.url), 'utf8');
    const projectSlice = readFileSync(new URL('../src/state/slices/projectSlice.ts', import.meta.url), 'utf8');
    const workflowSlice = readFileSync(new URL('../src/state/slices/workflowSlice.ts', import.meta.url), 'utf8');
    expect(exportWorkspace).toContain('reconcileExportSelectedShotIds');
    expect(exportWorkspace).toContain('navigateToShots: false');
    expect(exportWorkspace).toContain('WarningDetailsButton');
    expect(exportWorkspace).toContain('getExportSelectionWarnings');
    expect(exportWorkspace).toContain('data-export-project-readiness');
    expect(exportWorkspace).toContain('Package readiness');
    expect(exportWorkspace).toContain('getShotWarnings');
    expect(exportWorkspace).toContain('data-export-progress-panel');
    expect(exportWorkspace).toContain('abortRef.current?.abort()');
    expect(exportWorkspace).toContain('planHasBlockingErrors');
    expect(exportWorkspace).toContain('verifiedPlan');
    expect(exportWorkspace).toContain('plan: verifiedPlan');
    expect(exportWorkspace).toContain('data-export-plan-blocking-errors');
    expect(exportWorkspace).toContain('exportBlocked');
    expect(exportWorkspace).not.toContain('WarningPopover');
    expect(exportSettingsPanel).toContain('shouldShowMissingLandmarkPromptNote');
    expect(exportSettingsPanel).toContain('data-export-prompt-landmark-note');
    expect(exportWorkspace).toContain('Handoff packages');
    expect(workflowSlice).toContain('An export is currently running. Cancel it and leave?');
    expect(projectSlice).toContain('navigateToShots?: boolean');
  });

  it('keeps export shot rows and composed package summary with a docked CTA footer', () => {
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    expect(exportWorkspace).toContain('fitsCompactShotList');
    expect(exportWorkspace).toContain('h-9 w-16 shrink-0');
    expect(exportWorkspace).toContain('data-export-package-panel="composed"');
    expect(exportWorkspace).toContain('data-export-package-visual');
    expect(exportWorkspace).toContain('w-44 max-w-[11rem]');
    expect(exportWorkspace).toContain('Package Contents');
    expect(exportWorkspace).toContain('data-export-package-header');
    expect(exportWorkspace).toContain('data-export-settings-trigger');
    expect(exportWorkspace).toContain('data-export-shot-row={checked ? \'selected\' : \'default\'}');
    expect(exportWorkspace).toContain('shadow-[inset_3px_0_0_var(--accent)]');
    expect(exportWorkspace).not.toContain('bg-accent-soft shadow-[0_0_0_1px_var(--accent-glow)]');
    expect(exportWorkspace).toContain('shrink-0 border-t border-subtle');
    expect(exportWorkspace).toContain('layout="inline"');
    expect(exportWorkspace).not.toContain('<header className="mb-2 shrink-0">');
  });

  it('prioritizes key export output paths in capped last-export preview', () => {
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const exportManifest = readFileSync(new URL('../src/engine/exportManifest.ts', import.meta.url), 'utf8');
    expect(exportWorkspace).toContain('selectExportPathPreview');
    expect(exportWorkspace).toContain('lastExportPreviewPaths');
    expect(exportWorkspace).not.toMatch(/lastExport\.slice\(0,\s*\d+\)/);
    expect(exportManifest).toContain('PRIORITY_EXPORT_PATH_MARKERS');
    expect(exportManifest).toContain('/outputs/ai_result_frame.png');
  });

  it('reserves a dedicated CTA lane so the reference landmark strip does not span underneath', () => {
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(styles).toContain('--reference-cta-lane');
    expect(reference).toContain('data-reference-bottom-chrome');
    expect(reference).toContain('max-w-[calc(100%-var(--reference-cta-lane))]');
    expect(reference).toContain('Approve as Reference');
    expect(reference).not.toMatch(/LandmarkStrip[\s\S]*bottom-5 right-5[\s\S]*PrimaryCTA/);
  });

  it('reserves space for the camera shutter chrome on shots', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(styles).toContain('--shots-overlay-bottom-safe');
    expect(shots).toContain('data-shots-camera-chrome');
    expect(shots).toContain('data-shots-shutter');
    expect(shots).toContain('viewfinder stays live');
  });

  it('bundles a CC0 human mannequin glb for person scale references', () => {
    const license = readFileSync(new URL('../public/models/human-mannequin.license.txt', import.meta.url), 'utf8');
    const model = readFileSync(new URL('../public/models/human-mannequin.glb', import.meta.url));
    expect(license).toContain('Quaternius');
    expect(license).toContain('CC0');
    expect(model.subarray(0, 4).toString()).toBe('glTF');
  });

  it('shows build drag guidance near the gizmo when an object is selected', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(build).toContain('data-build-drag-guidance');
    expect(build).toContain('Drag arrows to move');
    expect(build).toContain('Drag rings to rotate');
    expect(build).toContain('Drag handles to scale');
    expect(build).toContain('buildMode === \'select\'');
    expect(build).toContain('showTransformGizmo');
  });

  it('keeps Build floating controls below the mobile-safe header', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');

    expect(build).toContain("'calc(var(--stage-header-safe) + 4rem)'");
    expect(build).toContain('data-build-selection-tools');
    expect(build).toContain('top-[calc(var(--stage-header-safe)+7.5rem)]');
    expect(build).not.toContain('top-20');
  });

  it('sizes the Build tray to its tools while constraining the mobile scroller', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');

    expect(build).toContain('w-fit max-w-[calc(100vw-1.5rem)]');
    expect(build).not.toContain('w-[min(100%-1.5rem,calc(100%-1.5rem))]');
    expect(build).toContain('overflow-x-auto');
  });

  it('renders polished theme-aware shot thumbnail fallbacks for missing media', () => {
    const shotThumbnail = readFileSync(new URL('../src/components/common/ShotThumbnail.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(shotThumbnail).toContain('data-shot-thumbnail-fallback');
    expect(shotThumbnail).toContain('ShotThumbnailFallback');
    expect(shotThumbnail).toContain('No preview');
    expect(shotThumbnail).not.toContain('ImageIcon');
    expect(styles).toContain('--thumbnail-fallback-sky');
    expect(styles).toContain('--thumbnail-fallback-block-a');
  });

  it('uses compact shot thumbnail fallbacks without cramped labels in export rows', () => {
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const shotThumbnail = readFileSync(new URL('../src/components/common/ShotThumbnail.tsx', import.meta.url), 'utf8');
    expect(exportWorkspace).toContain('compact className="h-9 w-16 shrink-0"');
    expect(shotThumbnail).toContain('compact?: boolean');
    expect(shotThumbnail).toContain('data-shot-thumbnail-compact');
    expect(shotThumbnail).toContain('{!compact && (');
    expect(shotThumbnail).toContain('thumbnail-fallback-block-a');
  });

  it('uses theme-aware pano viewer colors and build tray glow tokens', () => {
    const panoViewer = readFileSync(new URL('../src/components/viewers/PanoViewer.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(panoViewer).toContain('useThemeStore');
    expect(panoViewer).toContain('THEME_COLORS');
    expect(build).toContain('shadow-[var(--tray-glow)]');
    expect(build).not.toContain("appearance={theme === 'dark' ? 'glow-outline' : 'solid'}");
    expect(styles).toContain('--tray-glow');
    expect(styles).toContain('--cta-glow');
  });
});
