import React from 'react';
import type { LocationProject, Shot } from '../../domain/types';
import { ShotsLibraryCard } from '../common/ShotsLibraryCard';

export interface ShotsLibraryProps {
  open: boolean;
  onClose: () => void;
  project: LocationProject;
  selectedShotId?: string;
  onOpenShot: (shotId: string) => void;
  onRenameShot: (shotId: string, updates: { productionShotId?: string; name: string }) => void;
  onRequestDelete: (shot: Shot) => void;
  onOpenMedia: (shotId: string) => void;
}

/** Shot library drawer — camera-roll list for the Shots workspace. */
export function ShotsLibrary({
  open,
  onClose,
  project,
  selectedShotId,
  onOpenShot,
  onRenameShot,
  onRequestDelete,
  onOpenMedia,
}: ShotsLibraryProps) {
  if (!open) return null;

  return (
    <div
      data-shots-library
      className="absolute inset-0 z-40 flex justify-end bg-black/40"
      role="dialog"
      aria-label="Shot library"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close shot library backdrop"
        onClick={onClose}
      />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col bg-[var(--panel)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Shot library</h2>
          <button
            type="button"
            className="rounded px-2 py-1 text-sm text-[var(--muted)] hover:bg-[var(--hover)]"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {project.shots.map((shot) => (
            <div key={shot.id}>
              <ShotsLibraryCard
                project={project}
                shot={shot}
                selected={shot.id === selectedShotId}
                landed={Boolean(shot.assets.viewportRenderAssetId || shot.cameraKeyframes?.length)}
                canDelete={project.shots.length > 1}
                sheetOpen={open}
                onOpenShot={onOpenShot}
                onRename={onRenameShot}
                onRequestDelete={onRequestDelete}
                onOpenMedia={onOpenMedia}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
