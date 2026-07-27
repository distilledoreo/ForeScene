import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { ArrowRight, Compass } from 'lucide-react';
import { getCanonicalPano, getLatestGrayboxPano, getPanoAsset } from '../../domain/selectors';
import { downloadPanoImage } from '../../engine/panoImage';
import { downloadDataUrl } from '../../engine/fileTransfers';
import {
  hasGrayboxPano,
  hasStyledCanonicalPano,
  isReferenceAlignmentAccepted,
  needsReferenceAlignment,
  resolveWorkflowAdvancePrompt,
  resolveWorkspaceObjective,
} from '../../engine/workflow';
import { Workspace } from '../../domain/types';
import { useContinuityStore } from '../../state/useContinuityStore';
import { AlignmentRetryContent, GrayboxReferencePromptBuilder } from './GrayboxReferenceGuide';
import { Modal } from './Modal';
import { countStyledPanoramas } from '../../engine/panoProjectionCore';

// Coverage analysis initializes geometry and renderer code; only load it after
// the user chooses the optional second-capture workflow.
const SecondCaptureForkContent = lazy(() => import('./SecondCaptureForkPanel').then((module) => ({
  default: module.SecondCaptureForkContent,
})));

const WORKSPACE_LABELS: Record<Workspace, string> = {
  build: 'Build',
  reference: 'Reference',
  shots: 'Shots',
  export: 'Export',
};

/** Only one workflow dialog is open at a time. */
type GuidanceDialog = 'none' | 'objective' | 'advance' | 'alignmentIntro' | 'alignmentRetry';

function ObjectiveBody({
  goal,
  why,
  proceedSignal,
  blockers,
}: {
  goal: string;
  why: string;
  proceedSignal: string;
  blockers: string[];
}) {
  return (
    <div className="space-y-4 text-[15px] leading-relaxed text-secondary">
      <div className="space-y-2">
        <p className="font-medium text-primary">{goal}</p>
        <p>{why}</p>
      </div>
      <p className="border-l-2 border-[var(--accent)] pl-3 text-secondary">{proceedSignal}</p>
      {blockers.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-secondary">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AlignmentIntroBody() {
  return (
    <div className="space-y-4 text-[15px] leading-relaxed text-secondary">
      <p className="font-medium text-primary">
        Before you move on, check that your styled pano lines up with the 3D scene.
      </p>
      <p>
        Use the pano viewer and the Alignment panel (top-right) for fade and yaw. Open Settings for advanced tools and additional panoramas.
      </p>
      <ol className="space-y-2">
        <li className="flex gap-3"><span className="font-semibold text-accent">1</span><span>Look around the viewer.</span></li>
        <li className="flex gap-3"><span className="font-semibold text-accent">2</span><span>Lower opacity to compare with the graybox.</span></li>
        <li className="flex gap-3"><span className="font-semibold text-accent">3</span><span>Adjust yaw if things are rotated wrong.</span></li>
        <li className="flex gap-3"><span className="font-semibold text-accent">4</span><span>Click <strong>Looks good enough</strong> when ready.</span></li>
      </ol>
      <p className="text-secondary">
        If yaw cannot fix it, open the retry tips and generate a new image.
      </p>
    </div>
  );
}

export function WorkflowGuidance() {
  const {
    project,
    workspace,
    selectedShotId,
    shotCameraFlying,
    dismissedWorkflowAdvanceKeys,
    seenObjectiveWorkspaces,
    objectiveModalRequest,
    alignmentIntroRequest,
    alignmentRetryModalRequest,
    seenAlignmentIntroForPanoId,
    setWorkspace,
    dismissWorkflowAdvance,
    markObjectiveSeen,
    markAlignmentIntroSeen,
    updateProjectInfo,
  } = useContinuityStore(useShallow((state) => ({
    project: state.project,
    workspace: state.workspace,
    selectedShotId: state.selectedShotId,
    shotCameraFlying: state.shotCameraFlying,
    dismissedWorkflowAdvanceKeys: state.dismissedWorkflowAdvanceKeys,
    seenObjectiveWorkspaces: state.seenObjectiveWorkspaces,
    objectiveModalRequest: state.objectiveModalRequest,
    alignmentIntroRequest: state.alignmentIntroRequest,
    alignmentRetryModalRequest: state.alignmentRetryModalRequest,
    seenAlignmentIntroForPanoId: state.seenAlignmentIntroForPanoId,
    setWorkspace: state.setWorkspace,
    dismissWorkflowAdvance: state.dismissWorkflowAdvance,
    markObjectiveSeen: state.markObjectiveSeen,
    markAlignmentIntroSeen: state.markAlignmentIntroSeen,
    updateProjectInfo: state.updateProjectInfo,
  })));

  const [isDownloadingGraybox, setIsDownloadingGraybox] = useState(false);
  const [activeDialog, setActiveDialog] = useState<GuidanceDialog>('none');
  const lastHandledObjectiveRequest = useRef(0);
  const lastHandledAlignmentIntroRequest = useRef(0);
  const lastHandledAlignmentRetryRequest = useRef(0);
  const lastOpenedAdvanceKey = useRef<string | undefined>();

  const context = useMemo(() => ({
    project,
    workspace,
    selectedShotId,
    shotCameraFlying,
  }), [project, workspace, selectedShotId, shotCameraFlying]);

  const objective = useMemo(() => resolveWorkspaceObjective(context), [context]);
  const advancePrompt = useMemo(
    () => resolveWorkflowAdvancePrompt(context, dismissedWorkflowAdvanceKeys),
    [context, dismissedWorkflowAdvanceKeys],
  );

  const grayboxPano = getLatestGrayboxPano(project);
  const grayboxAsset = getPanoAsset(project, grayboxPano);
  const canonicalPano = getCanonicalPano(project);
  const alignmentPending = needsReferenceAlignment(project) && !isReferenceAlignmentAccepted(project);
  const showReferencePromptBuilder = workspace === 'reference'
    && hasGrayboxPano(project)
    && !hasStyledCanonicalPano(project)
    && Boolean(grayboxPano);

  const openExclusive = (dialog: GuidanceDialog) => {
    setActiveDialog(dialog);
  };

  // Advance prompt wins over other guidance when it becomes newly eligible.
  useEffect(() => {
    if (!advancePrompt) {
      lastOpenedAdvanceKey.current = undefined;
      return;
    }
    if (lastOpenedAdvanceKey.current === advancePrompt.promptKey) return;
    lastOpenedAdvanceKey.current = advancePrompt.promptKey;
    openExclusive('advance');
  }, [advancePrompt?.promptKey]);

  // Alignment intro for a new styled pano (once per pano id).
  useEffect(() => {
    if (workspace !== 'reference' || !alignmentPending || !canonicalPano) return;
    if (seenAlignmentIntroForPanoId === canonicalPano.id) return;
    // Do not interrupt an advance dialog that just opened.
    if (activeDialog === 'advance') return;
    openExclusive('alignmentIntro');
  }, [workspace, alignmentPending, canonicalPano?.id, seenAlignmentIntroForPanoId, alignmentIntroRequest, activeDialog]);

  // Consume alignment retry requests by request id (not sticky > 0).
  useEffect(() => {
    if (alignmentRetryModalRequest <= lastHandledAlignmentRetryRequest.current) return;
    lastHandledAlignmentRetryRequest.current = alignmentRetryModalRequest;
    openExclusive('alignmentRetry');
  }, [alignmentRetryModalRequest]);

  // Consume objective modal requests by request id so alignmentPending flips
  // cannot reopen the objective after advance has closed it.
  useEffect(() => {
    if (objectiveModalRequest <= lastHandledObjectiveRequest.current) return;
    lastHandledObjectiveRequest.current = objectiveModalRequest;
    if (alignmentPending && workspace === 'reference') {
      openExclusive('alignmentIntro');
    } else {
      openExclusive('objective');
    }
  }, [objectiveModalRequest, alignmentPending, workspace]);

  // First-visit reference prompt builder (only when nothing else is open).
  useEffect(() => {
    if (workspace !== 'reference' || !showReferencePromptBuilder) return;
    if (seenObjectiveWorkspaces.includes('reference')) return;
    if (activeDialog !== 'none') return;
    if (advancePrompt) return;
    openExclusive('objective');
  }, [
    workspace,
    showReferencePromptBuilder,
    seenObjectiveWorkspaces,
    activeDialog,
    advancePrompt?.promptKey,
  ]);

  // Explicit alignment intro request (button) — consume by id.
  useEffect(() => {
    if (alignmentIntroRequest <= lastHandledAlignmentIntroRequest.current) return;
    lastHandledAlignmentIntroRequest.current = alignmentIntroRequest;
    openExclusive('alignmentIntro');
  }, [alignmentIntroRequest]);

  const closeObjective = () => {
    setActiveDialog('none');
    markObjectiveSeen(workspace);
  };

  const closeAlignmentIntro = () => {
    setActiveDialog('none');
    if (canonicalPano) {
      markAlignmentIntroSeen(canonicalPano.id);
    }
  };

  const handleAdvanceNext = () => {
    if (!advancePrompt) return;
    const { nextStep, promptKey } = advancePrompt;
    const shouldOpenReferenceObjective = nextStep === 'reference'
      && hasGrayboxPano(project)
      && !hasStyledCanonicalPano(project)
      && !seenObjectiveWorkspaces.includes('reference');
    dismissWorkflowAdvance(promptKey);
    setActiveDialog('none');
    setWorkspace(nextStep);
    if (shouldOpenReferenceObjective) {
      // Next tick so workspace effect does not race exclusive close.
      window.setTimeout(() => openExclusive('objective'), 0);
    }
  };

  const handleAdvanceDismiss = () => {
    if (!advancePrompt) return;
    dismissWorkflowAdvance(advancePrompt.promptKey);
    setActiveDialog('none');
  };

  const showSecondCaptureFork = Boolean(
    advancePrompt
    && advancePrompt.completedStep === 'reference'
    && advancePrompt.nextStep === 'shots'
    && countStyledPanoramas(project) === 1,
  );

  const downloadGrayboxForAi = async () => {
    if (!grayboxAsset || !grayboxPano) return;
    setIsDownloadingGraybox(true);
    try {
      await downloadPanoImage(
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
      );
    } finally {
      setIsDownloadingGraybox(false);
    }
  };

  return (
    <>
      <Modal
        open={activeDialog === 'alignmentIntro'}
        title="Check pano alignment"
        onClose={closeAlignmentIntro}
        size="lg"
        scrollBody
        footer={(
          <button
            type="button"
            onClick={closeAlignmentIntro}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--accent-hover)]"
          >
            Start checking
          </button>
        )}
      >
        <AlignmentIntroBody />
      </Modal>

      <Modal
        open={activeDialog === 'alignmentRetry'}
        title="Try generating again"
        onClose={() => setActiveDialog('none')}
        size="xl"
        scrollBody
        footer={(
          <button
            type="button"
            onClick={() => setActiveDialog('none')}
            className="rounded-lg border border-subtle bg-surface-raised px-4 py-2 text-sm font-medium text-secondary transition hover:border-strong hover:bg-surface-muted hover:text-primary"
          >
            Close
          </button>
        )}
      >
        <AlignmentRetryContent
          project={project}
          grayboxAsset={grayboxAsset}
          onCreativeBriefChange={(description) => updateProjectInfo({ description })}
          onDownloadGraybox={() => void downloadGrayboxForAi()}
          isDownloading={isDownloadingGraybox}
        />
      </Modal>

      <Modal
        open={activeDialog === 'objective'}
        title={showReferencePromptBuilder
          ? 'Style your graybox pano'
          : `${WORKSPACE_LABELS[workspace]} — What to do`}
        onClose={closeObjective}
        size={showReferencePromptBuilder ? 'xl' : 'md'}
        scrollBody={showReferencePromptBuilder}
        footer={(
          <button
            type="button"
            onClick={closeObjective}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--accent-hover)]"
          >
            Got it
          </button>
        )}
      >
        {showReferencePromptBuilder && grayboxPano ? (
          <GrayboxReferencePromptBuilder
            project={project}
            grayboxPano={grayboxPano}
            grayboxAsset={grayboxAsset}
            onCreativeBriefChange={(description) => updateProjectInfo({ description })}
            onDownloadGraybox={() => void downloadGrayboxForAi()}
            isDownloading={isDownloadingGraybox}
          />
        ) : (
          <ObjectiveBody
            goal={objective.goal}
            why={objective.why}
            proceedSignal={objective.proceedSignal}
            blockers={objective.blockers}
          />
        )}
      </Modal>

      <Modal
        open={activeDialog === 'advance' && Boolean(advancePrompt)}
        title={showSecondCaptureFork
          ? 'Reference ready'
          : (advancePrompt?.title ?? 'Ready for the next step')}
        onClose={handleAdvanceDismiss}
        size={showSecondCaptureFork ? 'lg' : 'md'}
        scrollBody={showSecondCaptureFork}
        footer={showSecondCaptureFork ? undefined : (
          <>
            <button
              type="button"
              onClick={handleAdvanceDismiss}
              className="rounded-lg border border-subtle bg-surface-raised px-4 py-2 text-sm font-medium text-secondary transition hover:border-strong hover:bg-surface-muted hover:text-primary"
            >
              Not right now
            </button>
            <button
              type="button"
              onClick={handleAdvanceNext}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--accent-hover)]"
            >
              {advancePrompt?.nextLabel ?? 'Continue'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </>
        )}
      >
        {showSecondCaptureFork ? (
          <Suspense fallback={<p className="text-sm text-secondary">Loading second-capture planner…</p>}>
            <SecondCaptureForkContent
              open={activeDialog === 'advance' && showSecondCaptureFork}
              compactIntro
              onContinue={handleAdvanceNext}
              onClose={handleAdvanceDismiss}
              onAwaitingImport={() => {
                // Frozen plan is latched inside SecondCaptureForkContent.
              }}
              onPlaceInBuild={handleAdvanceDismiss}
            />
          </Suspense>
        ) : (
          <p className="text-sm text-secondary">{advancePrompt?.body}</p>
        )}
      </Modal>
    </>
  );
}

export function ObjectiveHelpButton() {
  const requestObjectiveModal = useContinuityStore((state) => state.requestObjectiveModal);

  return (
    <button
      type="button"
      onClick={() => requestObjectiveModal()}
      className="inline-flex items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-3 py-2 text-sm font-medium text-secondary transition hover:border-[var(--accent)] hover:text-accent"
      title="Show current objective"
    >
      <Compass className="h-4 w-4" />
      Objective
    </button>
  );
}
