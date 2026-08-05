import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { Archive, Check, Download, FolderArchive, Settings, X } from 'lucide-react';
import { getShotPrimaryLabel } from '../../domain/shotIdentity';
import { getShotExportProgressLabel } from '../../engine/exportNaming';
import { createShotPackageManifest, selectExportPathPreview } from '../../engine/exportManifest';
import { reconcileExportSelectedShotIds } from '../../engine/exportSelection';
import {
  buildMultiShotPackage,
  buildShotPackage,
  downloadBlob,
  isPackageExportCancelled,
  PackageExportProgress,
} from '../../engine/packageExport';
import { countExportOverrideLeaves } from '../../engine/exportConfiguration';
import { countProducedArtifacts, createExportPlan, formatPlanBlockingErrors, planHasBlockingErrors } from '../../engine/exportPlan';
import { getExportSelectionWarnings, getShotWarnings } from '../../engine/warnings';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { PrecisionDrawer } from '../common/PrecisionDrawer';
import { PrimaryCTA } from '../common/PrimaryCTA';
import { ShotThumbnail } from '../common/ShotThumbnail';
import { WarningDetailsButton } from '../common/WarningDetailsButton';
import { WarningList } from '../common/WarningList';
import { ExportSettingsPanel } from '../export/ExportSettingsPanel';
import { resolveWorkspacePrimaryAction } from '../../engine/workflow';
import { FullBleedLayout } from './WorkspaceShell';

type ExportUiPhase = 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';

export function ExportWorkspace() {
  const {
    project,
    selectedShotId,
    selectShot,
    addCamera,
    updateShot,
    patchSceneExportDefaults,
    resetShotExportField,
    resetShotExportOverrides,
    copyShotExportOverrides,
    promoteShotExportToSceneDefaults,
    setProjectPackageFormat,
    isExportingPackage,
    setExportingPackage,
    markFinalPackageExported,
  } = useProjectStore(useShallow((state) => ({
    project: state.project,
    selectedShotId: state.selectedShotId,
    selectShot: state.selectShot,
    addCamera: state.addCamera,
    updateShot: state.updateShot,
    patchSceneExportDefaults: state.patchSceneExportDefaults,
    resetShotExportField: state.resetShotExportField,
    resetShotExportOverrides: state.resetShotExportOverrides,
    copyShotExportOverrides: state.copyShotExportOverrides,
    promoteShotExportToSceneDefaults: state.promoteShotExportToSceneDefaults,
    setProjectPackageFormat: state.setProjectPackageFormat,
    isExportingPackage: state.isExportingPackage,
    setExportingPackage: state.setExportingPackage,
    markFinalPackageExported: state.markFinalPackageExported,
  })));
  const flushProject = useProjectSafetyStore((state) => state.flushProject);
  const [lastExport, setLastExport] = useState<string[]>([]);
  const [selectedShotIds, setSelectedShotIds] = useState<Set<string>>(() => new Set(project.shots.map((shot) => shot.id)));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportingShotId, setExportingShotId] = useState<string | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();
  const [exportProgress, setExportProgress] = useState<PackageExportProgress | undefined>();
  const [exportUiPhase, setExportUiPhase] = useState<ExportUiPhase>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const projectIdRef = useRef(project.id);
  const prevShotIdsRef = useRef(project.shots.map((shot) => shot.id));
  const shotIdsKey = project.shots.map((shot) => shot.id).join('\0');
  const selectedShot = project.shots.find((shot) => shot.id === selectedShotId) ?? project.shots[0];
  const manifest = useMemo(() => selectedShot ? createShotPackageManifest(project, selectedShot) : undefined, [project, selectedShot]);
  const selectedShots = useMemo(
    () => project.shots.filter((shot) => selectedShotIds.has(shot.id)),
    [project.shots, selectedShotIds],
  );
  const selectionWarnings = useMemo(
    () => getExportSelectionWarnings(project, selectedShots),
    [project, selectedShots],
  );
  const exportPlan = useMemo(
    () => createExportPlan(project, selectedShots),
    [project, selectedShots],
  );
  const blockingIssues = useMemo(
    () => exportPlan.issues.filter((issue) => issue.severity === 'error'),
    [exportPlan],
  );
  const exportBlocked = planHasBlockingErrors(exportPlan);
  const primaryAction = useMemo(
    () => resolveWorkspacePrimaryAction({
      project,
      workspace: 'export',
      selectedShotId: selectedShot?.id,
      shotCameraFlying: false,
    }),
    [project, selectedShot?.id],
  );

  // Abort in-flight packaging if Export unmounts (e.g. confirmed leave during export).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // Keep multi-select in sync when opening another project or adding/removing shots.
  useEffect(() => {
    const nextIds = project.shots.map((shot) => shot.id);
    const projectChanged = projectIdRef.current !== project.id;
    const previousShotIds = prevShotIdsRef.current;
    projectIdRef.current = project.id;
    prevShotIdsRef.current = nextIds;

    setSelectedShotIds((current) => reconcileExportSelectedShotIds({
      projectChanged,
      previousShotIds,
      nextShotIds: nextIds,
      currentSelected: current,
    }));
  }, [project.id, shotIdsKey]);

  useEffect(() => {
    if (!isExportingPackage) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isExportingPackage]);

  const toggleShotSelection = (shotId: string) => {
    setSelectedShotIds((current) => {
      const next = new Set(current);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });
  };

  const handlePackageProgress = (progress: PackageExportProgress) => {
    if (!mountedRef.current) return;
    setExportProgress(progress);
    if (progress.shotId) {
      setExportingShotId(progress.shotId);
    }
  };

  const beginExport = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setExportingPackage(true);
    setExportError(undefined);
    setExportProgress(undefined);
    setExportUiPhase('running');
    return controller;
  };

  const finishExport = (phase: Exclude<ExportUiPhase, 'idle' | 'running'>, errorMessage?: string) => {
    // Always clear the store flag so navigation/busy state recovers even after unmount.
    setExportingPackage(false);
    abortRef.current = null;
    if (!mountedRef.current) return;
    setExportingShotId(undefined);
    setExportUiPhase(phase);
    if (errorMessage) setExportError(errorMessage);
  };

  const cancelExport = () => {
    abortRef.current?.abort();
    setExportProgress((current) => (
      current
        ? { ...current, message: 'Cancelling export…', indeterminate: true }
        : current
    ));
  };

  const dismissProgressPanel = () => {
    if (exportUiPhase === 'running') return;
    setExportUiPhase('idle');
    setExportProgress(undefined);
  };

  const exportSelectedShots = async () => {
    let controller: AbortController | undefined;
    try {
      if (!flushProject) throw new Error('Local project recovery is still starting. Please wait before exporting a package.');
      const verified = await flushProject('Verified save before package export');
      if (!verified) throw new Error('No verified project revision is available for package export.');
      const exportProject = verified.project;
      const shotsToExport = exportProject.shots.filter((shot) => selectedShotIds.has(shot.id));
      if (shotsToExport.length === 0) return;
      const verifiedPlan = createExportPlan(
        exportProject,
        shotsToExport,
        { packageType: shotsToExport.length === 1 ? 'current-shot' : 'selected-shots' },
      );
      if (planHasBlockingErrors(verifiedPlan)) {
        const firstShotId = verifiedPlan.issues.find((issue) => issue.severity === 'error' && issue.shotId)?.shotId;
        if (firstShotId) selectShot(firstShotId);
        setExportUiPhase('failed');
        setExportError(formatPlanBlockingErrors(verifiedPlan) || 'Export blocked by preflight errors.');
        return;
      }
      controller = beginExport();
      setExportingShotId(shotsToExport[0]?.id);
      // One download for N shots — avoids browser multi-download blocking.
      const result = await buildMultiShotPackage(exportProject, shotsToExport, {
        signal: controller.signal,
        onProgress: handlePackageProgress,
        plan: verifiedPlan,
      });
      downloadBlob(result.blob, result.fileName);
      setLastExport(result.manifestPaths);
      for (const shot of shotsToExport) {
        updateShot(shot.id, { status: 'exported' });
        markFinalPackageExported(shot.id);
      }
      if (mountedRef.current) {
        setExportProgress((current) => (
          current
            ? { ...current, phase: 'complete', progress: 1, message: 'Package downloaded', indeterminate: false }
            : {
                phase: 'complete',
                progress: 1,
                currentShot: shotsToExport.length,
                totalShots: shotsToExport.length,
                message: 'Package downloaded',
              }
        ));
      }
      finishExport('complete');
    } catch (error) {
      if (isPackageExportCancelled(error) || controller?.signal.aborted) {
        finishExport('cancelled');
        if (mountedRef.current) {
          setExportProgress((current) => (
            current
              ? { ...current, message: 'Export cancelled', indeterminate: false }
              : current
          ));
        }
        return;
      }
      if (controller) finishExport('failed', error instanceof Error ? error.message : 'Export failed.');
      else {
        setExportUiPhase('failed');
        setExportError(error instanceof Error ? error.message : 'Export failed.');
      }
    }
  };

  const exportShot = async () => {
    let controller: AbortController | undefined;
    try {
      if (!flushProject) throw new Error('Local project recovery is still starting. Please wait before exporting a package.');
      const verified = await flushProject('Verified save before package export');
      if (!verified) throw new Error('No verified project revision is available for package export.');
      const exportProject = verified.project;
      const shotToExport = exportProject.shots.find((shot) => shot.id === selectedShot?.id);
      if (!shotToExport) return;
      const verifiedPlan = createExportPlan(exportProject, [shotToExport], { packageType: 'current-shot' });
      if (planHasBlockingErrors(verifiedPlan)) {
        selectShot(shotToExport.id);
        setExportUiPhase('failed');
        setExportError(formatPlanBlockingErrors(verifiedPlan) || 'Export blocked by preflight errors.');
        return;
      }
      controller = beginExport();
      setExportingShotId(shotToExport.id);
      const result = await buildShotPackage(exportProject, shotToExport, {
        signal: controller.signal,
        onProgress: handlePackageProgress,
        plan: verifiedPlan,
      });
      downloadBlob(result.blob, result.fileName);
      setLastExport(result.manifestPaths);
      updateShot(shotToExport.id, { status: 'exported' });
      markFinalPackageExported(shotToExport.id);
      if (mountedRef.current) {
        setExportProgress((current) => (
          current
            ? { ...current, phase: 'complete', progress: 1, message: 'Package downloaded', indeterminate: false }
            : {
                phase: 'complete',
                progress: 1,
                currentShot: 1,
                totalShots: 1,
                shotId: shotToExport.id,
                shotName: getShotExportProgressLabel(shotToExport),
                message: 'Package downloaded',
              }
        ));
      }
      finishExport('complete');
    } catch (error) {
      if (isPackageExportCancelled(error) || controller?.signal.aborted) {
        finishExport('cancelled');
        if (mountedRef.current) {
          setExportProgress((current) => (
            current
              ? { ...current, message: 'Export cancelled', indeterminate: false }
              : current
          ));
        }
        return;
      }
      if (controller) finishExport('failed', error instanceof Error ? error.message : 'Export failed.');
      else {
        setExportUiPhase('failed');
        setExportError(error instanceof Error ? error.message : 'Export failed.');
      }
    }
  };

  const packageContents = [
    { name: 'inputs', description: 'Reference and camera data' },
    { name: 'outputs', description: 'Final frames and media' },
    { name: 'metadata', description: 'Shot and scene info' },
    { name: 'prompts', description: 'AI prompts and notes' },
    { name: 'manifest.json', description: 'Package manifest' },
  ];

  const fitsCompactShotList = (
    project.shots.length > 0
    && project.shots.length <= 6
    && selectionWarnings.length === 0
  );
  const manifestPreviewPaths = useMemo(
    () => (manifest ? selectExportPathPreview(manifest.files.map((file) => file.path), 3) : []),
    [manifest],
  );
  const lastExportPreviewPaths = useMemo(
    () => selectExportPathPreview(lastExport, 3),
    [lastExport],
  );
  const showProgressPanel = exportUiPhase !== 'idle';

  return (
    <FullBleedLayout reserveHeader>
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface-base p-4">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <div
            data-export-package-panel="composed"
            className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-subtle bg-surface-raised p-4 shadow-card"
          >
            <header data-export-package-header className="mb-3 shrink-0">
              <h1 className="text-xl font-semibold text-primary">Export Your Shots</h1>
              <p className="mt-0.5 text-sm text-secondary">
                Handoff packages for your AI and pipeline tools. One ZIP with a folder per selected shot — deliverables stay outside this app.
              </p>
            </header>

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2">
              <div
                data-export-package-visual
                className="flex shrink-0 items-start justify-center gap-3"
              >
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <div className="flex h-16 w-20 items-center justify-center rounded-2xl bg-[var(--accent)] text-white shadow-[var(--cta-glow)]">
                    <FolderArchive className="h-8 w-8" />
                  </div>
                  <div className="rounded-md bg-surface-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-secondary">
                    ZIP Package
                  </div>
                </div>
                <div className="w-44 max-w-[11rem] shrink-0 rounded-lg border border-subtle bg-surface-muted p-2 shadow-card">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-secondary">
                    Package Contents
                  </div>
                  <ul className="space-y-0.5">
                    {packageContents.map((item) => (
                      <li key={item.name} className="flex items-center gap-1.5 rounded-md border border-subtle bg-surface-raised px-1.5 py-0.5">
                        <Archive className="h-3 w-3 shrink-0 text-accent" />
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[10px] font-medium text-primary">{item.name}</div>
                          <div className="truncate text-[9px] text-secondary">{item.description}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            <div className="mt-3 shrink-0 space-y-2">
              {selectedShots.length > 0 && (
                <div
                  data-export-plan-summary
                  className="rounded-lg border border-subtle bg-surface-muted/50 px-3 py-2 text-[11px] text-secondary"
                >
                  <div className="font-semibold text-primary">
                    {exportPlan.summary.shotCount} shot{exportPlan.summary.shotCount === 1 ? '' : 's'} selected
                  </div>
                  <ul className="mt-1 space-y-0.5 text-muted">
                    <li>
                      {countProducedArtifacts(exportPlan, 'clay-viewport')} clay ·{' '}
                      {countProducedArtifacts(exportPlan, 'projected-viewport')} projected ·{' '}
                      {countProducedArtifacts(exportPlan, 'depth-viewport')} depth stills
                    </li>
                    <li>
                      Estimated output · {exportPlan.estimatedFileCount} files
                      {exportPlan.summary.overrideShotCount > 0
                        ? ` · ${exportPlan.summary.overrideShotCount} with shot overrides`
                        : ''}
                    </li>
                    {exportPlan.sharedArtifacts.length > 0 && (
                      <li data-export-plan-shared-artifacts>
                        Shared references prepared once ·{' '}
                        {[
                          exportPlan.sharedArtifacts.some((a) => a.kind === 'global-reference') && 'canonical',
                          exportPlan.sharedArtifacts.some((a) => a.kind === 'cubemap') && 'cubemap',
                          exportPlan.sharedArtifacts.some((a) => a.kind === 'global-graybox') && 'graybox',
                        ].filter(Boolean).join(' · ')}
                        {' '}({exportPlan.sharedArtifacts.length} unique)
                      </li>
                    )}
                    {exportPlan.summary.warningCount > 0 && (
                      <li className="text-amber-700 dark:text-amber-300">
                        {exportPlan.summary.warningCount} preflight warning
                        {exportPlan.summary.warningCount === 1 ? '' : 's'}
                      </li>
                    )}
                    {exportPlan.summary.errorCount > 0 && (
                      <li className="text-red-600 dark:text-red-300">
                        {exportPlan.summary.errorCount} blocking error
                        {exportPlan.summary.errorCount === 1 ? '' : 's'}
                      </li>
                    )}
                  </ul>
                  {blockingIssues.length > 0 && (
                    <ul data-export-plan-blocking-errors className="mt-2 space-y-1 border-t border-subtle pt-2">
                      {blockingIssues.map((issue) => {
                        const shot = issue.shotId
                          ? project.shots.find((entry) => entry.id === issue.shotId)
                          : undefined;
                        return (
                          <li key={issue.id} className="text-red-600 dark:text-red-300">
                            <span>{issue.message}</span>
                            {shot && (
                              <>
                                {' '}
                                <button
                                  type="button"
                                  className="font-medium underline underline-offset-2 hover:text-red-500"
                                  onClick={() => selectShot(shot.id)}
                                >
                                  {getShotPrimaryLabel(shot)}
                                </button>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
              {manifest && (
                <div data-export-manifest-preview className="max-h-8 space-y-0.5 overflow-hidden opacity-70">
                  <div className="text-[10px] font-medium text-secondary">
                    Active shot manifest sample
                  </div>
                  {manifestPreviewPaths.map((path) => (
                    <div key={path} className="truncate font-mono text-[10px] text-muted">{path}</div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                data-export-settings-trigger
                disabled={isExportingPackage}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-secondary transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Settings className="h-3.5 w-3.5" />
                Export Settings
              </button>
              {lastExport.length > 0 && (
                <div data-export-last-export className="max-h-8 space-y-0.5 overflow-hidden opacity-80">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-primary">
                    <Check className="h-3 w-3 text-emerald-500" />
                    Last Export
                  </div>
                  {lastExportPreviewPaths.map((path) => (
                    <div key={path} className="truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-400">{path}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-subtle bg-surface-raised shadow-card">
            <div className="shrink-0 border-b border-subtle px-3 py-2">
              <h2 className="text-sm font-semibold text-primary">Select Shots to Export</h2>
              <p className="text-[11px] text-secondary">{selectedShotIds.size} shot{selectedShotIds.size === 1 ? '' : 's'} selected</p>
            </div>

            {selectionWarnings.length > 0 && (
              <div
                data-export-project-readiness
                className="shrink-0 space-y-1.5 border-b border-subtle px-3 py-2"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-secondary">
                  Package readiness
                </div>
                <WarningList warnings={selectionWarnings} />
              </div>
            )}

            <div
              className={`min-h-0 flex-1 space-y-1 p-2 ${
                fitsCompactShotList ? 'overflow-hidden' : 'overflow-y-auto'
              }`}
            >
              {project.shots.map((shot) => {
                const shotWarnings = getShotWarnings(project, shot);
                const checked = selectedShotIds.has(shot.id);
                const active = selectedShotId === shot.id;
                const overrideCount = countExportOverrideLeaves(shot.exportOverrides);
                return (
                  <div
                    key={shot.id}
                    data-export-shot-row={checked ? 'selected' : 'default'}
                    className={`flex min-h-11 items-center gap-2 rounded-lg border px-2 py-1.5 transition ${
                      checked
                        ? 'border-[var(--accent)] bg-surface-raised shadow-[inset_3px_0_0_var(--accent)]'
                        : 'border-subtle bg-surface-raised hover:border-strong'
                    } ${active ? 'ring-1 ring-[var(--accent)]' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleShotSelection(shot.id)}
                      disabled={isExportingPackage}
                      className="h-5 w-5 accent-[var(--accent)]"
                      aria-label={`Export ${getShotPrimaryLabel(shot)}`}
                    />
                    <button
                      type="button"
                      onClick={() => selectShot(shot.id)}
                      disabled={isExportingPackage}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-70"
                    >
                      <ShotThumbnail project={project} shot={shot} compact className="h-9 w-16 shrink-0" />
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block text-xs font-medium text-primary">{getShotPrimaryLabel(shot)}</span>
                        <span className="block truncate text-[11px] text-secondary">{shot.name}</span>
                        <span
                          data-export-shot-override-badge={overrideCount > 0 ? 'override' : 'inherited'}
                          className="mt-0.5 block text-[10px] text-muted"
                        >
                          {overrideCount > 0
                            ? `${overrideCount} shot override${overrideCount === 1 ? '' : 's'}`
                            : 'Using scene settings'}
                        </span>
                      </span>
                    </button>
                    {shotWarnings.length > 0 ? (
                      <WarningDetailsButton
                        warnings={shotWarnings}
                        title={getShotPrimaryLabel(shot)}
                      />
                    ) : (
                      <span className="shrink-0 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                        Ready
                      </span>
                    )}
                    {exportingShotId === shot.id && exportUiPhase === 'running' && (
                      <span className="shrink-0 text-[10px] text-accent">Exporting…</span>
                    )}
                  </div>
                );
              })}
              {project.shots.length === 0 && (
                <p className="text-sm text-secondary">No shots yet.</p>
              )}
            </div>
            <div className="shrink-0 border-t border-subtle space-y-2 px-2 py-2">
              {exportError && exportUiPhase === 'failed' && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-400/60 bg-red-500/10 px-3 py-2 text-xs text-primary"
                  data-export-error
                >
                  {exportError}
                </p>
              )}
              <PrimaryCTA
                icon={<Download className="h-4 w-4" />}
                label={isExportingPackage
                  ? 'Building Package...'
                  : selectedShotIds.size > 1
                    ? `Export ${selectedShotIds.size} Shots (1 ZIP)`
                    : 'Export Selected Shots'}
                hint={selectedShotIds.size > 1
                  ? 'One ZIP with a folder per shot — no multi-download blocking.'
                  : 'Download a continuity ZIP handoff package. No need to import results back.'}
                onClick={() => void exportSelectedShots()}
                disabled={isExportingPackage || selectedShotIds.size === 0 || exportBlocked}
                highlighted={primaryAction?.id === 'export-final-zip'}
                layout="inline"
              />
            </div>
          </div>
        </div>

        {showProgressPanel && (
          <ExportProgressPanel
            progress={exportProgress}
            phase={exportUiPhase}
            onCancel={cancelExport}
            onDismiss={dismissProgressPanel}
          />
        )}
      </div>

      <PrecisionDrawer open={settingsOpen} title="Export Settings" onClose={() => setSettingsOpen(false)}>
        <ExportSettingsPanel
          project={project}
          selectedShot={selectedShot}
          selectedShotIds={selectedShotIds}
          isExportingPackage={isExportingPackage}
          onExportCurrentShot={() => void exportShot()}
          onAddCamera={() => addCamera({ navigateToShots: false })}
          patchSceneExportDefaults={patchSceneExportDefaults}
          updateShotResolvedSettings={(shotId, settings) => updateShot(shotId, { exportSettings: settings })}
          resetShotExportField={resetShotExportField}
          resetShotExportOverrides={resetShotExportOverrides}
          copyShotExportOverrides={copyShotExportOverrides}
          promoteShotExportToSceneDefaults={promoteShotExportToSceneDefaults}
          setProjectPackageFormat={setProjectPackageFormat}
        />
      </PrecisionDrawer>
    </FullBleedLayout>
  );
}

function ExportProgressPanel({
  progress,
  phase,
  onCancel,
  onDismiss,
}: {
  progress?: PackageExportProgress;
  phase: ExportUiPhase;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const running = phase === 'running';
  const percent = progress && !progress.indeterminate
    ? Math.round(Math.min(1, Math.max(0, progress.progress)) * 100)
    : undefined;
  const shotLine = progress
    ? `Exporting Shot ${progress.currentShot} of ${progress.totalShots}`
    : 'Preparing export…';
  const statusLabel = phase === 'complete'
    ? 'Export complete'
    : phase === 'failed'
      ? 'Export failed'
      : phase === 'cancelled'
        ? 'Export cancelled'
        : shotLine;

  return (
    <div
      data-export-progress-panel={phase}
      className="absolute inset-0 z-40 flex items-center justify-center bg-surface-base/70 p-4 backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md rounded-[var(--radius-card)] border border-subtle bg-surface-raised p-5 shadow-soft">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-primary">{statusLabel}</h2>
            {progress?.shotName && running && (
              <p className="mt-0.5 text-sm text-secondary">{progress.shotName}</p>
            )}
          </div>
          {!running && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg p-1 text-secondary transition hover:bg-surface-muted hover:text-primary"
              aria-label="Dismiss export progress"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <p className="mt-3 text-sm text-secondary">
          {progress?.message ?? (phase === 'failed' ? 'Something went wrong while building the package.' : 'Working…')}
        </p>

        <div className="mt-4">
          {progress?.indeterminate || percent === undefined ? (
            <div
              data-export-progress-indeterminate
              className="h-2 overflow-hidden rounded-full bg-surface-muted"
            >
              <div className="h-full w-full origin-left animate-pulse rounded-full bg-[var(--accent)]/70" />
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-secondary">
                <span>Progress</span>
                <span>{percent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                <div
                  data-export-progress-bar
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {running && (
          <div className="mt-4 space-y-1.5">
            <button
              type="button"
              onClick={onCancel}
              data-export-cancel
              className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-subtle text-sm font-medium text-secondary transition hover:border-strong hover:text-primary"
            >
              Cancel export
            </button>
            <p className="text-[11px] leading-snug text-muted">
              Cancellation applies between major steps; the current render or ZIP pass may finish first.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
