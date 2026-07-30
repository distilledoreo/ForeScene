import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  BookOpen,
  Camera,
  ChevronDown,
  Clapperboard,
  CloudCheck,
  CloudOff,
  Compass,
  FileJson,
  FilePlus,
  FolderOpen,
  Globe,
  Moon,
  Package,
  RotateCcw,
  Save,
  ShieldCheck,
  Sun,
  Terminal,
  Upload,
} from 'lucide-react';
import type { Workspace } from './domain/types';
import type { ProjectSaveStatus } from './engine/projectSafety';
import { BRAND, projectBackupAcceptAttribute, readMigratedPreference } from './config/brand';
import { useAppModeStore } from './state/useAppModeStore';
import { useAgentControlStore } from './state/useAgentControlStore';
import { useProjectStore } from './state/useProjectStore';
import { useProjectSafetyStore } from './state/useProjectSafetyStore';
import { useThemeStore } from './state/useThemeStore';
import { useForeSceneAgentApi } from './hooks/useForeSceneAgentApi';
import { useProjectLifecycle } from './hooks/useProjectLifecycle';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ModeChooser } from './components/common/ModeChooser';
import SplashScreen from './components/common/SplashScreen';
import { TextInput } from './components/common/Field';
import { WorkspaceErrorBoundary } from './components/common/WorkspaceErrorBoundary';

const BuildWorkspace = lazy(() => import('./components/workspaces/BuildWorkspace').then((m) => ({ default: m.BuildWorkspace })));
const ReferenceWorkspace = lazy(() => import('./components/workspaces/ReferenceWorkspace').then((m) => ({ default: m.ReferenceWorkspace })));
const ShotsWorkspace = lazy(() => import('./components/workspaces/ShotsWorkspace').then((m) => ({ default: m.ShotsWorkspace })));
const ExportWorkspace = lazy(() => import('./components/workspaces/ExportWorkspace').then((m) => ({ default: m.ExportWorkspace })));
const PanoViewerWorkspace = lazy(() => import('./components/workspaces/PanoViewerWorkspace').then((m) => ({ default: m.PanoViewerWorkspace })));
const HelpWorkspace = lazy(() => import('./components/workspaces/HelpWorkspace').then((m) => ({ default: m.HelpWorkspace })));
const WorkflowGuidance = lazy(() => import('./components/common/WorkflowGuidance').then((m) => ({ default: m.WorkflowGuidance })));
const ProjectSafetyDialog = lazy(() => import('./components/common/ProjectSafetyDialog').then((m) => ({ default: m.ProjectSafetyDialog })));

const workspaceItems: Array<{ id: Workspace; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'build', label: 'Build', icon: Boxes },
  { id: 'reference', label: 'Reference', icon: Camera },
  { id: 'shots', label: 'Shots', icon: Clapperboard },
  { id: 'export', label: 'Export', icon: Upload },
];

function projectSaveStatusLabel(status: ProjectSaveStatus): string {
  switch (status) {
    case 'saved': return 'Saved locally';
    case 'saving': return 'Saving locally';
    case 'recovered': return 'Recovered locally';
    case 'failed': return 'Local save failed';
    default: return 'Unsaved changes';
  }
}

function hasSeenSplash(): boolean {
  if (typeof window === 'undefined') return true;
  return readMigratedPreference(BRAND.prefs.splashSeen, BRAND.legacyPrefs.splashSeen) === '1';
}

export default function App() {
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [projectSafetyOpen, setProjectSafetyOpen] = useState(false);
  const [splashDone, setSplashDone] = useState(() => hasSeenSplash());
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const appMode = useAppModeStore((state) => state.appMode);
  const setAppMode = useAppModeStore((state) => state.setAppMode);
  const project = useProjectStore((state) => state.project);
  const workspace = useProjectStore((state) => state.workspace);
  const setWorkspace = useProjectStore((state) => state.setWorkspace);
  const updateProjectInfo = useProjectStore((state) => state.updateProjectInfo);
  const requestObjectiveModal = useProjectStore((state) => state.requestObjectiveModal);
  const projectSaveStatus = useProjectSafetyStore((state) => state.status);
  const projectSaveMessage = useProjectSafetyStore((state) => state.message);
  const projectLastSavedAt = useProjectSafetyStore((state) => state.lastSavedAt);
  const criticalProjectWrite = useProjectSafetyStore((state) => state.criticalWrite);
  const agentControlMode = useAgentControlStore((state) => state.controlMode);
  const setAgentControlMode = useAgentControlStore((state) => state.setControlMode);
  useForeSceneAgentApi();

  const {
    fileRef,
    projectImportStatus,
    setProjectImportStatus,
    newProjectConfirmOpen,
    setNewProjectConfirmOpen,
    isCreatingNewProject,
    openProjectPicker,
    importProject,
    saveProject,
    startNewProject,
    createProjectSnapshot,
    restoreProjectSnapshot,
    openLocalProjectHistory,
    removeLocalProjectHistory,
    applyProjectHealthRepair,
    createProjectFromBlueprint,
  } = useProjectLifecycle({
    closeProjectOverlays: () => {
      setHelpOpen(false);
      setProjectSafetyOpen(false);
    },
  });

  const isPanoViewer = appMode === 'panoViewer';
  const isStudioMode = appMode === 'studio';
  const showModeChooser = splashDone && appMode === null && !helpOpen;

  const navigateWorkspace = (nextWorkspace: Workspace) => {
    if (criticalProjectWrite) {
      setProjectImportStatus({
        tone: 'error',
        message: 'Please wait for the current local save to finish before navigating away.',
      });
      return;
    }
    setWorkspace(nextWorkspace);
  };

  useEffect(() => {
    if (!projectMenuOpen) return;

    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (projectMenuRef.current && target && !projectMenuRef.current.contains(target)) {
        setProjectMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectMenuOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelpOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [helpOpen]);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-surface-base text-primary">
      <main className="absolute inset-0">
        <Suspense
          fallback={(
            <div className="flex h-full items-center justify-center bg-surface-base text-sm text-secondary">
              Loading workspace…
            </div>
          )}
        >
          {helpOpen ? (
            <WorkspaceErrorBoundary workspaceName="Help">
              <HelpWorkspace onClose={() => setHelpOpen(false)} />
            </WorkspaceErrorBoundary>
          ) : isPanoViewer ? (
            <WorkspaceErrorBoundary workspaceName="360 Viewer">
              <PanoViewerWorkspace />
            </WorkspaceErrorBoundary>
          ) : isStudioMode ? (
            <>
              {workspace === 'build' && (
                <WorkspaceErrorBoundary workspaceName="Build">
                  <BuildWorkspace onCreateProjectFromBlueprint={createProjectFromBlueprint} />
                </WorkspaceErrorBoundary>
              )}
              {workspace === 'reference' && (
                <WorkspaceErrorBoundary
                  workspaceName="Reference"
                  onReturnHome={() => setWorkspace('build')}
                >
                  <ReferenceWorkspace />
                </WorkspaceErrorBoundary>
              )}
              {workspace === 'shots' && (
                <WorkspaceErrorBoundary
                  workspaceName="Shots"
                  onReturnHome={() => setWorkspace('build')}
                >
                  <ShotsWorkspace />
                </WorkspaceErrorBoundary>
              )}
              {workspace === 'export' && (
                <WorkspaceErrorBoundary
                  workspaceName="Export"
                  onReturnHome={() => setWorkspace('build')}
                >
                  <ExportWorkspace />
                </WorkspaceErrorBoundary>
              )}
            </>
          ) : null}
        </Suspense>
      </main>

      <header className="pointer-events-none absolute inset-x-0 top-0 z-40">
        <div className="flex flex-col gap-1.5 px-3 pt-2 md:h-[72px] md:flex-row md:items-center md:justify-between md:gap-4 md:px-7 md:pt-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div ref={projectMenuRef} className="pointer-events-auto relative min-w-0">
              <button
                type="button"
                onClick={() => setProjectMenuOpen((open) => !open)}
                className="flex min-w-0 max-w-[min(100%,14rem)] items-center gap-1.5 rounded-2xl border border-transparent py-1 pl-1 pr-2 transition hover:border-subtle hover:bg-surface-overlay/70 sm:max-w-none sm:gap-2 sm:pr-2.5"
                title="Open menu"
                aria-label="Open app menu"
                aria-expanded={projectMenuOpen}
                aria-haspopup="menu"
                data-brand-menu-trigger
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center text-accent md:h-11 md:w-11">
                  <Boxes className="h-7 w-7 md:h-9 md:w-9" strokeWidth={2.2} />
                </span>
                <span className="min-w-0 truncate text-base font-semibold tracking-normal text-primary md:text-xl">
                  {helpOpen ? 'Help Center' : isPanoViewer ? '360 Viewer' : BRAND.name}
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-secondary transition ${projectMenuOpen ? 'rotate-180 text-accent' : ''}`}
                  aria-hidden
                />
              </button>
              {projectMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-0 top-[calc(100%+10px)] z-50 w-72 overflow-hidden rounded-[var(--radius-card)] border border-subtle bg-surface-overlay p-2 shadow-soft backdrop-blur"
                >
                  {!isPanoViewer && (
                    <div className="border-b border-subtle px-3 py-2">
                      <label className="block text-xs text-secondary" htmlFor="project-name-input">
                        Project name
                      </label>
                      <TextInput
                        id="project-name-input"
                        value={project.name}
                        onChange={(event) => updateProjectInfo({ name: event.target.value })}
                        aria-label="Project name"
                        data-project-name-input
                        className="mt-1 h-8 border-subtle bg-surface-raised px-2 py-1 text-sm font-semibold"
                      />
                      <div className="mt-2">
                        <ProjectSaveStatusIndicator
                          status={projectSaveStatus}
                          message={projectSaveMessage}
                        />
                      </div>
                      <div className="mt-1 text-xs text-secondary">Project actions</div>
                    </div>
                  )}
                  {isPanoViewer ? (
                    <ProjectMenuButton
                      icon={<Boxes className="h-4 w-4" />}
                      label="Open ForeScene"
                      onClick={() => {
                        setAppMode('studio');
                        setHelpOpen(false);
                        setProjectMenuOpen(false);
                      }}
                    />
                  ) : (
                    <>
                      <ProjectMenuButton
                        icon={<Compass className="h-4 w-4" />}
                        label="Current Objective"
                        onClick={() => {
                          requestObjectiveModal();
                          setHelpOpen(false);
                          setProjectMenuOpen(false);
                        }}
                      />
                      <ProjectMenuButton
                        icon={<Globe className="h-4 w-4" />}
                        label="Simple 360 Viewer"
                        onClick={() => {
                          setAppMode('panoViewer');
                          setHelpOpen(false);
                          setProjectMenuOpen(false);
                        }}
                      />
                      <ProjectMenuButton
                        icon={<FilePlus className="h-4 w-4" />}
                        label="New Project"
                        onClick={() => {
                          setNewProjectConfirmOpen(true);
                          setProjectMenuOpen(false);
                        }}
                        data-project-new-button
                      />
                      <ProjectMenuButton
                        icon={<FolderOpen className="h-4 w-4" />}
                        label="Import Project Backup"
                        onClick={() => {
                          openProjectPicker();
                          setProjectMenuOpen(false);
                        }}
                      />
                      <ProjectMenuButton
                        icon={<ShieldCheck className="h-4 w-4" />}
                        label="Project Safety & Recovery"
                        onClick={() => {
                          setProjectSafetyOpen(true);
                          setProjectMenuOpen(false);
                        }}
                      />
                      {agentControlMode !== 'read-write' ? (
                        <ProjectMenuButton
                          icon={<Terminal className="h-4 w-4" />}
                          label="Enable Agent Writes"
                          onClick={() => {
                            setAgentControlMode('read-write');
                            setProjectMenuOpen(false);
                          }}
                          data-agent-control-enable
                        />
                      ) : (
                        <ProjectMenuButton
                          icon={<Terminal className="h-4 w-4" />}
                          label="Disable Agent Writes"
                          onClick={() => {
                            setAgentControlMode('read-only');
                            setProjectMenuOpen(false);
                          }}
                          data-agent-control-disable
                        />
                      )}
                      <ProjectMenuButton
                        icon={<FileJson className="h-4 w-4" />}
                        label="Export Project Backup"
                        onClick={() => {
                          saveProject();
                          setProjectMenuOpen(false);
                        }}
                      />
                      <ProjectMenuButton
                        icon={<Package className="h-4 w-4" />}
                        label="Package Export"
                        onClick={() => {
                          navigateWorkspace('export');
                          setHelpOpen(false);
                          setProjectMenuOpen(false);
                        }}
                      />
                    </>
                  )}
                  <div className="my-1 border-t border-subtle" />
                  <ProjectMenuButton
                    icon={<BookOpen className="h-4 w-4" />}
                    label="Help & Documentation"
                    onClick={() => {
                      setHelpOpen(true);
                      setProjectMenuOpen(false);
                    }}
                  />
                </div>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept={projectBackupAcceptAttribute()}
              aria-label="Open project backup"
              data-project-import-input
              className="hidden"
              onChange={(event) => void importProject(event.target.files?.[0])}
            />
            <div
              className="pointer-events-auto flex shrink-0 items-center overflow-hidden rounded-2xl border border-subtle/80 bg-surface-overlay/80 shadow-card backdrop-blur-sm md:absolute md:right-7 md:top-3"
              data-header-actions
            >
              {agentControlMode === 'read-write' && (
                <div
                  className="flex h-11 items-center gap-2 border-r border-subtle/70 px-2"
                  data-agent-control-badge="active"
                  role="status"
                >
                  <span className="hidden text-xs font-medium text-amber-700 dark:text-amber-300 sm:inline">
                    Agent control active
                  </span>
                  <button
                    type="button"
                    className="rounded-lg border border-subtle/80 px-2 py-1 text-xs font-medium text-primary hover:border-strong"
                    data-agent-control-stop
                    onClick={() => setAgentControlMode('read-only')}
                    title="Disable agent write access"
                  >
                    Stop
                  </button>
                </div>
              )}
              {!isPanoViewer && !helpOpen && (
                <>
                  <div
                    className="hidden h-11 items-center border-r border-subtle/70 px-2 md:flex"
                    title={projectSaveMessage ?? projectSaveStatusLabel(projectSaveStatus)}
                    data-project-save-status={projectSaveStatus}
                  >
                    <ProjectSaveStatusIndicator status={projectSaveStatus} compact />
                  </div>
                  <HeaderToolbarButton onClick={openProjectPicker} title="Import project backup">
                    <FolderOpen className="h-4 w-4" />
                  </HeaderToolbarButton>
                  <span className="h-4 w-px shrink-0 self-center bg-border-subtle/70" aria-hidden />
                  <HeaderToolbarButton
                    onClick={saveProject}
                    title="Export verified project backup"
                    data-project-export-button
                  >
                    <Save className="h-4 w-4" />
                  </HeaderToolbarButton>
                  <span className="h-4 w-px shrink-0 self-center bg-border-subtle/70" aria-hidden />
                </>
              )}
              <HeaderToolbarButton
                onClick={toggleTheme}
                title={theme === 'light' ? 'Dark mode' : 'Light mode'}
              >
                {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              </HeaderToolbarButton>
            </div>
          </div>

          {isStudioMode && !helpOpen && (
            <>
              <nav className="pointer-events-auto absolute left-1/2 top-5 hidden w-[min(700px,56vw)] -translate-x-1/2 items-start justify-between md:flex">
                <span className="absolute left-8 right-8 top-[22px] h-px bg-border-subtle/80" aria-hidden />
                {workspaceItems.map((item) => {
                  const Icon = item.icon;
                  const active = workspace === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => navigateWorkspace(item.id)}
                      className="group relative z-10 flex min-w-20 flex-col items-center gap-1.5"
                      aria-current={active ? 'page' : undefined}
                    >
                      <span
                        className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent)] text-white shadow-[0_0_22px_var(--accent-glow)]'
                            : 'border-subtle/80 bg-surface-overlay/75 text-secondary backdrop-blur-sm group-hover:border-strong group-hover:text-primary'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className={`text-[11px] font-medium ${active ? 'text-accent' : 'text-secondary'}`}>
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </nav>

              <nav
                className="pointer-events-auto flex w-full items-center gap-1 overflow-x-auto pb-0.5 md:hidden"
                aria-label="Workspace stages"
              >
                {workspaceItems.map((item) => {
                  const Icon = item.icon;
                  const active = workspace === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => navigateWorkspace(item.id)}
                      className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium transition ${
                        active ? 'bg-[var(--accent)] text-white' : 'bg-surface-overlay/80 text-secondary backdrop-blur-sm'
                      }`}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {item.label}
                    </button>
                  );
                })}
              </nav>
            </>
          )}
        </div>
      </header>

      {projectImportStatus && (
        <div
          className={`pointer-events-none absolute right-7 top-20 z-50 max-w-sm rounded-[var(--radius-card)] border px-3 py-2 text-sm shadow-card backdrop-blur ${
            projectImportStatus.tone === 'success'
              ? 'border-[var(--accent)] bg-surface-overlay text-primary'
              : 'border-red-400/70 bg-surface-overlay text-primary'
          }`}
          role={projectImportStatus.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          data-project-import-status={projectImportStatus.tone}
        >
          {projectImportStatus.message}
        </div>
      )}

      {projectSafetyOpen && (
        <Suspense fallback={null}>
          <ProjectSafetyDialog
            open={projectSafetyOpen}
            project={project}
            lastSavedAt={projectLastSavedAt}
            onClose={() => setProjectSafetyOpen(false)}
            onCreateSnapshot={createProjectSnapshot}
            onRestoreRevision={restoreProjectSnapshot}
            onOpenProjectHistory={openLocalProjectHistory}
            onRemoveProjectHistory={removeLocalProjectHistory}
            onApplyRepair={applyProjectHealthRepair}
            onExportBackup={saveProject}
          />
        </Suspense>
      )}

      <ConfirmDialog
        open={newProjectConfirmOpen}
        title="Start a new project?"
        confirmLabel={isCreatingNewProject ? 'Starting…' : 'Start new project'}
        destructive
        onCancel={() => {
          if (!isCreatingNewProject) setNewProjectConfirmOpen(false);
        }}
        onConfirm={() => {
          if (!isCreatingNewProject) void startNewProject();
        }}
      >
        <span data-project-new-confirm>
          This replaces the project currently open in ForeScene with a blank scene.
          Your current work stays available under Project Safety &amp; Recovery
          {project.name ? ` as “${project.name}”` : ''}.
          Export a backup first if you want an offline copy.
        </span>
      </ConfirmDialog>

      {isStudioMode && !helpOpen && (
        <Suspense fallback={null}>
          <WorkflowGuidance />
        </Suspense>
      )}

      <ModeChooser visible={showModeChooser} />
  <SplashScreen onDismissed={() => setSplashDone(true)} />
    </div>
  );
}

function ProjectSaveStatusIndicator({
  status,
  message,
  compact = false,
}: {
  status: ProjectSaveStatus;
  message?: string;
  compact?: boolean;
}) {
  const label = projectSaveStatusLabel(status);
  const Icon = status === 'saved'
    ? CloudCheck
    : status === 'saving'
      ? Save
      : status === 'recovered'
        ? RotateCcw
        : status === 'failed'
          ? CloudOff
          : AlertTriangle;
  const tone = status === 'saved'
    ? 'text-emerald-600 dark:text-emerald-400'
    : status === 'saving'
      ? 'text-accent'
      : status === 'recovered'
        ? 'text-sky-600 dark:text-sky-400'
        : status === 'failed'
          ? 'text-red-600 dark:text-red-400'
          : 'text-amber-600 dark:text-amber-400';
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 text-xs font-medium ${tone}`}
      role={status === 'failed' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${status === 'saving' ? 'animate-pulse' : ''}`} aria-hidden />
      <span className={compact ? 'hidden lg:inline' : 'truncate'}>{label}</span>
      {!compact && message && message !== label && (
        <span className="truncate font-normal text-secondary">— {message}</span>
      )}
    </span>
  );
}

function ProjectMenuButton({
  icon,
  label,
  onClick,
  ...rest
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="menuitem"
      {...rest}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-secondary transition hover:bg-surface-muted hover:text-primary"
    >
      <span className="text-accent">{icon}</span>
      {label}
    </button>
  );
}

function HeaderToolbarButton({
  children,
  title,
  onClick,
  className,
  ...rest
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      onClick={onClick}
      title={title}
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center border-0 bg-transparent text-secondary shadow-none outline-none transition hover:bg-surface-muted/80 hover:text-primary focus-visible:bg-surface-muted/80 focus-visible:text-primary ${className ?? ''}`}
    >
      {children}
    </button>
  );
}
