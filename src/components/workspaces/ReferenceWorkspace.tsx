import React, { useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { Check, FileDown, Hand, Settings, Sparkles, Star, Trash2 } from 'lucide-react';
import type { PanoReference } from '../../domain/types';
import { STYLED_PANO } from '../../domain/copy';
import { useContinuityStore } from '../../state/useContinuityStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { preparePanoImport, downloadPanoImage } from '../../engine/panoImage';
import { downloadDataUrl, readFileAsDataUrl } from '../../engine/fileTransfers';
import { getLatestGrayboxPano, getPanoAsset, listGrayboxPanos, resolveCompareGraybox } from '../../domain/selectors';
import { ReferenceAlignmentPanel } from '../common/ReferenceAlignmentPanel';
import { ProjectedStylePanel } from '../common/ProjectedStylePanel';
import { SecondCaptureForkPanel } from '../common/SecondCaptureForkPanel';
import { StyledPanoImportButton } from '../common/StyledPanoImportButton';
import { ContextualPanel } from '../common/ContextualPanel';
import { Field, IconButton, TextInput } from '../common/Field';
import { PrecisionDrawer } from '../common/PrecisionDrawer';
import { PrimaryCTA } from '../common/PrimaryCTA';
import { LandmarkStrip, PanoLandmarkMarkers } from '../viewers/PanoLandmarkOverlay';
import { PanoViewer } from '../viewers/PanoViewer';
import { directionToYawPitch, subtract } from '../../engine/sync';
import {
  countStyledPanoramas,
  resolveStyledImportMode,
  styledImportActionHint,
} from '../../engine/panoProjectionCore';
import { isEligibleProjectedStylePano } from '../../engine/panoProjectionCore';
import {
  hasReferenceCandidate,
  hasStyledCanonicalPano,
  isReferenceAlignmentAccepted,
  isReferenceReady,
  needsReferenceAlignment,
  resolveWorkspacePrimaryAction,
} from '../../engine/workflow';
import { FullBleedLayout } from './WorkspaceShell';

export function ReferenceWorkspace() {
  const [compareOpacity, setCompareOpacity] = useState(0.65);
  const [precisionOpen, setPrecisionOpen] = useState(false);
  const [focusedLandmarkId, setFocusedLandmarkId] = useState<string | undefined>();
  const [fillGapsOpen, setFillGapsOpen] = useState(false);
  const runDestructiveProjectMutation = useProjectSafetyStore((state) => state.runDestructiveProjectMutation);
  const {
    project,
    activePanoId,
    panoView,
    pendingSecondCapturePlan,
    setActivePano,
    setPanoView,
    updatePanoReference,
    updateProjectSettings,
    setPanoOrigin,
    importStyledPano,
    removePanoReference,
    approveGrayboxForReference,
    acceptReferenceAlignment,
    requestAlignmentIntro,
    requestAlignmentRetryModal,
    setWorkspace,
    setPendingSecondCapturePlan,
  } = useContinuityStore(useShallow((state) => ({
    project: state.project,
    activePanoId: state.activePanoId,
    panoView: state.panoView,
    pendingSecondCapturePlan: state.pendingSecondCapturePlan,
    setActivePano: state.setActivePano,
    setPanoView: state.setPanoView,
    updatePanoReference: state.updatePanoReference,
    updateProjectSettings: state.updateProjectSettings,
    setPanoOrigin: state.setPanoOrigin,
    importStyledPano: state.importStyledPano,
    removePanoReference: state.removePanoReference,
    approveGrayboxForReference: state.approveGrayboxForReference,
    acceptReferenceAlignment: state.acceptReferenceAlignment,
    requestAlignmentIntro: state.requestAlignmentIntro,
    requestAlignmentRetryModal: state.requestAlignmentRetryModal,
    setWorkspace: state.setWorkspace,
    setPendingSecondCapturePlan: state.setPendingSecondCapturePlan,
  })));
  const activePano = project.panoRefs.find((pano) => pano.id === activePanoId) ?? project.panoRefs.find((pano) => pano.isCanonical);
  const activeAsset = activePano ? project.assets.assets[activePano.imageAssetId] : undefined;
  const compareGraybox = resolveCompareGraybox(project, activePano);
  const compareGrayboxAsset = getPanoAsset(project, compareGraybox);
  const grayboxPano = compareGraybox ?? getLatestGrayboxPano(project);
  const grayboxAsset = getPanoAsset(project, grayboxPano);
  const grayboxCount = listGrayboxPanos(project).length;
  const canCalibrate = Boolean(activePano && activePano.type !== 'graybox_render' && compareGraybox);
  const alignmentAccepted = isReferenceAlignmentAccepted(project);
  const styledCount = countStyledPanoramas(project);
  const importMode = resolveStyledImportMode(project, { pendingSecondCapturePlan });
  const styledPanos = project.panoRefs.filter(isEligibleProjectedStylePano);
  const primaryAction = useMemo(
    () => resolveWorkspacePrimaryAction({ project, workspace: 'reference', shotCameraFlying: false }),
    [project],
  );

  const setActiveYaw = (yawDegrees: number) => {
    if (!activePano) return;
    updatePanoReference(activePano.id, {
      rotation: [
        activePano.rotation[0],
        normalizeSignedYaw(yawDegrees),
        activePano.rotation[2],
      ],
    });
  };

  const importPanoImage = async (params: { name: string; dataUrl: string; width: number; height: number }) => {
    const currentCanonical = project.panoRefs.find((pano) => pano.isCanonical);
    if (importMode === 'replace' && currentCanonical) {
      const affectedShots = project.shots.filter((shot) => (
        shot.linkedPanoId === currentCanonical.id || shot.panoCrop?.panoId === currentCanonical.id
      )).length;
      if (!window.confirm(
        `Replace the current canonical panorama? ${affectedShots} shot${affectedShots === 1 ? '' : 's'} will use the replacement. A local recovery point will be kept before the change.`,
      )) return;
    }
    const prepared = await preparePanoImport(params.dataUrl, params.width, params.height);
    const applyImport = () => importStyledPano({
      name: params.name,
      dataUrl: prepared.dataUrl,
      width: prepared.width,
      height: prepared.height,
      importNote: prepared.analysis.wasLetterboxed
        ? `Imported from ${params.width}×${params.height} letterboxed 16:9; extracted ${prepared.width}×${prepared.height} equirectangular region.`
        : undefined,
    });
    let mode: ReturnType<typeof importStyledPano> | undefined;
    if (importMode === 'replace' && currentCanonical) {
      if (!runDestructiveProjectMutation) throw new Error('Local recovery is still starting. Please wait before replacing a panorama.');
      await runDestructiveProjectMutation('Before replacing a panorama', () => {
        mode = applyImport();
      });
    } else {
      mode = applyImport();
    }
    if (mode === 'add_secondary') setPendingSecondCapturePlan(undefined);
  };

  const removePanoWithRecovery = (pano: PanoReference) => {
    if (!confirmRemovePano(pano) || !runDestructiveProjectMutation) return;
    void runDestructiveProjectMutation('Before deleting a panorama reference', () => {
      removePanoReference(pano.id);
    }).catch(() => undefined);
  };

  const confirmRemovePano = (pano: PanoReference): boolean => {
    const affectedShots = project.shots.filter((shot) => (
      shot.linkedPanoId === pano.id || shot.panoCrop?.panoId === pano.id
    )).length;
    const label = pano.type === 'ai_global_reference' || pano.type === 'external_reference'
      ? 'uploaded panorama'
      : 'panorama reference';
    return window.confirm(
      `Remove this ${label}? ${affectedShots} shot${affectedShots === 1 ? '' : 's'} will be re-linked or cleared. A local recovery point will be kept before removal.`,
    );
  };

  const loadAttachedReference = async () => {
    const response = await fetch('/attached-canonical-reference.png');
    if (!response.ok) throw new Error('Could not load the attached canonical reference.');
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    const dimensions = await getImageDimensions(dataUrl);
    await importPanoImage({
      name: 'attached-canonical-reference.png',
      dataUrl,
      width: dimensions.width,
      height: dimensions.height,
    });
  };

  const downloadActivePano = async () => {
    if (!activeAsset || !activePano) return;
    await downloadPanoImage(
      activeAsset.uri,
      activePano.width,
      activePano.height,
      activeAsset.name || `${activePano.name}.png`,
      {
        letterboxEnabled: project.settings.panoLetterboxExports169,
        targetWidth: project.settings.defaultShotWidth,
        targetHeight: project.settings.defaultShotHeight,
      },
      downloadDataUrl,
    );
  };

  const panoOrigin = activePano?.origin ?? project.scene.panoOrigin;

  const focusLandmark = (landmarkId: string, yawDegrees?: number, pitchDegrees?: number) => {
    setFocusedLandmarkId(landmarkId);
    const landmark = project.landmarks.find((item) => item.id === landmarkId);
    if (!landmark) return;
    if (yawDegrees !== undefined && pitchDegrees !== undefined) {
      setPanoView({ yawDegrees, pitchDegrees });
      return;
    }
    const { yawDegrees: targetYaw, pitchDegrees: targetPitch } = directionToYawPitch(
      subtract(landmark.position, panoOrigin),
    );
    setPanoView({ yawDegrees: targetYaw, pitchDegrees: targetPitch });
  };

  const approveReference = () => {
    if (canCalibrate && needsReferenceAlignment(project) && !alignmentAccepted) {
      // Advance modal opens with Continue vs Fill missing areas once reference is ready.
      acceptReferenceAlignment();
      return;
    }
    if (grayboxPano && !hasReferenceCandidate(project)) {
      approveGrayboxForReference();
      return;
    }
    // Already approved — reopen the fill-gaps panel only when a second capture is still optional.
    if (styledCount === 1) {
      setFillGapsOpen(true);
    }
  };

  return (
    <FullBleedLayout reserveHeader>
      <div className="flex h-full min-h-0 flex-col p-4 md:p-5">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-subtle bg-surface-raised shadow-card">
          <div className="relative min-h-0 flex-1">
            <PanoViewer
              imageUrl={activeAsset?.uri}
              view={panoView}
              onViewChange={setPanoView}
              label={activePano?.name ?? 'Reference Workspace'}
              panoRotation={activePano?.rotation}
              compareImageUrl={canCalibrate ? compareGrayboxAsset?.uri : undefined}
              compareRotation={compareGraybox?.rotation}
              compareOpacity={compareOpacity}
            />

            {!activeAsset && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-surface-base/55 backdrop-blur-[2px]">
                <ContextualPanel className="max-w-md text-center">
                  <p className="text-base font-semibold text-primary">
                    {grayboxPano
                      ? 'Import a styled pano or approve the graybox to begin.'
                      : 'Render a graybox in Build first.'}
                  </p>
                  <p className="mt-1 text-sm text-secondary">
                    Use your own reference image or the attached sample to continue.
                  </p>
                  <div className="pointer-events-auto mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
                    <StyledPanoImportButton
                      primary
                      highlighted={primaryAction?.id === 'import-styled-pano'}
                      className="min-w-44"
                    />
                    <IconButton onClick={() => void loadAttachedReference()} className="min-w-44">
                      <Sparkles className="h-4 w-4" />
                      Use Attached Reference
                    </IconButton>
                  </div>
                  {grayboxPano && !hasReferenceCandidate(project) && (
                    <button
                      type="button"
                      onClick={() => approveGrayboxForReference()}
                      className="pointer-events-auto mt-3 inline-flex items-center gap-2 text-sm text-secondary transition hover:text-accent"
                    >
                      <Star className="h-4 w-4" />
                      Use graybox only (skip styling)
                    </button>
                  )}
                </ContextualPanel>
              </div>
            )}

            {activeAsset && (
              <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
                <div className="rounded-full border border-subtle/70 bg-surface-overlay/55 px-3 py-1.5 text-center text-xs font-medium text-secondary shadow-soft backdrop-blur-sm">
                  <Hand className="mr-1 inline h-3.5 w-3.5 text-accent" />
                  Drag to look around
                </div>
              </div>
            )}

            {activeAsset && project.landmarks.length > 0 && (
              <PanoLandmarkMarkers
                landmarks={project.landmarks}
                panoOrigin={panoOrigin}
                view={panoView}
                focusedLandmarkId={focusedLandmarkId}
                onFocusLandmark={focusLandmark}
              />
            )}

            {activeAsset && grayboxPano && !hasStyledCanonicalPano(project) && (
              <div className="pointer-events-none absolute left-5 top-5 z-20">
                <ContextualPanel className="flex flex-wrap items-center gap-2">
                  <StyledPanoImportButton
                    label="Import styled pano"
                    primary
                    highlighted={primaryAction?.id === 'import-styled-pano'}
                    className="min-w-40"
                  />
                  <IconButton onClick={() => void loadAttachedReference()}>
                    <Sparkles className="h-4 w-4" />
                    Use Attached Reference
                  </IconButton>
                </ContextualPanel>
              </div>
            )}

            {activeAsset && hasStyledCanonicalPano(project) && !fillGapsOpen && (
              <div
                className="pointer-events-none absolute left-5 top-5 z-20 w-[min(18rem,calc(100%-2.5rem))]"
                data-panoramas-card
              >
                <ContextualPanel className="pointer-events-auto space-y-2 shadow-soft">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-secondary">Panoramas</div>
                      <p className="mt-0.5 text-[11px] text-secondary">
                        {importMode === 'add_secondary'
                          ? styledImportActionHint('add_secondary')
                          : `${styledCount} styled capture${styledCount === 1 ? '' : 's'}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPrecisionOpen(true)}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-subtle text-secondary transition hover:border-accent hover:text-accent"
                      aria-label="Reference settings"
                      data-reference-settings-gear
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <ul
                    className="space-y-1"
                    data-reference-pano-origins
                    data-graybox-count={grayboxCount}
                    data-styled-pano-count={styledPanos.length}
                  >
                    {styledPanos.map((pano, index) => {
                      const isActive = pano.id === activePano?.id;
                      const captureLabel = styledPanos.length > 1
                        ? `Origin ${String.fromCharCode(65 + index)}`
                        : 'Origin';
                      return (
                        <li key={pano.id} className="text-xs text-primary">
                          <button
                            type="button"
                            onClick={() => setActivePano(pano.id)}
                            className={`w-full rounded-lg px-1.5 py-1 text-left transition ${
                              isActive
                                ? 'bg-accent-soft font-semibold text-accent'
                                : 'hover:bg-surface-muted/80 hover:text-accent'
                            }`}
                            data-reference-pano-option={pano.id}
                            data-pano-origin={pano.origin.map((value) => value.toFixed(3)).join(',')}
                            aria-pressed={isActive}
                          >
                            <span className="block truncate">
                              {pano.name}
                              {pano.isCanonical ? ' · reference' : ''}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] font-normal text-secondary">
                              {captureLabel}
                              {' · '}
                              {pano.origin.map((value) => value.toFixed(1)).join(', ')}
                              {' m'}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {activePano && styledPanos.length > 1 && (
                    <p className="text-[10px] leading-snug text-secondary" data-reference-active-origin-hint>
                      Preview uses this capture’s origin for landmarks
                      {!compareGraybox && grayboxCount > 0
                        ? ' · no graybox matches this capture, so alignment is hidden'
                        : ''}
                      .
                    </p>
                  )}
                  <StyledPanoImportButton
                    modeAware
                    onImported={(mode) => {
                      if (mode === 'add_secondary') setPendingSecondCapturePlan(undefined);
                    }}
                  />
                  {styledCount === 1 && (
                    <button
                      type="button"
                      onClick={() => setFillGapsOpen(true)}
                      className="w-full text-left text-[11px] font-medium text-accent hover:underline"
                      data-open-fill-gaps
                    >
                      Fill missing areas with a second vantage…
                    </button>
                  )}
                </ContextualPanel>
              </div>
            )}

            {!activeAsset && (
              <button
                type="button"
                onClick={() => setPrecisionOpen(true)}
                className="pointer-events-auto absolute right-5 top-5 z-20 inline-flex h-11 w-11 items-center justify-center rounded-lg border border-subtle bg-surface-overlay/90 text-secondary shadow-card backdrop-blur-sm transition hover:border-accent hover:text-accent"
                aria-label="Reference settings"
                data-reference-settings-gear
              >
                <Settings className="h-4 w-4" />
              </button>
            )}

            <SecondCaptureForkPanel
              open={fillGapsOpen}
              onClose={() => setFillGapsOpen(false)}
              onContinue={() => {
                setFillGapsOpen(false);
                setWorkspace('shots');
              }}
              onAwaitingImport={() => {
                // Plan is already latched by the fork; keep the panel flow open for import.
              }}
            />

            <div
              data-reference-bottom-chrome
              className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 px-3 pb-3 sm:flex-row sm:items-end sm:gap-3 sm:px-4 sm:pb-4"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                {grayboxAsset && grayboxPano && (
                  <div className="pointer-events-auto shrink-0">
                    <button
                      type="button"
                      onClick={() => void downloadPanoImage(
                        grayboxAsset.uri,
                        grayboxPano.width,
                        grayboxPano.height,
                        grayboxAsset.name || 'global_graybox.png',
                        {
                          letterboxEnabled: project.settings.panoLetterboxExports169,
                          targetWidth: project.settings.defaultShotWidth,
                          targetHeight: project.settings.defaultShotHeight,
                        },
                        downloadDataUrl,
                      )}
                      className="inline-flex min-h-11 items-center gap-2 rounded-[18px] border border-subtle bg-surface-raised px-4 py-2.5 text-sm font-medium text-secondary shadow-card transition hover:border-[var(--accent)] hover:text-accent"
                    >
                      <FileDown className="h-4 w-4" />
                      <span className="hidden xs:inline sm:inline">Download Graybox 360</span>
                      <span className="sm:hidden">Graybox</span>
                    </button>
                  </div>
                )}
                {activeAsset && project.landmarks.length > 0 && (
                  <div className="pointer-events-auto min-w-0 max-w-full flex-1 sm:max-w-[calc(100%-var(--reference-cta-lane))]">
                    <LandmarkStrip
                      landmarks={project.landmarks.filter((landmark) => landmark.visible)}
                      panoImageUrl={activeAsset.uri}
                      panoOrigin={panoOrigin}
                      focusedLandmarkId={focusedLandmarkId}
                      onFocusLandmark={(landmarkId) => focusLandmark(landmarkId)}
                    />
                  </div>
                )}
              </div>
              <div className="pointer-events-none w-full shrink-0 sm:ml-auto sm:w-auto">
                <PrimaryCTA
                  icon={<Check className="h-5 w-5" />}
                  label="Approve as Reference"
                  hint="Looks good? Lock this pano for your shots."
                  onClick={approveReference}
                  highlighted={primaryAction?.id === 'confirm-alignment' || isReferenceReady(project)}
                />
              </div>
            </div>

            {canCalibrate && activePano && (
              <div
                data-reference-alignment-chrome
                className="pointer-events-none absolute right-5 top-5 z-20 w-[min(18rem,calc(100%-2.5rem))]"
              >
                <ContextualPanel className="pointer-events-auto space-y-3 shadow-soft">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-secondary">Alignment</div>
                      <p className="mt-0.5 text-xs text-secondary">Fade and yaw to match the graybox.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPrecisionOpen(true)}
                      className="shrink-0 text-[11px] font-medium text-accent hover:underline"
                      data-reference-settings-link
                    >
                      Settings
                    </button>
                  </div>
                  <label className="block text-[11px] font-medium text-secondary">
                    Graybox fade
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(compareOpacity * 100)}
                      onChange={(event) => setCompareOpacity(Number(event.target.value) / 100)}
                      className="mt-1 w-full accent-[var(--accent)]"
                      aria-label="Graybox compare opacity"
                    />
                  </label>
                  <label className="block text-[11px] font-medium text-secondary">
                    Yaw ({Math.round(activePano.rotation[1])}°)
                    <input
                      type="range"
                      min="-180"
                      max="180"
                      step="1"
                      value={activePano.rotation[1]}
                      onChange={(event) => setActiveYaw(Number(event.target.value))}
                      className="mt-1 w-full accent-[var(--accent)]"
                      aria-label="Styled pano yaw"
                      data-reference-yaw-slider
                    />
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {[-5, 5].map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        onClick={() => setActiveYaw(activePano.rotation[1] + delta)}
                        className="rounded-lg border border-subtle px-2 py-1 text-[11px] font-medium text-secondary hover:border-accent hover:text-accent"
                      >
                        {delta > 0 ? '+' : ''}{delta}°
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setActiveYaw(0)}
                      className="rounded-lg border border-subtle px-2 py-1 text-[11px] font-medium text-secondary hover:border-accent hover:text-accent"
                    >
                      Reset
                    </button>
                  </div>
                </ContextualPanel>
              </div>
            )}

          </div>
        </div>
      </div>

      <PrecisionDrawer open={precisionOpen} title="Reference Settings" onClose={() => setPrecisionOpen(false)}>
        <div className="space-y-4">
          {canCalibrate && activePano && (
            <ReferenceAlignmentPanel
              activePano={activePano}
              compareOpacity={compareOpacity}
              onYawChange={setActiveYaw}
              onOpacityChange={setCompareOpacity}
              onAcceptAlignment={() => acceptReferenceAlignment()}
              onShowRetryTips={() => requestAlignmentRetryModal()}
              alignmentAccepted={alignmentAccepted}
              highlightNextStep={primaryAction?.id === 'confirm-alignment'}
            />
          )}
          <div className="space-y-2" data-pano-reference-list>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary">Pano References</h3>
            <StyledPanoImportButton modeAware className="w-full" />
            <p className="text-[11px] leading-snug text-muted">
              {styledImportActionHint(importMode)}
              {' '}
              Imports stamp the current capture origin from Build.
            </p>
            {styledCount === 1 && (
              <button
                type="button"
                onClick={() => {
                  setPrecisionOpen(false);
                  setFillGapsOpen(true);
                }}
                className="w-full rounded-lg border border-subtle px-3 py-2 text-sm text-secondary transition hover:border-accent hover:text-accent"
                data-drawer-fill-gaps
              >
                Fill missing areas…
              </button>
            )}
            {project.panoRefs.length === 0 && (
              <p className="text-sm text-secondary">No pano references yet.</p>
            )}
            {project.panoRefs.map((pano) => {
              const isActive = pano.id === activePano?.id;
              const isUploaded = pano.type === 'ai_global_reference' || pano.type === 'external_reference';
              const typeLabel = pano.type === 'graybox_render'
                ? 'Graybox render'
                : pano.type === 'ai_global_reference'
                  ? 'Uploaded styled pano'
                  : pano.type === 'external_reference'
                    ? 'External reference'
                    : pano.type;
              return (
                <div
                  key={pano.id}
                  className={`flex items-stretch gap-1 rounded-lg border transition ${
                    isActive ? 'border-[var(--accent)] bg-accent-soft' : 'border-subtle'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActivePano(pano.id)}
                    className="min-w-0 flex-1 px-3 py-2 text-left text-sm"
                  >
                    <div className="truncate font-medium text-primary">
                      {pano.name}
                      {pano.isCanonical ? ' · canonical' : ''}
                    </div>
                    <div className="truncate text-xs text-secondary">{typeLabel}</div>
                    <div className="truncate text-[10px] text-secondary">
                      Origin · {pano.origin.map((value) => value.toFixed(1)).join(', ')} m
                    </div>
                  </button>
                  <button
                    type="button"
                    title={isUploaded ? 'Remove uploaded pano' : 'Remove pano reference'}
                    aria-label={`Remove ${pano.name}`}
                    data-remove-pano={pano.id}
                    onClick={() => {
                      removePanoWithRecovery(pano);
                    }}
                    className="inline-flex shrink-0 items-center justify-center px-2.5 text-secondary transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
          {activePano && (
            <>
              <Field label="Name">
                <TextInput value={activePano.name} readOnly />
              </Field>
              {activeAsset && (
                <IconButton onClick={() => void downloadActivePano()} className="w-full">
                  <FileDown className="h-4 w-4" />
                  Download Active Pano
                </IconButton>
              )}
              {(activePano.type === 'ai_global_reference' || activePano.type === 'external_reference') && (
                <IconButton
                  onClick={() => {
                    removePanoWithRecovery(activePano);
                  }}
                  className="w-full border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400"
                  data-remove-active-pano
                >
                  <Trash2 className="h-4 w-4" />
                  Remove Uploaded Pano
                </IconButton>
              )}
            </>
          )}
          <label className="flex items-start gap-2 rounded-lg border border-subtle px-3 py-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={project.settings.panoLetterboxExports169}
              onChange={(event) => updateProjectSettings({ panoLetterboxExports169: event.target.checked })}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>
              Letterbox panorama exports to 16:9
              <span className="mt-1 block text-xs text-muted">
                Wraps 2:1 equirectangular panos into {project.settings.defaultShotWidth}×{project.settings.defaultShotHeight} PNGs.
              </span>
            </span>
          </label>

          <div className="border-t border-subtle pt-4">
            <ProjectedStylePanel
              project={project}
              onChange={(projectedStyle) => updateProjectSettings({ projectedStyle })}
              onSetCaptureOrigin={setPanoOrigin}
            />
          </div>

          {needsReferenceAlignment(project) && !alignmentAccepted && (
            <button
              type="button"
              onClick={() => requestAlignmentIntro()}
              className="w-full rounded-lg border border-subtle px-3 py-2 text-sm text-secondary transition hover:border-accent hover:text-accent"
            >
              Reopen alignment guide
            </button>
          )}
          {!grayboxPano && (
            <p className="text-sm text-secondary">
              Render a graybox in Build first. Then open Objective for the image AI prompt.
            </p>
          )}
          {!canCalibrate && grayboxCount > 0 && activePano && activePano.type !== 'graybox_render' && !compareGraybox && (
            <p className="text-sm text-secondary" data-reference-origin-mismatch>
              This panorama was captured at a different origin than available grayboxes.
              Landmarks still use this pano’s origin. Render a clay 360 at this capture point in Build if you need graybox alignment.
            </p>
          )}
          {!canCalibrate && grayboxPano && (!activePano || activePano.type === 'graybox_render' || compareGraybox) && (
            <p className="text-sm text-secondary">
              Import a {STYLED_PANO.short} to compare it against the graybox.
            </p>
          )}
        </div>
      </PrecisionDrawer>
    </FullBleedLayout>
  );
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 4096, height: 2048 });
    image.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function normalizeSignedYaw(value: number) {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}
