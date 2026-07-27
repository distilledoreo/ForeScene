import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  FileArchive,
  LoaderCircle,
  Upload,
} from 'lucide-react';
import { SceneObject } from '../../domain/types';
import {
  MODEL_IMPORT_ACCEPT,
  ModelImportMode,
  ModelImportAnalysis,
  ModelImportConsentRequiredError,
  ModelImportJob,
  createModelImportPlan,
  formatBytes,
  importModelJob,
} from '../../engine/modelImport';
import { useContinuityStore } from '../../state/useContinuityStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { Modal } from './Modal';

interface ImportReportItem {
  id: string;
  tone: 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export function ModelImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: (objects: SceneObject[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addImportedModels = useContinuityStore((state) => state.addImportedModels);
  const runDestructiveProjectMutation = useProjectSafetyStore((state) => state.runDestructiveProjectMutation);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [report, setReport] = useState<ImportReportItem[]>([]);
  const [mode, setMode] = useState<ModelImportMode>('separate');
  const [allowHeavy, setAllowHeavy] = useState(false);
  const [pending, setPending] = useState<{ job: ModelImportJob; analysis: ModelImportAnalysis }>();
  const [extremeText, setExtremeText] = useState('');
  const abortRef = useRef<AbortController>();

  const selectFiles = () => {
    if (!busy) inputRef.current?.click();
  };

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || busy) return;
    const plan = createModelImportPlan(Array.from(files));
    const nextReport: ImportReportItem[] = plan.issues.map((issue, index) => ({
      id: `plan-${index}-${issue.fileName}`,
      tone: issue.tone,
      title: issue.fileName,
      message: issue.message,
    }));
    const imported: SceneObject[] = [];
    setBusy(true);
    abortRef.current = new AbortController();
    setReport(nextReport);

    for (let index = 0; index < plan.jobs.length; index += 1) {
      const job = plan.jobs[index];
      setProgress(`Converting ${job.file.name} (${index + 1} of ${plan.jobs.length})…`);
      try {
        // Sequential conversion keeps peak memory predictable on low-power devices.
        const batch = await importModelJob(job, {
          mode,
          allowHeavy: false,
          signal: abortRef.current.signal,
          onProgress: (value) => setProgress(value.message),
        });
        if (!runDestructiveProjectMutation) throw new Error('Local recovery is still starting. Please wait before importing a model.');
        await runDestructiveProjectMutation('Before importing a model', () => {
          addImportedModels(batch.items);
        });
        imported.push(...batch.items.map((i) => i.object));

        // Per-file success card
        if (batch.summary.combined) {
          nextReport.push({
            id: `${batch.items[0]?.object.importedModel?.sourceImportId ?? batch.items[0]?.object.id}-summary`,
            tone: 'success',
            title: batch.summary.sourceName,
            message: `Imported 1 combined object from ${batch.summary.sourceNodeCount} mesh nodes · ${batch.summary.totalTriangles.toLocaleString()} triangles · layout preserved`,
          });
        } else {
          nextReport.push({
            id: `${batch.summary.sourceName}-summary`,
            tone: 'success',
            title: batch.summary.sourceName,
            message: `Imported ${batch.summary.totalObjects} selectable object${batch.summary.totalObjects === 1 ? '' : 's'} · ${batch.summary.totalTriangles.toLocaleString()} triangles · layout preserved, hierarchy flattened`,
          });
        }

        batch.warnings.forEach((warning, warningIndex) => nextReport.push({
          id: `${batch.items[0]?.object.id ?? index}-warning-${warningIndex}`,
          tone: 'warning',
          title: batch.summary.sourceName,
          message: warning,
        }));
      } catch (error) {
        if (error instanceof ModelImportConsentRequiredError) {
          setPending({ job, analysis: error.analysis });
          nextReport.push({ id: `analysis-${job.file.name}`, tone: 'warning', title: job.file.name, message: `${error.analysis.tier.toUpperCase()} scene: ${error.analysis.loadedVertexCount.toLocaleString()} vertices, ${error.analysis.triangleCount.toLocaleString()} triangles, ${formatBytes(error.analysis.estimatedPeakHeapBytes)} estimated peak RAM, ${formatBytes(error.analysis.projectStorageBytes)} project storage.` });
          setReport([...nextReport]);
          break;
        }
        nextReport.push({
          id: `error-${index}-${job.file.name}`,
          tone: 'error',
          title: job.file.name,
          message: error instanceof Error ? error.message : 'Could not import this file.',
        });
      }
      setReport([...nextReport]);
    }

    setProgress(undefined);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
    if (imported.length > 0) onImported?.(imported);
  };

  const confirmPending = async () => {
    if (!pending || !allowHeavy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const batch = await importModelJob(pending.job, { mode, allowHeavy: true, extremeConfirmation: extremeText, signal: controller.signal, onProgress: (value) => setProgress(value.message) });
      if (!runDestructiveProjectMutation) throw new Error('Local recovery is still starting. Please wait before importing a model.');
      await runDestructiveProjectMutation('Before importing a model', () => {
        addImportedModels(batch.items);
      });
      onImported?.(batch.items.map((item) => item.object));
      setReport((items) => [...items, { id: `success-${pending.job.file.name}`, tone: 'success', title: pending.job.file.name, message: `Imported ${batch.summary.totalObjects} object${batch.summary.totalObjects === 1 ? '' : 's'} using binary-backed geometry.` }]);
      setPending(undefined);
      setExtremeText('');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setReport((items) => [...items, { id: `confirm-error-${pending.job.file.name}`, tone: 'error', title: pending.job.file.name, message: error instanceof Error ? error.message : 'Could not import this file.' }]);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  return (
    <Modal
      open={open}
      title="Import 3D scene"
      onClose={busy ? undefined : onClose}
      size="lg"
      scrollBody
      footer={(
        <>
          {busy && <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-lg border border-red-400 px-4 py-2 text-sm text-red-500">Cancel</button>}
          {pending && !busy && <button type="button" onClick={() => void confirmPending()} disabled={!allowHeavy || (pending.analysis.tier === 'extreme' && extremeText !== 'IMPORT')} className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{pending.analysis.tier === 'extreme' ? 'Import extreme scene' : 'Import heavy scene'}</button>}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-subtle px-4 py-2 text-sm text-secondary transition hover:text-primary disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            onClick={selectFiles}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-105 disabled:opacity-50"
            data-model-import-choose
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {busy ? 'Importing…' : 'Choose files'}
          </button>
        </>
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={MODEL_IMPORT_ACCEPT}
        className="sr-only"
        onChange={(event) => void importFiles(event.target.files)}
        data-model-import-input
      />

      <div className="space-y-4" data-model-import-dialog>
        <div className="rounded-xl border border-subtle bg-surface-muted p-4">
          <div className="flex gap-3">
            <Box className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <div className="space-y-2">
              <p className="text-sm font-semibold text-primary">Export from your DCC, then import the export</p>
              <ul className="list-disc pl-4 text-sm leading-relaxed text-secondary">
                <li><span className="font-medium text-primary">Blender:</span> File → Export → glTF 2.0 (.glb) – include the whole scene – apply export transforms if you want final world space.</li>
                <li><span className="font-medium text-primary">Maya:</span> File → Export All → FBX – include all visible objects in world space.</li>
                <li><span className="font-medium text-primary">Unreal:</span> File → Export All – export selected level or actors as GLB.</li>
              </ul>
              <p className="text-xs leading-relaxed text-secondary">
                Direct import formats: GLB, embedded glTF, FBX, OBJ, STL, PLY, .panoscene bundles. Materials, textures, cameras, lights, animation, rigs, and morphs are stripped. PanoRef keeps world-space placement, with hierarchy flattened.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-subtle p-3">
          <p className="text-sm font-semibold text-primary">How to import</p>
          <div className="mt-3 flex flex-col gap-2">
            <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${mode === 'separate' ? 'border-accent bg-accent-soft' : 'border-subtle hover:border-accent/50'}`}>
              <input
                type="radio"
                name="importMode"
                value="separate"
                checked={mode === 'separate'}
                onChange={() => setMode('separate')}
                className="mt-1"
                disabled={busy}
                data-import-mode="separate"
              />
              <div>
                <p className="text-sm font-medium text-primary">Keep objects separate (default)</p>
                <p className="mt-1 text-xs leading-relaxed text-secondary">One Mesh = one object. One InstancedMesh = one object containing all instances. No per-instance objects. Hierarchy not recreated – world transforms baked. Each object: position = center of world bounds, rotation [0,0,0], scale [1,1,1]. Selecting one chair selects that entire chair.</p>
              </div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${mode === 'combined' ? 'border-accent bg-accent-soft' : 'border-subtle hover:border-accent/50'}`}>
              <input
                type="radio"
                name="importMode"
                value="combined"
                checked={mode === 'combined'}
                onChange={() => setMode('combined')}
                className="mt-1"
                disabled={busy}
                data-import-mode="combined"
              />
              <div>
                <p className="text-sm font-medium text-primary">Combine into one object</p>
                <p className="mt-1 text-xs leading-relaxed text-secondary">All nodes are world-transformed into one asset and one object. Good for very heavy scenes or when you need a single collision/flow blocker.</p>
              </div>
            </label>
          </div>
        </div>

        <label className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
          <input type="checkbox" checked={allowHeavy} disabled={busy} onChange={(event) => setAllowHeavy(event.target.checked)} className="mt-1" data-allow-heavy-imports />
          <span><span className="text-sm font-semibold text-primary">Allow heavy imports</span><span className="mt-1 block text-xs leading-relaxed text-secondary">Heavy geometry can increase import time, project size, RAM and GPU use, save/load time, and the chance of a browser-tab crash.</span></span>
        </label>

        {pending && <ImportAnalysis analysis={pending.analysis} extremeText={extremeText} setExtremeText={setExtremeText} />}

        <div className="flex gap-3 rounded-xl border border-subtle px-4 py-3 text-sm text-secondary">
          <FileArchive className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p>
            Pipeline handoffs can use a <code className="text-primary">.panoscene</code> ZIP containing
            <code className="ml-1 text-primary">panoref-scene.json</code> and one geometry entry. Materials are still stripped.
          </p>
        </div>

        {progress && (
          <div className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-primary" role="status">
            <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
            {progress}
          </div>
        )}

        {report.length > 0 && (
          <div className="space-y-2 border-t border-subtle pt-4" aria-live="polite">
            <h3 className="text-sm font-semibold text-primary">Import report</h3>
            {report.map((item) => (
              <div key={item.id} className="flex gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm" data-model-import-report-item={item.tone}>
                {item.tone === 'success' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${item.tone === 'error' ? 'text-red-500' : 'text-amber-500'}`} />
                )}
                <div className="min-w-0">
                  <div className="truncate font-medium text-primary">{item.title}</div>
                  <div className="mt-0.5 leading-relaxed text-secondary">{item.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ImportAnalysis({ analysis, extremeText, setExtremeText }: { analysis: ModelImportAnalysis; extremeText: string; setExtremeText: (value: string) => void }) {
  return <div className="space-y-3 rounded-xl border border-amber-500/50 p-4" data-model-import-analysis>
    <div><p className="font-semibold text-primary">{analysis.tier === 'extreme' ? 'Extreme scene confirmation' : 'Heavy scene confirmation'}</p><p className="mt-1 text-sm text-secondary">{analysis.sourceFilename} · {(analysis.fileSize / 1048576).toFixed(1)} MB source · {analysis.meshNodeCount.toLocaleString()} mesh nodes · {analysis.instanceCount.toLocaleString()} instances</p></div>
    <div className="grid grid-cols-2 gap-2 text-sm text-secondary"><span>Loaded vertices: {analysis.loadedVertexCount.toLocaleString()}</span><span>Triangles: {analysis.triangleCount.toLocaleString()}</span><span>Peak JS heap: {formatBytes(analysis.estimatedPeakHeapBytes)}</span><span>GPU geometry: {formatBytes(analysis.gpuBytes)}</span><span>Packed asset: {formatBytes(analysis.packedBytes)}</span><span>Project storage: {formatBytes(analysis.projectStorageBytes)}</span></div>
    {analysis.warnings.map((warning) => <p key={warning} className="text-xs text-amber-600">{warning}</p>)}
    <div><p className="text-xs font-semibold text-primary">Largest mesh nodes</p><ol className="mt-1 list-decimal pl-5 text-xs text-secondary">{analysis.topMeshes.map((mesh) => <li key={mesh.path}>{mesh.name}: {mesh.vertices.toLocaleString()} vertices, {mesh.triangles.toLocaleString()} triangles</li>)}</ol></div>
    {analysis.tier === 'extreme' && <label className="block text-sm text-primary">Type <strong>IMPORT</strong> to continue<input value={extremeText} onChange={(event) => setExtremeText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} className="mt-1 block w-full rounded-lg border border-subtle bg-surface-muted px-3 py-2" data-extreme-import-confirmation /></label>}
  </div>;
}
