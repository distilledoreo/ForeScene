import React from 'react';
import { Plus, X } from 'lucide-react';
import type { LocationProject, Shot } from '../../domain/types';
import { isShotFramingAccepted } from '../../engine/workflow';
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
  onAddShot?: () => void;
}

/** Shot library sheet — camera-roll list for the Shots workspace. */
export function ShotsLibrary({
  open,
  onClose,
  project,
  selectedShotId,
  onOpenShot,
  onRenameShot,
  onRequestDelete,
  onOpenMedia,
  onAddShot,
}: ShotsLibraryProps) {
  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col justify-end bg-black/50 backdrop-blur-[2px]"
      data-shots-library
      role="dialog"
      aria-label="Shot library"
      onClick={onClose}
    >
      <div
        className="rounded-t-3xl border border-white/10 bg-zinc-950/95 px-4 pb-8 pt-3 shadow-soft"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Shots</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
            aria-label="Close shot library"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" data-shots-library-roll>
          {project.shots.map((shot) => {
            const selected = shot.id === selectedShotId;
            const landed = isShotFramingAccepted(project, shot.id);
            const canDelete = project.shots.length > 1;
            return (
              <div key={shot.id}>
                <ShotsLibraryCard
                  project={project}
                  shot={shot}
                  selected={selected}
                  landed={landed}
                  canDelete={canDelete}
                  sheetOpen={open}
                  onOpenMedia={onOpenMedia}
                  onOpenShot={onOpenShot}
                  onRename={onRenameShot}
                  onRequestDelete={onRequestDelete}
                />
              </div>
            );
          })}
          {onAddShot && (
            <button
              type="button"
              onClick={onAddShot}
              className="inline-flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/25 text-white/80 transition hover:border-[var(--accent)] hover:text-accent"
              data-shots-library-new
            >
              <Plus className="h-5 w-5" />
              <span className="text-[10px] font-semibold">New</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
