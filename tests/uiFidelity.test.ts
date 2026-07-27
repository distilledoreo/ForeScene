import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ui revamp fidelity surfaces', () => {
  it('floats the stage rail over a full-bleed workspace instead of a separate header strip', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    const shell = readFileSync(new URL('../src/components/workspaces/WorkspaceShell.tsx', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
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

  it('declares Continuity Stage favicon assets in the app shell', () => {
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
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
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
    expect(shots).toContain('renderShotProjectedFrame');
    expect(shots).not.toContain('data-shots-action-dock');
    expect(shots).not.toContain('data-shots-land-fork');
    expect(shots).not.toContain('ShotInfoCard');
  });

  it('exposes clay/projected appearance controls and double-tap W sprint', () => {
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const shortcuts = readFileSync(new URL('../src/engine/buildShortcuts.ts', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../src/components/workspaces/ReferenceWorkspace.tsx', import.meta.url), 'utf8');
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
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
    expect(exportWorkspace).toContain('includeProjectedViewport');
    expect(exportWorkspace).toContain('includeProjectedCameraMoveVideo');
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

  it('pauses automatic shot frame preview renders while fly camera is active', () => {
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    expect(shots).not.toContain('flyCameraRevision');
    expect(shots).toMatch(/useEffect\(\(\) => \{[\s\S]*if \(shotCameraFlying\) return;[\s\S]*renderShotFrame\(project, previewShot\)/);
    expect(shots).toMatch(/handleFramingCameraChange[\s\S]*if \(shotCameraFlying\) return;/);
    expect(shots).not.toMatch(/handleFramingCameraChange[\s\S]*setFlyCameraRevision/);
    expect(shots).not.toMatch(/startFlyCamera[\s\S]*setFramePreviewUrl\(undefined\)/);
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
    const store = readFileSync(new URL('../src/state/useContinuityStore.ts', import.meta.url), 'utf8');
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
    expect(store).toContain('isRenderingGraybox: false');
    expect(store).toContain('shotCameraFlying: false');
    expect(store).toMatch(/setProject:[\s\S]*isExportingPackage: false/);
    expect(renderers).toContain('disposeRenderer');
    expect(renderers).toContain('forceContextLoss');
  });

  it('keeps the default Build orbit centered and consumes free-camera shortcuts before Build actions', () => {
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(viewport).toContain('const freeCameraModeRef = useRef(freeCameraActive);');
    expect(viewport).toContain('if (!modeChanged || shotFraming) return;');
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
    expect(build).toContain('{selectedObjects.length > 0 && editingChromeVisible && buildMode !== \'pano_origin\' && (');
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
    const store = readFileSync(new URL('../src/state/useContinuityStore.ts', import.meta.url), 'utf8');
    expect(reference).toContain('data-pano-reference-list');
    expect(reference).toContain('data-remove-pano');
    expect(reference).toContain('Remove Uploaded Pano');
    expect(reference).toContain('removePanoReference');
    expect(store).toContain('removePanoReference:');
    expect(store).toContain('importStyledPano:');
    expect(store).toContain('pendingSecondCapturePlan');
    expect(store).toContain('setPendingSecondCapturePlan');
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
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    expect(shots).toContain('data-shots-advanced-settings');
    expect(shots).toContain('Download PNG');
    expect(shots).toContain('Pano match');
    expect(shots).toContain('Video mode (advanced)');
    expect(shots).not.toContain("label={isRenderingFrame ? 'Rendering...' : 'Render Shot Preview'}");
  });

  it('labels export settings as active-shot scope only', () => {
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    expect(exportWorkspace).toContain('data-export-settings-scope');
    expect(exportWorkspace).toContain('active shot');
  });

  it('uses camera-style bottom chrome without a floating shot dossier', () => {
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
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
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
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
    expect(viewport).toContain('fog: !shotFraming');
    expect(viewport).toContain('fogDistance: shotFraming ? undefined : renderDistance');
    // Both must be present in the same buildScene options object.
    expect(viewport).toMatch(
      /buildScene\(\s*project,\s*\{[\s\S]*?fog:\s*!shotFraming[\s\S]*?fogDistance:\s*shotFraming \? undefined : renderDistance/,
    );
  });

  it('isolates build placement to explicit SceneViewport props instead of global build mode', () => {
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(viewport).not.toContain('getBuildInteractionState');
    expect(viewport).not.toContain('useContinuityStore');
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
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
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
    const store = readFileSync(new URL('../src/state/useContinuityStore.ts', import.meta.url), 'utf8');
    expect(build).toContain('data-build-undo');
    expect(build).toContain('data-build-redo');
    expect(build).toContain('Undo Build edit');
    expect(build).toContain('history: \'coalesce\'');
    expect(build).toContain('undoBuild');
    expect(build).toContain('onEditBatchStart={beginBuildHistoryBatch}');
    expect(viewport).toContain('onEditBatchStart');
    expect(viewport).toContain('startEditBatch');
    expect(store).toContain('beginBuildHistoryBatch');
    expect(store).toContain('undoBuild');
    expect(store).toContain("history?: BuildHistoryMode");
  });

  it('ends the production path at export handoff without a review stage', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../src/engine/workflow.ts', import.meta.url), 'utf8');
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
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
    expect(modeStore).toContain("panoref-app-mode");
    expect(modeStore).toContain("'continuity' | 'panoViewer'");
    expect(app).toContain('ModeChooser');
    expect(app).toContain('PanoViewerWorkspace');
    expect(app).toContain('Simple 360 Viewer');
    expect(app).toContain('Open Continuity Stage');
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
    // Must not mutate Continuity Stage project from simple viewer.
    expect(panoViewer).not.toContain("from '../../state/useContinuityStore'");
    expect(panoViewer).not.toContain('importCanonicalPano');
    expect(panoViewer).toContain('useState');
  });

  it('uses sequential capture state empty|capturing|finished without export-on-shutter', () => {
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const viewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const strip = readFileSync(new URL('../src/components/workspaces/KeyframeStrip.tsx', import.meta.url), 'utf8');
    expect(shots).toContain("VideoCaptureState");
    expect(shots).toContain('data-shots-video-capture-state');
    expect(shots).toContain('appendSequentialCapture');
    expect(shots).toContain('finishSequentialCapture');
    expect(shots).toContain('continueSequentialCapture');
    expect(shots).toContain('retakeVideoMove');
    expect(shots).toContain('data-shots-video-retake');
    expect(shots).toContain('data-shots-video-rec-badge');
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
    expect(shots).toContain('data-shots-video-refresh-thumbnail');
    expect(shots).toContain('interpolateObjectOverrides');
    expect(shots).toContain('viewportObjectOverrides');
    // Simple vs Pro authoring chrome (Simple default; strip is Pro-only).
    expect(shots).toContain("type VideoAuthoringMode = 'simple' | 'pro'");
    expect(shots).toContain("useState<VideoAuthoringMode>('simple')");
    expect(shots).toContain('data-shots-video-mode-simple');
    expect(shots).toContain('data-shots-video-mode-pro');
    expect(shots).toContain('data-shots-video-simple-chrome');
    expect(shots).toContain('data-shots-video-export');
    expect(shots).toContain('data-shots-video-next-shot');
    expect(shots).toContain('completeVideoAndNextShot');
    expect(shots).toContain('resumeVideoAfterNextShotRef');
    expect(shots).toMatch(/videoAuthoringMode === 'pro' && \(\s*<KeyframeStrip/);
    expect(shots).toMatch(/simpleComplete = videoAuthoringMode === 'simple' && nextKeyframes\.length >= 2/);
    // Intermediate sequential captures must not thrash snapshotPreview.
    expect(shots).toMatch(/if \(wasEmpty\) \{\s*snapshotPreview/);
    expect(shots).toMatch(/finishSequentialCapture[\s\S]*snapshotPreview/);
    // Re-entering Video preserves existing keyframes and restores capture state from them.
    // Only Retake / explicit clear wipes the sequence — never auto-capture Start on enter.
    const enterVideoModeBody = shots.match(
      /const enterVideoMode = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
    )?.[0] ?? '';
    expect(enterVideoModeBody).toContain('captureStateFromKeyframes(existing)');
    expect(enterVideoModeBody).not.toContain('updateCameraMoveKeyframes([])');
    expect(enterVideoModeBody).not.toContain("slot: 'start'");
    const retakeVideoMoveBody = shots.match(
      /const retakeVideoMove = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
    )?.[0] ?? '';
    expect(retakeVideoMoveBody).toContain('updateCameraMoveKeyframes([])');
    expect(retakeVideoMoveBody).toContain("setVideoCaptureState('empty')");
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
    expect(shots).toContain('useContinuityStore.getState().project');
    // Instructional copy is state-aware (no old fly-to-end / end-set guidance).
    expect(shots).not.toContain('Fly to end · press stop');
    expect(shots).not.toContain('End set · export when ready');
    expect(shots).toContain('Pose the first camera position · capture start');
  });

  it('keeps keyframe strip as primary editor and easing in the advanced drawer', () => {
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    expect(shots).toContain('data-camera-keyframe-easing');
    expect(shots).toContain('updateIntermediateCameraKeyframeTime');
    expect(shots).toContain('removeIntermediateCameraKeyframe');
    // Old drawer intermediate list/add path must not remain the primary editor.
    expect(shots).not.toContain('data-camera-keyframe-editor');
    expect(shots).not.toContain('data-camera-keyframe-add');
    expect(shots).not.toContain('data-camera-intermediate-keyframe');
    expect(shots).not.toContain('Add in-between keyframe');
    expect(shots).toContain('Set Start');
    expect(shots).toContain('Set End');
  });

  it('keeps hidden staged objects recoverable from the staging list', () => {
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    expect(shots).toContain('getStageableObjectsForShot');
    expect(shots).toContain("title={object.visible ? undefined : 'Hidden in this shot'}");
    expect(shots).toContain('aria-label="Hidden in this shot"');
    expect(shots).toContain("object.visible ? '' : 'opacity-55'");
  });

  it('keeps export multi-select reconciled and add-camera local to export', () => {
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../src/state/useContinuityStore.ts', import.meta.url), 'utf8');
    expect(exportWorkspace).toContain('reconcileExportSelectedShotIds');
    expect(exportWorkspace).toContain('navigateToShots: false');
    expect(exportWorkspace).toContain('WarningDetailsButton');
    expect(exportWorkspace).toContain('getExportSelectionWarnings');
    expect(exportWorkspace).toContain('data-export-project-readiness');
    expect(exportWorkspace).toContain('Package readiness');
    expect(exportWorkspace).toContain('getShotWarnings');
    expect(exportWorkspace).toContain('data-export-progress-panel');
    expect(exportWorkspace).toContain('abortRef.current?.abort()');
    expect(exportWorkspace).not.toContain('WarningPopover');
    expect(exportWorkspace).toContain('shouldShowMissingLandmarkPromptNote');
    expect(exportWorkspace).toContain('data-export-prompt-landmark-note');
    expect(exportWorkspace).toContain('Handoff packages');
    expect(store).toContain('An export is currently running. Cancel it and leave?');
    expect(store).toContain('navigateToShots?: boolean');
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
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
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
