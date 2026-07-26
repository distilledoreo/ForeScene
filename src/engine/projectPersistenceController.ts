import type { LocationProject } from '../domain/types';
import {
  createProjectSnapshot,
  saveProjectRevision,
  type ProjectSaveStatus,
} from './projectSafety';
import type { ProjectRevisionKind } from './projectRevisionStore';

export interface ProjectPersistenceState {
  status: ProjectSaveStatus;
  message?: string;
  lastSavedAt?: string;
  activeRevisionId?: string;
  criticalWrite: boolean;
}

export interface ProjectPersistenceControllerOptions {
  onStateChange: (state: ProjectPersistenceState) => void;
  debounceMs?: number;
}

interface PendingSnapshot {
  project: LocationProject;
  reason: string;
}

const DEFAULT_DEBOUNCE_MS = 700;

function cloneProject(project: LocationProject): LocationProject {
  return structuredClone(project);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Returns a human-readable pre-change recovery point for meaningful risks. */
export function getAutomaticSnapshotReason(previous: LocationProject, next: LocationProject): string | undefined {
  if (previous.id !== next.id) return 'Before opening another project';
  if (next.scene.objects.length < previous.scene.objects.length) return 'Before deleting scene objects';
  if (next.shots.length < previous.shots.length) return 'Before deleting a shot';
  if (next.panoRefs.length < previous.panoRefs.length) return 'Before deleting a panorama reference';

  const previousPanos = new Map(previous.panoRefs.map((pano) => [pano.id, pano]));
  if (next.panoRefs.some((pano) => {
    const prior = previousPanos.get(pano.id);
    return prior && prior.imageAssetId !== pano.imageAssetId;
  })) {
    return 'Before replacing a panorama';
  }
  const previousCanonical = previous.panoRefs.find((pano) => pano.isCanonical);
  const nextCanonical = next.panoRefs.find((pano) => pano.isCanonical);
  if (previousCanonical?.imageAssetId !== nextCanonical?.imageAssetId && (previousCanonical || nextCanonical)) {
    return 'Before replacing a panorama';
  }

  const previousModels = new Map(previous.scene.objects.map((object) => [object.id, object.modelAssetId]));
  if (next.scene.objects.some((object) => previousModels.has(object.id) && previousModels.get(object.id) !== object.modelAssetId)) {
    return 'Before replacing imported model data';
  }
  if (next.scene.objects.some((object) => object.type === 'imported_model' && !previousModels.has(object.id))) {
    return 'Before importing a model';
  }

  if (Object.keys(next.assets.assets).length < Object.keys(previous.assets.assets).length) {
    return 'Before removing saved project media';
  }
  if (!sameJson(previous.settings, next.settings)) return 'Before major project settings change';
  return undefined;
}

/**
 * Serializes all local revisions. It deliberately snapshots the prior state
 * before a destructive transition, then saves the latest state. A later
 * change while a write is active stays marked Unsaved and is queued after the
 * active transaction finishes.
 */
export class ProjectPersistenceController {
  private readonly onStateChange: (state: ProjectPersistenceState) => void;
  private readonly debounceMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private queued = Promise.resolve();
  private latestProject?: LocationProject;
  private pendingSave = false;
  private hasUnsavedChanges = false;
  private pendingSnapshots: PendingSnapshot[] = [];
  private lastAutomaticSnapshotAtByReason = new Map<string, number>();
  private ignoredProject?: LocationProject;
  private disposed = false;

  constructor(options: ProjectPersistenceControllerOptions) {
    this.onStateChange = options.onStateChange;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  start(project: LocationProject, options: { recovered?: boolean; revisionId?: string; savedAt?: string } = {}): void {
    this.latestProject = project;
    if (options.recovered) {
      this.emit({
        status: 'recovered',
        message: 'Recovered the latest verified local project.',
        lastSavedAt: options.savedAt,
        activeRevisionId: options.revisionId,
        criticalWrite: false,
      });
      return;
    }
    this.markUnsaved('Saving this project locally for recovery.');
  }

  ignoreNextProjectChange(project: LocationProject): void {
    this.ignoredProject = project;
  }

  /** Adopt an already verified revision (for recovery or rollback) without re-saving it. */
  adoptVerifiedProject(
    project: LocationProject,
    options: { revisionId: string; savedAt: string; message: string; recovered?: boolean },
  ): void {
    this.latestProject = project;
    this.ignoredProject = project;
    this.pendingSave = false;
    this.hasUnsavedChanges = false;
    this.pendingSnapshots = [];
    this.clearTimer();
    this.emit({
      status: options.recovered ? 'recovered' : 'saved',
      message: options.message,
      lastSavedAt: options.savedAt,
      activeRevisionId: options.revisionId,
      criticalWrite: false,
    });
  }

  noteProjectChange(next: LocationProject, previous: LocationProject): void {
    if (this.disposed) return;
    this.latestProject = next;
    if (this.ignoredProject === next) {
      this.ignoredProject = undefined;
      return;
    }
    const reason = getAutomaticSnapshotReason(previous, next);
    if (reason && this.shouldCreateAutomaticSnapshot(reason)) {
      this.pendingSnapshots.push({ project: cloneProject(previous), reason });
    }
    this.markUnsaved();
  }

  async commitProject(
    project: LocationProject,
    options: { kind?: ProjectRevisionKind; reason?: string } = {},
  ): Promise<void> {
    if (this.disposed) return;
    this.latestProject = project;
    this.pendingSave = false;
    this.clearTimer();
    await this.enqueue(async () => {
      await this.writeProject(project, options.kind ?? 'autosave', options.reason ?? 'Manual save');
    });
  }

  async createSnapshot(project: LocationProject, reason = 'Manual snapshot'): Promise<void> {
    if (this.disposed) return;
    this.clearTimer();
    await this.enqueue(async () => {
      this.emit({ status: 'saving', message: 'Creating a recovery snapshot…', criticalWrite: true });
      const result = await createProjectSnapshot(project, reason);
      this.emit({
        status: 'saved',
        message: 'Recovery snapshot created.',
        lastSavedAt: result.revision.createdAt,
        activeRevisionId: result.revision.id,
        criticalWrite: false,
      });
    });
  }

  async flush(reason = 'Manual save'): Promise<void> {
    if (this.disposed) return;
    this.clearTimer();
    if (!this.latestProject) return;
    this.pendingSave = true;
    await this.enqueue(() => this.persistPending(reason));
  }

  get hasPendingChanges(): boolean {
    return this.hasUnsavedChanges || this.pendingSave || this.pendingSnapshots.length > 0;
  }

  /** Surface a background asset-cache failure instead of hiding it from users. */
  reportAssetPersistenceFailure(error: unknown): void {
    if (this.disposed) return;
    this.hasUnsavedChanges = true;
    this.emit({
      status: 'failed',
      message: error instanceof Error
        ? `A new asset could not be written locally: ${error.message} The previous verified save remains available.`
        : 'A new asset could not be written locally. The previous verified save remains available.',
      criticalWrite: false,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private markUnsaved(message = 'Changes are waiting to be saved locally.'): void {
    this.hasUnsavedChanges = true;
    this.pendingSave = true;
    this.emit({ status: 'unsaved', message, criticalWrite: false });
    this.schedule();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.persistPending('Automatic save')).catch(() => undefined);
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private shouldCreateAutomaticSnapshot(reason: string): boolean {
    if (this.pendingSnapshots.some((snapshot) => snapshot.reason === reason)) return false;
    // Settings can emit dozens of slider updates in one interaction. Keep the
    // first pre-change state, then rely on normal revisions until a new
    // meaningful settings session begins.
    if (reason !== 'Before major project settings change') return true;
    const now = Date.now();
    const previous = this.lastAutomaticSnapshotAtByReason.get(reason) ?? 0;
    if (now - previous < 60_000) return false;
    this.lastAutomaticSnapshotAtByReason.set(reason, now);
    return true;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queued.then(work, work);
    this.queued = next.catch(() => undefined);
    return next.catch((error) => {
      this.hasUnsavedChanges = true;
      this.pendingSave = false;
      this.pendingSnapshots = [];
      this.emit({
        status: 'failed',
        message: error instanceof Error
          ? `${error.message} The previous verified save remains available.`
          : 'Could not save locally. The previous verified save remains available.',
        criticalWrite: false,
      });
      throw error;
    });
  }

  private async persistPending(reason: string): Promise<void> {
    if (!this.pendingSave || !this.latestProject) return;
    const snapshots = this.pendingSnapshots.splice(0);
    const project = this.latestProject;
    this.pendingSave = false;

    for (const snapshot of snapshots) {
      this.emit({ status: 'saving', message: 'Creating an automatic recovery point…', criticalWrite: true });
      await createProjectSnapshot(snapshot.project, snapshot.reason);
    }

    await this.writeProject(project, 'autosave', reason);
    if (this.latestProject !== project || this.pendingSave) {
      this.hasUnsavedChanges = true;
      this.emit({ status: 'unsaved', message: 'Newer changes are waiting to be saved locally.', criticalWrite: false });
      this.schedule();
    }
  }

  private async writeProject(project: LocationProject, kind: ProjectRevisionKind, reason: string): Promise<void> {
    this.emit({ status: 'saving', message: 'Saving a verified local revision…', criticalWrite: true });
    const result = await saveProjectRevision(project, { kind, reason });
    this.hasUnsavedChanges = this.latestProject !== project || this.pendingSave;
    this.emit({
      status: 'saved',
      message: 'Saved locally and ready for recovery.',
      lastSavedAt: result.revision.createdAt,
      activeRevisionId: result.revision.id,
      criticalWrite: false,
    });
  }

  private emit(state: ProjectPersistenceState): void {
    if (!this.disposed) this.onStateChange(state);
  }
}
