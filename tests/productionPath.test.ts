import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workflow guidance UI', () => {
  it('uses modal guidance instead of a persistent production path rail', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('WorkflowGuidance');
    expect(app).toContain('ProjectMenuButton');
    expect(app).toContain('requestObjectiveModal');
    expect(app).not.toContain('ObjectiveHelpButton');
    expect(app).not.toContain('ProductionPath');
    expect(app).not.toContain('DirectorQuest');
  });

  it('keeps project import discoverable and retryable after the full-bleed revamp', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const lifecycle = readFileSync(new URL('../src/hooks/useProjectLifecycle.ts', import.meta.url), 'utf8');
    expect(app).toContain('openProjectPicker');
    expect(app).toContain('title="Import project backup"');
    expect(app).toContain('title="Export verified project backup"');
    expect(app).toContain('data-project-import-input');
    expect(app).toContain('data-project-export-button');
    expect(app).toContain('data-project-name-input');
    expect(lifecycle).toContain('const saveProject');
    expect(lifecycle).toContain('loadProjectIo');
    expect(lifecycle).toContain('downloadProject(verified.project)');
    expect(app).toContain('accept={projectBackupAcceptAttribute()}');
    expect(lifecycle).toContain('Project opened:');
    expect(lifecycle).toContain('Could not open project:');
    expect(app).toContain('data-project-import-status');
    expect(lifecycle).toContain('IMPORT_STATUS_DISMISS_MS');
    expect(lifecycle).toContain("fileRef.current.value = ''");
    expect(app).toContain('setProjectMenuOpen(false)');
    expect(app).toContain("event.key === 'Escape'");
    expect(app).toMatch(/label="Import Project Backup"[\s\S]*openProjectPicker\(\)/);
    expect(app).toMatch(/label="Export Project Backup"[\s\S]*saveProject\(\)/);
  });

  it('surfaces local save status including failed writes for F5 storage failure UX', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const lifecycle = readFileSync(new URL('../src/hooks/useProjectLifecycle.ts', import.meta.url), 'utf8');
    const controller = readFileSync(new URL('../src/engine/projectPersistenceController.ts', import.meta.url), 'utf8');
    const safety = readFileSync(new URL('../src/engine/projectSafety.ts', import.meta.url), 'utf8');

    // Header chrome exposes the live controller status (including 'failed').
    expect(app).toContain('data-project-save-status={projectSaveStatus}');
    expect(app).toContain('ProjectSaveStatusIndicator');
    expect(app).toContain("role={status === 'failed' ? 'alert' : 'status'}");
    expect(app).toContain("status === 'failed'");
    expect(safety).toContain("'failed'");
    expect(safety).toContain('export type ProjectSaveStatus');

    // Asset-cache and flush failures both route to failed status without inventing UI.
    expect(controller).toContain('reportAssetPersistenceFailure');
    expect(controller).toContain("status: 'failed'");
    expect(lifecycle).toContain('reportAssetPersistenceFailure');
  });

  it('exposes New Project with confirmation and recovery snapshot', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const lifecycle = readFileSync(new URL('../src/hooks/useProjectLifecycle.ts', import.meta.url), 'utf8');
    expect(app).toContain('startNewProject');
    expect(app).toContain('data-project-new-button');
    expect(app).toContain('data-project-new-confirm');
    expect(lifecycle).toContain('createDefaultProject');
    expect(lifecycle).toContain('Before starting a new project');
    expect(app).toMatch(/label="New Project"/);
    expect(app).toContain('Start a new project?');
  });

  it('uses progressive disclosure layouts with shot filmstrip and precision drawer', () => {
    const shotsWorkspace = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const shotsChrome = readFileSync(new URL('../src/components/shots/ShotsCaptureChrome.tsx', import.meta.url), 'utf8');
    const shotSettings = readFileSync(new URL('../src/components/shots/ShotSettings.tsx', import.meta.url), 'utf8');
    const shots = shotsWorkspace + '\n' + shotsChrome + '\n' + shotSettings;
    const shell = readFileSync(new URL('../src/components/workspaces/WorkspaceShell.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const exportWorkspace = readFileSync(new URL('../src/components/workspaces/ExportWorkspace.tsx', import.meta.url), 'utf8');
    const shotThumbnail = readFileSync(new URL('../src/components/common/ShotThumbnail.tsx', import.meta.url), 'utf8');
    const shotInfoCard = readFileSync(new URL('../src/components/common/ShotInfoCard.tsx', import.meta.url), 'utf8');
    expect(shots).toContain('data-shots-camera-shell');
    expect(shots).toContain('data-shots-shutter');
    expect(shots).toContain('ShotCameraRollThumbnail');
    expect(shots).toContain('ShotsLibraryCard');
    expect(shotInfoCard).toContain('Open in 360');
    expect(shots).toContain('PrecisionDrawer');
    expect(shots).toContain('data-shots-advanced-settings');
    expect(shots).toContain('landShotFraming');
    expect(shots).toContain('Still');
    expect(shots).toContain('Video');
    const stillCapture = readFileSync(new URL('../src/components/shots/useStillCaptureController.ts', import.meta.url), 'utf8');
    const cameraMove = readFileSync(new URL('../src/components/shots/useCameraMoveController.ts', import.meta.url), 'utf8');
    expect(stillCapture).toContain("flushProject('Verified save before still render')");
    expect(cameraMove).toContain("flushProject('Verified save before video render')");
    expect(shots).not.toContain('ShotFilmstrip');
    expect(shots).not.toContain('ShotInfoCard');
    expect(shots).not.toContain('Go to Review');
    expect(build).toContain('FullBleedLayout');
    expect(build).toContain('PrecisionDrawer');
    expect(build).toContain('primaryTrayItems');
    expect(build).toContain('overflowTrayItems');
    expect(build).toContain('Render 360 Reference');
    expect(exportWorkspace).toContain('Camera move clay frames');
    expect(exportWorkspace).toContain('Export Settings');
    expect(exportWorkspace).toContain('getShotPrimaryLabel(shot)');
    expect(exportWorkspace).toContain('Handoff packages');
    expect(exportWorkspace).toContain("flushProject('Verified save before package export')");
    expect(exportWorkspace).toContain('const exportProject = verified.project');
    expect(stillCapture).toContain('const renderProject = verified.project');
    expect(app).not.toContain('ReviewWorkspace');
    expect(app).not.toContain("id: 'review'");
    expect(shotThumbnail).toContain('resolveShotThumbnail');
    expect(shell).toContain('FullBleedLayout');
    expect(shell).not.toContain('ShotDrawer');
    expect(shell).not.toContain('WorkspaceWithDrawer');
  });

  it('keeps revamp surfaces tokenized and theme-aware', () => {
    const fields = readFileSync(new URL('../src/components/common/Field.tsx', import.meta.url), 'utf8');
    const sceneViewport = readFileSync(new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url), 'utf8');
    const sceneObjects = readFileSync(new URL('../src/engine/sceneObjects.ts', import.meta.url), 'utf8');

    expect(fields).toContain('bg-surface-raised');
    expect(fields).not.toContain('bg-white');
    expect(sceneViewport).toContain('useThemeStore');
    expect(sceneViewport).toContain('theme');
    expect(sceneObjects).toContain('SceneVisualTheme');
    expect(sceneObjects).toContain('darkFloorMaterial');
  });
});
