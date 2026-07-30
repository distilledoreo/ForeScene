import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  LoaderCircle,
  Sparkles,
} from 'lucide-react';
import type { BlueprintDiagnostic, SetBlueprint } from '../../domain/setBlueprint';
import type { CompiledSetBlueprint } from '../../engine/setBlueprintCompiler';
import { compileSetBlueprint } from '../../engine/setBlueprintCompiler';
import {
  ManualSetGenerationProvider,
  formatDiagnostic,
  generateValidatedSet,
  resolveSetGenerationProvider,
  type SetGenerationDetailLevel,
} from '../../engine/setGenerationProvider';
import { parseSetBlueprint } from '../../engine/setBlueprintValidation';
import { useProjectStore } from '../../state/useProjectStore';
import { Field, TextArea, TextInput, Select } from './Field';
import { Modal } from './Modal';

type DialogTab = 'describe' | 'paste';
type DialogStep = 'input' | 'review';

const DESCRIPTION_PLACEHOLDER = 'A compact Roman courtyard, approximately 14 × 10 meters, surrounded by stone walls. A central archway faces the capture origin, with columns on either side, a staircase at frame left, and enough open floor for four actors.';

export function SetGenerationDialog({
  open,
  onClose,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  onApply: (compiled: CompiledSetBlueprint) => Promise<void>;
}) {
  const currentSettings = useProjectStore((state) => state.project.settings);
  const [tab, setTab] = useState<DialogTab>('describe');
  const [step, setStep] = useState<DialogStep>('input');
  const [description, setDescription] = useState('');
  const [widthMeters, setWidthMeters] = useState('');
  const [depthMeters, setDepthMeters] = useState('');
  const [detailLevel, setDetailLevel] = useState<SetGenerationDetailLevel>('standard');
  const [constraints, setConstraints] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [objectQuery, setObjectQuery] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'error' | 'success' | 'info'; message: string }>();
  const [diagnostics, setDiagnostics] = useState<BlueprintDiagnostic[]>([]);
  const [warnings, setWarnings] = useState<BlueprintDiagnostic[]>([]);
  const [blueprint, setBlueprint] = useState<SetBlueprint>();
  const [compiled, setCompiled] = useState<CompiledSetBlueprint>();
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const provider = useMemo(() => resolveSetGenerationProvider(), []);
  const manualProvider = useMemo(() => new ManualSetGenerationProvider(), []);
  const canGenerateDirectly = provider.id !== 'manual';

  useEffect(() => {
    if (!open) return;
    setTab('describe');
    setStep('input');
    setStatus(undefined);
    setDiagnostics([]);
    setWarnings([]);
    setBlueprint(undefined);
    setCompiled(undefined);
    setBusy(false);
    setShowRawJson(false);
    setObjectQuery('');
    setCopiedPrompt(false);
  }, [open]);

  const resetToInput = () => {
    setStep('input');
    setBlueprint(undefined);
    setCompiled(undefined);
    setDiagnostics([]);
    setWarnings([]);
    setStatus(undefined);
  };

  const acceptBlueprint = (next: SetBlueprint, nextWarnings: BlueprintDiagnostic[]) => {
    const result = compileSetBlueprint(next, {
      preferenceSettings: {
        defaultShotWidth: currentSettings.defaultShotWidth,
        defaultShotHeight: currentSettings.defaultShotHeight,
        defaultShotFovDegrees: currentSettings.defaultShotFovDegrees,
        defaultCameraLensMm: currentSettings.defaultCameraLensMm,
        defaultCameraHeightMeters: currentSettings.defaultCameraHeightMeters,
        panoGoodMatchMeters: currentSettings.panoGoodMatchMeters,
        panoModerateMatchMeters: currentSettings.panoModerateMatchMeters,
        panoLetterboxExports169: currentSettings.panoLetterboxExports169,
      },
    });
    setBlueprint(next);
    setCompiled(result);
    setWarnings([...nextWarnings, ...result.warnings]);
    setDiagnostics([]);
    setStep('review');
    setStatus({
      tone: 'success',
      message: `Validated “${next.name}” with ${next.objects.length} objects. Review before applying.`,
    });
  };

  const reviewPastedJson = () => {
    setBusy(true);
    setStatus(undefined);
    try {
      const parsed = parseSetBlueprint(pasteText);
      setDiagnostics(parsed.errors);
      if (!parsed.blueprint) {
        setStatus({
          tone: 'error',
          message: parsed.errors[0]
            ? formatDiagnostic(parsed.errors[0])
            : 'Blueprint validation failed.',
        });
        return;
      }
      acceptBlueprint(parsed.blueprint, parsed.warnings);
    } finally {
      setBusy(false);
    }
  };

  const generateFromDescription = async () => {
    if (!description.trim()) {
      setStatus({ tone: 'error', message: 'Enter a set description first.' });
      return;
    }
    if (!canGenerateDirectly) {
      setStatus({
        tone: 'info',
        message: 'No generation endpoint is configured. Copy the prompt into an external model, then paste the JSON on the Paste tab.',
      });
      return;
    }
    setBusy(true);
    setStatus(undefined);
    setDiagnostics([]);
    try {
      const width = widthMeters.trim() ? Number(widthMeters) : undefined;
      const depth = depthMeters.trim() ? Number(depthMeters) : undefined;
      const result = await generateValidatedSet({
        provider,
        request: {
          description: description.trim(),
          approximateWidthMeters: Number.isFinite(width) ? width : undefined,
          approximateDepthMeters: Number.isFinite(depth) ? depth : undefined,
          detailLevel,
          constraints: constraints.trim() || undefined,
        },
      });
      setDiagnostics(result.parse.errors);
      if (!result.blueprint) {
        setStatus({
          tone: 'error',
          message: result.repaired
            ? 'Generation still failed validation after one repair attempt.'
            : 'Generation failed validation.',
        });
        return;
      }
      if (typeof result.rawOutputs[result.rawOutputs.length - 1] === 'string') {
        setPasteText(String(result.rawOutputs[result.rawOutputs.length - 1]));
      } else {
        setPasteText(JSON.stringify(result.blueprint, null, 2));
      }
      acceptBlueprint(result.blueprint, result.parse.warnings);
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Set generation failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const copyManualPrompt = async () => {
    const text = [
      manualProvider.getSystemPrompt(),
      '',
      '---',
      '',
      manualProvider.getUserPrompt({
        description: description.trim() || DESCRIPTION_PLACEHOLDER,
        approximateWidthMeters: widthMeters.trim() ? Number(widthMeters) : undefined,
        approximateDepthMeters: depthMeters.trim() ? Number(depthMeters) : undefined,
        detailLevel,
        constraints: constraints.trim() || undefined,
      }),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPrompt(true);
      setStatus({
        tone: 'success',
        message: 'System + user prompt copied. Paste into an external model, then use Paste blueprint JSON.',
      });
    } catch {
      setStatus({
        tone: 'error',
        message: 'Could not copy to the clipboard. Select and copy the prompt manually from Help docs.',
      });
    }
  };

  const applyCompiled = async () => {
    if (!compiled) return;
    setBusy(true);
    setStatus(undefined);
    try {
      await onApply(compiled);
      onClose();
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not create the generated project.',
      });
    } finally {
      setBusy(false);
    }
  };

  const objectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const object of blueprint?.objects ?? []) {
      counts.set(object.type, (counts.get(object.type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [blueprint]);

  const filteredObjects = useMemo(() => {
    const query = objectQuery.trim().toLowerCase();
    const objects = blueprint?.objects ?? [];
    if (!query) return objects;
    return objects.filter((object) => (
      object.name.toLowerCase().includes(query)
      || object.key.toLowerCase().includes(query)
      || object.type.toLowerCase().includes(query)
    ));
  }, [blueprint, objectQuery]);

  const sceneSize = compiled
    ? {
      width: compiled.bounds.max[0] - compiled.bounds.min[0],
      height: compiled.bounds.max[1] - compiled.bounds.min[1],
      depth: compiled.bounds.max[2] - compiled.bounds.min[2],
    }
    : undefined;

  return (
    <Modal
      open={open}
      title={step === 'review' ? 'Review generated set' : 'Generate set from description'}
      onClose={busy ? undefined : onClose}
      size="xl"
      scrollBody
      footer={step === 'review' ? (
        <>
          <button
            type="button"
            className="rounded-lg border border-subtle px-3 py-2 text-sm text-secondary transition hover:border-accent hover:text-accent"
            onClick={resetToInput}
            disabled={busy}
          >
            Back
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
            onClick={() => void applyCompiled()}
            disabled={busy || !compiled}
            data-set-generation-apply
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Create generated project
          </button>
        </>
      ) : (
        <button
          type="button"
          className="rounded-lg border border-subtle px-3 py-2 text-sm text-secondary transition hover:border-accent hover:text-accent"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
      )}
    >
      <div className="space-y-4" data-set-generation-dialog>
        {step === 'input' && (
          <>
            <div className="flex gap-2" role="tablist" aria-label="Set generation mode">
              <TabButton active={tab === 'describe'} onClick={() => setTab('describe')} data-set-generation-tab="describe">
                Describe
              </TabButton>
              <TabButton active={tab === 'paste'} onClick={() => setTab('paste')} data-set-generation-tab="paste">
                Paste blueprint JSON
              </TabButton>
            </div>

            {tab === 'describe' ? (
              <div className="space-y-3" data-set-generation-describe>
                <Field label="Set description">
                  <TextArea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={DESCRIPTION_PLACEHOLDER}
                    rows={5}
                    data-set-generation-description
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Approx. width (m)">
                    <TextInput
                      type="number"
                      min={1}
                      step={0.5}
                      value={widthMeters}
                      onChange={(event) => setWidthMeters(event.target.value)}
                      placeholder="14"
                    />
                  </Field>
                  <Field label="Approx. depth (m)">
                    <TextInput
                      type="number"
                      min={1}
                      step={0.5}
                      value={depthMeters}
                      onChange={(event) => setDepthMeters(event.target.value)}
                      placeholder="10"
                    />
                  </Field>
                  <Field label="Detail level">
                    <Select
                      value={detailLevel}
                      onChange={(event) => setDetailLevel(event.target.value as SetGenerationDetailLevel)}
                    >
                      <option value="simple">Simple</option>
                      <option value="standard">Standard</option>
                      <option value="detailed">Detailed</option>
                    </Select>
                  </Field>
                </div>
                <Field label="Optional constraints" hint="Spatial blocking only — not finished production design.">
                  <TextArea
                    value={constraints}
                    onChange={(event) => setConstraints(event.target.value)}
                    placeholder="Keep walls under 3.5 m. Leave a clear 4×4 m center."
                    rows={2}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  {canGenerateDirectly ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                      onClick={() => void generateFromDescription()}
                      disabled={busy}
                      data-set-generation-generate
                    >
                      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      Generate blueprint
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm font-semibold text-secondary transition hover:border-accent hover:text-accent disabled:opacity-50"
                    onClick={() => void copyManualPrompt()}
                    disabled={busy}
                    data-set-generation-copy-prompt
                  >
                    <Copy className="h-4 w-4" />
                    {copiedPrompt ? 'Prompt copied' : 'Copy prompt for external model'}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm text-secondary transition hover:border-accent hover:text-accent"
                    onClick={() => setTab('paste')}
                  >
                    <ClipboardPaste className="h-4 w-4" />
                    Paste JSON next
                  </button>
                </div>
                {!canGenerateDirectly && (
                  <p className="text-xs text-muted">
                    ForeScene stays local-first: copy the prompt into any frontier model, then paste the JSON result.
                    Optional direct generation uses a server-side endpoint when configured.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3" data-set-generation-paste>
                <Field label="Blueprint JSON" hint="Paste model output. Markdown fences and surrounding prose are tolerated, then validated.">
                  <TextArea
                    value={pasteText}
                    onChange={(event) => setPasteText(event.target.value)}
                    placeholder='{ "schemaVersion": 1, "name": "…", "units": "meters", "objects": [ … ] }'
                    rows={12}
                    className="font-mono text-xs"
                    data-set-generation-paste-input
                  />
                </Field>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                  onClick={reviewPastedJson}
                  disabled={busy || !pasteText.trim()}
                  data-set-generation-review
                >
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Validate and review
                </button>
              </div>
            )}
          </>
        )}

        {step === 'review' && blueprint && compiled && (
          <div className="space-y-4" data-set-generation-review>
            <div className="rounded-xl border border-subtle bg-surface-muted/40 p-3 text-sm text-secondary">
              <p className="font-semibold text-primary">{blueprint.name}</p>
              {blueprint.description ? <p className="mt-1 text-xs leading-relaxed">{blueprint.description}</p> : null}
              <p className="mt-2 text-xs text-muted">
                The generated set opens as a new project. The current project is saved as a recovery point.
                No AI output is trusted until it passes validation.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <SummaryStat label="Objects" value={String(blueprint.objects.length)} />
              <SummaryStat label="Landmarks" value={String(blueprint.landmarks?.length ?? 0)} />
              <SummaryStat
                label="Approx. size (W×D×H)"
                value={sceneSize
                  ? `${sceneSize.width.toFixed(1)} × ${sceneSize.depth.toFixed(1)} × ${sceneSize.height.toFixed(1)} m`
                  : '—'}
              />
              <SummaryStat
                label="Pano origin"
                value={`[${compiled.project.scene.panoOrigin.map((n) => n.toFixed(2)).join(', ')}]`}
              />
            </div>

            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Objects by type</p>
              <div className="flex flex-wrap gap-2">
                {objectCounts.map(([type, count]) => (
                  <span key={type} className="rounded-md border border-subtle px-2 py-1 text-xs text-secondary">
                    {type}: {count}
                  </span>
                ))}
              </div>
            </div>

            {blueprint.assumptions && blueprint.assumptions.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Assumptions</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-secondary">
                  {blueprint.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-secondary">
                <p className="mb-1 font-semibold text-primary">Warnings</p>
                <ul className="space-y-1">
                  {warnings.map((warning) => (
                    <li key={`${warning.code}-${warning.path ?? warning.key ?? warning.message}`}>
                      {formatDiagnostic(warning)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <Field label="Search objects">
                <TextInput
                  value={objectQuery}
                  onChange={(event) => setObjectQuery(event.target.value)}
                  placeholder="Filter by name, key, or type"
                  data-set-generation-object-search
                />
              </Field>
              <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-subtle divide-y divide-subtle">
                {filteredObjects.map((object) => (
                  <li key={object.key} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="truncate text-primary">{object.name}</span>
                    <span className="shrink-0 text-xs text-muted">{object.type}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <button
                type="button"
                className="text-xs font-semibold text-accent underline-offset-2 hover:underline"
                onClick={() => setShowRawJson((value) => !value)}
                data-set-generation-raw-toggle
              >
                {showRawJson ? 'Hide raw JSON' : 'Show raw JSON'}
              </button>
              {showRawJson && (
                <pre
                  className="mt-2 max-h-56 overflow-auto rounded-lg border border-subtle bg-surface-muted/50 p-3 font-mono text-[11px] leading-relaxed text-secondary"
                  data-set-generation-raw-json
                >
                  {JSON.stringify(blueprint, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}

        {diagnostics.length > 0 && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm" role="alert">
            <p className="mb-1 flex items-center gap-2 font-semibold text-primary">
              <AlertTriangle className="h-4 w-4" />
              Validation errors
            </p>
            <ul className="space-y-1 text-secondary">
              {diagnostics.map((diagnostic) => (
                <li key={`${diagnostic.code}-${diagnostic.path ?? diagnostic.key ?? diagnostic.message}`}>
                  {formatDiagnostic(diagnostic)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {status && (
          <p
            className={`text-sm ${
              status.tone === 'error'
                ? 'text-rose-600 dark:text-rose-300'
                : status.tone === 'success'
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-secondary'
            }`}
            role={status.tone === 'error' ? 'alert' : 'status'}
            data-set-generation-status={status.tone}
          >
            {status.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
        active
          ? 'bg-accent-soft text-accent'
          : 'border border-subtle text-secondary hover:border-accent hover:text-accent'
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-subtle px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-primary">{value}</p>
    </div>
  );
}
