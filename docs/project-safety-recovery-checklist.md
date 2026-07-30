# Project Safety & Recovery

This checklist defines the reliability completion bar for ForeScene. A checked
item has implementation and regression coverage; it is not merely planned.

## Durable project revisions

- [x] Persist the active project locally, independently of downloaded backups.
- [x] Write every save as a staged immutable revision and promote one active
  pointer only after validation succeeds.
- [x] Keep the previous known-good revision when a write, validation, or quota
  check fails.
- [x] Test every retained recovery point newest-first (active, previous,
  snapshots, then older autosaves) before abandoning a project head.
- [x] Validate every persisted raster/video/model payload before it can replace
  the active revision.
- [x] Store SHA-256 and byte-length metadata for every new recovery binary and
  re-check it after write, during recovery, and in Project Health.
- [x] Never make a current project unusable because an import, save, or asset
  write was interrupted or partially completed.
- [x] Replace fire-and-forget asset persistence with observable failures.

## Autosave and recovery

- [x] Add serialized, debounced continuous autosave.
- [x] Show Saved, Saving, Unsaved, Failed, and Recovered state in the app.
- [x] Recover the latest verified project automatically after a refresh, crash,
  or browser closure.
- [x] Protect critical commits from accidental navigation or browser close.
- [x] Check available browser storage before large writes and explain quota
  failures without implying that the prior project is damaged.
- [x] Request browser persistent storage and show whether the browser granted
  it; a denial is a storage-risk warning rather than a false durability claim.

## Snapshots and rollback

- [x] Create automatic recovery points before project import, panorama/model
  replacement, migration, deletion, and major settings changes.
- [x] Commit the pre-change recovery point before each confirmed destructive
  UI mutation, then save the changed project as a separate revision.
- [x] Allow manual snapshots with a timestamp and reason.
- [x] Retain the latest ten snapshots plus a rolling set of autosave revisions.
- [x] Restore a verified prior snapshot without deleting the current revision.
- [x] Show a restorable revision timeline for milestones, automatic recovery
  points, and autosaves, including the active and previous-known-good entries.

## Health, storage, and backups

- [x] Add a Project Health scan for missing assets, orphaned blobs, duplicate or
  inconsistent IDs, legacy data, invalid cameras, panorama relationship errors,
  missing expected shot media, and unresolved source media.
- [x] Offer only deterministic, safe repairs and create a recovery point before
  applying one.
- [x] Show current project size, browser storage used/remaining, largest assets,
  essential versus temporary data, and save completion time.
- [x] Export a validated portable project backup.
- [x] Validate an imported backup before it replaces the active project.
- [x] Include an integrity manifest in newly generated binary backups so
  validation detects same-length payload tampering.
- [x] List retained local project histories and allow intentional opening or
  removal with revision-aware binary cleanup.

## Consistency and destructive operations

- [x] Make reopen, still/video rendering, and package export resolve the same
  canonical project revision and asset references.
- [x] Reload the exact committed revision after a flush and use that immutable
  object for every still, video, package, and project-backup export.
- [x] Remove destructive asset cleanup from export/download paths.
- [x] Preserve deleted/replaced project data through retained revisions and
  provide a clear rollback path.
- [x] Confirm destructive operations with their affected-shot/asset impact.
- [x] Defer physical cleanup until retained revisions no longer reference data.

## Verification gates

- [x] Exercise failure injection for interrupted saves, failed IndexedDB writes,
  missing blobs, and quota errors.
- [x] Verify import failure leaves the previously active project recoverable.
- [x] Verify autosave/recovery and snapshot restore in a browser runtime path.
- [x] Verify backup round-trip preserves project structure and binary assets.
- [x] Verify recovery fallback past two broken head revisions, destructive
  transaction ordering, same-length binary corruption, and cleanup warnings.
- [x] Run targeted tests, type checking, production build, and a final checklist
  audit before declaring this milestone complete.
