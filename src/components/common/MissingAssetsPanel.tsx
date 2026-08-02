import React, { useRef, useState } from 'react';
import { AlertTriangle, FolderSearch, Link2, Trash2, Upload } from 'lucide-react';
import type { LocationProject, ProjectAsset } from '../../domain/types';
import { matchMissingAssetCandidates, type AssetCandidateMatch } from '../../engine/assetRelinking';
import { getAssetInstanceIds, getAssetShotIds, listMissingProjectAssets } from '../../engine/projectAssetRecovery';
import { relinkModelAssetIntoProject } from '../../engine/modelImportService';
import { touchProject } from '../../state/slices/touchProject';
import { useProjectStore } from '../../state/useProjectStore';

type Mutation = (reason: string, mutation: () => void) => Promise<unknown>;

export function MissingAssetsPanel({
  project,
  runDestructiveProjectMutation,
}: {
  project: LocationProject;
  runDestructiveProjectMutation?: Mutation;
}) {
  const assets = listMissingProjectAssets(project);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<{ assetId: string; mode: 'locate' | 'replace' } | undefined>(undefined);
  const [candidates, setCandidates] = useState<Record<string, AssetCandidateMatch[]>>({});
  const [message, setMessage] = useState<string>();

  if (assets.length === 0) return null;

  const chooseFile = (asset: ProjectAsset, mode: 'locate' | 'replace') => {
    actionRef.current = { assetId: asset.id, mode };
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  };

  const relink = async (assetId: string, file: File, mode: 'locate' | 'replace') => {
    try {
      await relinkModelAssetIntoProject(file, assetId, { mode });
      setMessage(`${mode === 'locate' ? 'Located' : 'Replaced'} ${file.name}.`);
      setCandidates((current) => ({ ...current, [assetId]: [] }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not relink that asset.');
    }
  };

  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const action = actionRef.current;
    if (file && action) void relink(action.assetId, file, action.mode);
  };

  const onFolder = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    const next: Record<string, AssetCandidateMatch[]> = {};
    for (const asset of assets) next[asset.id] = await matchMissingAssetCandidates(asset, files);
    setCandidates(next);
    setMessage(files.length > 0 ? `Found ${files.length} candidate file${files.length === 1 ? '' : 's'}.` : 'No files found.');
  };

  const removeAsset = async (asset: ProjectAsset) => {
    if (!runDestructiveProjectMutation) return;
    if (typeof window !== 'undefined' && !window.confirm(`Remove ${asset.name} and its unresolved instances?`)) return;
    try {
      await runDestructiveProjectMutation('Remove missing asset', () => {
        useProjectStore.setState((state) => {
          const nextAssets = { ...state.project.assets.assets };
          delete nextAssets[asset.id];
          return {
            project: touchProject({
              ...state.project,
              assets: { assets: nextAssets },
              scene: {
                ...state.project.scene,
                objects: state.project.scene.objects.filter((object) => object.modelAssetId !== asset.id),
              },
            }),
            selectedObjectIds: state.selectedObjectIds.filter((id) => state.project.scene.objects.some((object) => object.id === id && object.modelAssetId !== asset.id)),
          };
        });
      });
      setMessage(`Removed ${asset.name} and its unresolved instances.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not remove the missing asset.');
    }
  };

  return (
    <div className="pointer-events-auto absolute left-3 right-3 top-3 z-20 mx-auto max-w-2xl rounded-xl border border-amber-400/60 bg-amber-50/95 p-3 text-amber-950 shadow-soft backdrop-blur" data-missing-assets-panel>
      <input ref={inputRef} type="file" accept=".glb,.gltf,.obj,.stl,.ply,.fbx" className="hidden" onChange={onFile} />
      <input ref={folderInputRef} type="file" multiple className="hidden" onChange={onFolder} {...({ webkitdirectory: 'true' } as Record<string, string>)} />
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold">Missing Assets ({assets.length})</div>
          <div className="mt-0.5 text-[11px] text-amber-900/80">The scene is still editable. Relink a source file or keep these placeholders.</div>
        </div>
        <button type="button" onClick={() => folderInputRef.current?.click()} className="inline-flex items-center gap-1 rounded-lg border border-amber-700/30 px-2 py-1 text-[11px] font-semibold hover:bg-amber-100"><FolderSearch className="h-3.5 w-3.5" /> Search folder</button>
      </div>
      <div className="mt-2 space-y-2">
        {assets.map((asset) => (
          <div key={asset.id} className="rounded-lg border border-amber-300/70 bg-white/50 p-2" data-missing-asset-id={asset.id}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">{asset.originalFileName ?? asset.name}</span>
              <button type="button" onClick={() => chooseFile(asset, 'locate')} className="inline-flex items-center gap-1 rounded border border-amber-700/30 px-2 py-1 text-[10px] font-semibold"><Link2 className="h-3 w-3" /> Locate File</button>
              <button type="button" onClick={() => chooseFile(asset, 'replace')} className="inline-flex items-center gap-1 rounded border border-amber-700/30 px-2 py-1 text-[10px] font-semibold"><Upload className="h-3 w-3" /> Replace Asset</button>
              <button type="button" onClick={() => setMessage(`Keeping the placeholder for ${asset.name}.`)} className="rounded border border-amber-700/30 px-2 py-1 text-[10px] font-semibold">Keep Placeholder</button>
              <button type="button" onClick={() => void removeAsset(asset)} title="Remove asset and unresolved instances" className="rounded border border-red-300 px-2 py-1 text-red-700"><Trash2 className="h-3 w-3" /></button>
            </div>
            <div className="mt-1 text-[10px] text-amber-900/80">
              {asset.type} · {formatAssetBytes(asset.byteSize)} · Used by {getAssetInstanceIds(project, asset.id).length} instance{getAssetInstanceIds(project, asset.id).length === 1 ? '' : 's'} across {getAssetShotIds(project, asset.id).length} shot{getAssetShotIds(project, asset.id).length === 1 ? '' : 's'} · Status: {asset.resolutionStatus ?? 'unavailable'}
            </div>
            {(candidates[asset.id] ?? []).length > 0 && <div className="mt-1 text-[10px] text-amber-900">Candidates: {(candidates[asset.id] ?? []).slice(0, 3).map((candidate) => <button key={candidate.file.name} type="button" onClick={() => void relink(asset.id, candidate.file, candidate.confidence === 'hash' ? 'locate' : 'replace')} className="ml-1 underline">{candidate.file.name}</button>)}</div>}
          </div>
        ))}
      </div>
      {message && <div className="mt-2 text-[10px] text-amber-900/80" role="status">{message}</div>}
    </div>
  );
}

function formatAssetBytes(byteSize?: number): string {
  if (byteSize === undefined || !Number.isFinite(byteSize)) return 'size unknown';
  if (byteSize < 1024 * 1024) return `${Math.max(1, Math.round(byteSize / 1024))} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}
