import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import {
  Boxes,
  BookOpen,
  Camera,
  ChevronDown,
  Clapperboard,
  Compass,
  FileJson,
  FolderOpen,
  Globe,
  Moon,
  Package,
  Save,
  Sun,
  Upload,
} from 'lucide-react';
import { Workspace } from './domain/types';
import { useAppModeStore } from './state/useAppModeStore';
import { useContinuityStore } from './state/useContinuityStore';
import { useThemeStore } from './state/useThemeStore';
import { ModeChooser } from './components/common/ModeChooser';
import SplashScreen from './components/common/SplashScreen';
import { TextInput } from './components/common/Field';

const BuildWorkspace = lazy(() => import('./components/workspaces/BuildWorkspace').then((m) => ({ default: m.BuildWorkspace })));
const ReferenceWorkspace = lazy(() => import('./components/workspaces/ReferenceWorkspace').then((m) => ({ default: m.ReferenceWorkspace })));
const ShotsWorkspace = lazy(() => import('./components/workspaces/ShotsWorkspace').then((m) => ({ default: m.ShotsWorkspace })));
const ExportWorkspace = lazy(() => import('./components/workspaces/ExportWorkspace').then((m) => ({ default: m.ExportWorkspace })));
const PanoViewerWorkspace = lazy(() => import('./components/workspaces/PanoViewerWorkspace').then((m) => ({ default: m.PanoViewerWorkspace })));
const HelpWorkspace = lazy(() => import('./components/workspaces/HelpWorkspace').then((m) => ({ default: m.HelpWorkspace })));
const WorkflowGuidance = lazy(() => import('./components/common/WorkflowGuidance').then((m) => ({ default: m.WorkflowGuidance })));

let projectIoPromise: Promise<typeof import('./engine/projectIO')> | undefined;

function loadProjectIo() {
  projectIoPromise ??= import('./engine/projectIO');
  return projectIoPromise;
}

const workspaceItems: Array<{ id: Workspace; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'build', label: 'Build', icon: Boxes },
  { id: 'reference', label: 'Reference', icon: Camera },
  { id: 'shots', label: 'Shots', icon: Clapperboard },
  { id: 'export', label: 'Export', icon: Upload },
];

const IMPORT_STATUS_DISMISS_MS = 4000;
const SPLASH_SEEN_KEY = 'panoref-splash-seen';

function hasSeenSplash(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SPLASH_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

export default function App() {
  const fileRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [splashDone, setSplashDone] = useState(() => hasSeenSplash());
  const [projectImportStatus, setProjectImportStatus] = useState<{
    tone: 'success' | 'error';
    message: string;
  }>();
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const appMode = useAppModeStore((state) => state.appMode);
  const setAppMode = useAppModeStore((state) => state.setAppMode);
  const project = useContinuityStore((state) => state.project);
  const workspace = useContinuityStore((state) => state.workspace);
  const setWorkspace = useContinuityStore((state) => state.setWorkspace);
  const setProject = useContinuityStore((state) => state.setProject);
  const updateProjectInfo = useContinuityStore((state) => state.updateProjectInfo);
  const requestObjectiveModal = useContinuityStore((state) => state.requestObjectiveModal);

  const isPanoViewer = appMode === 'panoViewer';
  const isContinuityStage = appMode === 'continuity';
  const showModeChooser = splashDone && appMode === null && !helpOpen;

  const openProjectPicker = () => {
    setProjectImportStatus(undefined);
    void loadProjectIo();
    fileRef.current?.click();
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const { readProjectFile } = await loadProjectIo();
      const importedProject = await readProjectFile(file);
      setProject(importedProject);
      setAppMode('continuity');
      setProjectImportStatus({
        tone: 'success',
        message: `Project opened: ${importedProject.name}`,
      });
    } catch (error) {
      setProjectImportStatus({
        tone: 'error',
        message: error instanceof Error
          ? `Could not open project: ${error.message}`
          : 'Could not open project: invalid project file.',
      });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const saveProject = () => {
    void loadProjectIo()
      .then(({ downloadProject }) => downloadProject(project))
      .catch((error) => {
        setProjectImportStatus({
          tone: 'error',
          message: error instanceof Error ? `Could not save project: ${error.message}` : 'Could not save project.',
        });
      });
  };

  useEffect(() => {
    if (!projectImportStatus) return;
    const timer = window.setTimeout(() => setProjectImportStatus(undefined), IMPORT_STATUS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [projectImportStatus]);

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
            <HelpWorkspace onClose={() => setHelpOpen(false)} />
          ) : isPanoViewer ? (
            <PanoViewerWorkspace />
          ) : isContinuityStage ? (
            <>
              {workspace === 'build' && <BuildWorkspace />}
              {workspace === 'reference' && <ReferenceWorkspace />}
              {workspace === 'shots' && <ShotsWorkspace />}
              {workspace === 'export' && <ExportWorkspace />}
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
                  {helpOpen ? 'Help Center' : isPanoViewer ? '360 Viewer' : 'Continuity Stage'}
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
                      <div className="mt-1 text-xs text-secondary">Project actions</div>
                    </div>
                  )}
                  {isPanoViewer ? (
                    <ProjectMenuButton
                      icon={<Boxes className="h-4 w-4" />}
                      label="Open Continuity Stage"
                      onClick={() => {
                        setAppMode('continuity');
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
                        icon={<FolderOpen className="h-4 w-4" />}
                        label="Open Project"
                        onClick={() => {
                          openProjectPicker();
                          setProjectMenuOpen(false);
                        }}
                      />
                      <ProjectMenuButton
                        icon={<FileJson className="h-4 w-4" />}
                        label="Save Project"
                        onClick={() => {
                          saveProject();
                          setProjectMenuOpen(false);
                        }}
                      />
                      <ProjectMenuButton
                        icon={<Package className="h-4 w-4" />}
                        label="Package Export"
                        onClick={() => {
                          setWorkspace('export');
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
              accept=".json,.zip,.panoref-project,application/json,application/zip"
              aria-label="Open project JSON"
              data-project-import-input
              className="hidden"
              onChange={(event) => void importProject(event.target.files?.[0])}
            />
            <div
              className="pointer-events-auto flex shrink-0 items-center overflow-hidden rounded-2xl border border-subtle/80 bg-surface-overlay/80 shadow-card backdrop-blur-sm md:absolute md:right-7 md:top-3"
              data-header-actions
            >
              {!isPanoViewer && !helpOpen && (
                <>
                  <HeaderToolbarButton onClick={openProjectPicker} title="Open project">
                    <FolderOpen className="h-4 w-4" />
                  </HeaderToolbarButton>
                  <span className="h-4 w-px shrink-0 self-center bg-border-subtle/70" aria-hidden />
                  <HeaderToolbarButton
                    onClick={saveProject}
                    title="Save project"
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

          {isContinuityStage && !helpOpen && (
            <>
              <nav className="pointer-events-auto absolute left-1/2 top-5 hidden w-[min(700px,56vw)] -translate-x-1/2 items-start justify-between md:flex">
                <span className="absolute left-8 right-8 top-[22px] h-px bg-border-subtle/80" aria-hidden />
                {workspaceItems.map((item) => {
                  const Icon = item.icon;
                  const active = workspace === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setWorkspace(item.id)}
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
                      onClick={() => setWorkspace(item.id)}
                      className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium transition ${
                        active ? 'bg-[var(--accent)] text-white' : 'bg-surface-overlay/80 text-secondary backdrop-blur-sm'
                      }`}
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

      {isContinuityStage && !helpOpen && (
        <Suspense fallback={null}>
          <WorkflowGuidance />
        </Suspense>
      )}

      <ModeChooser visible={showModeChooser} />
      <SplashScreen onDismissed={() => setSplashDone(true)} />
    </div>
  );
}

function ProjectMenuButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
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
