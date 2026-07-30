# ForeScene Agent API

ForeScene exposes a browser Agent API on `window.foreScene` so CLI coding agents can inspect (and later mutate) the open project without clicking through the UI.

Playwright hosts and observes the browser. The Agent API performs exact project reads and (in later milestones) protected mutations.

## Status

**Milestone 1 — read-only vertical slice** ✓  
**Milestone 2 — plan validation and preview** ✓  
**Milestone 3 — atomic apply + undo** ✓  
**Milestone 4 — shot staging commands** ✓  
**Milestone 5 — visual CLI (screenshot / run)** ✓

Available now:

- Inspection, preview, atomic apply/undo
- Shot staging: `shot.stageObject`, `shot.clearStaging`, `shot.copyStagingToNext`, rename/description/select/camera
- `npm run agent:screenshot` / `agent:verify` / `agent:run`

## Quick start

```bash
npm run dev
npm run agent:inspect
```

JSON is written to stdout. Diagnostics and progress go to stderr.

## Permission model

| Mode | Inspection | Mutations |
|------|------------|-----------|
| `off` | blocked | blocked |
| `read-only` (default) | allowed | blocked (`write_access_required`) |
| `read-write` | allowed | allowed when implemented |

Write access is session-oriented:

- Enabling write access from the UI does **not** persist across reloads.
- A dedicated CLI profile may seed `localStorage['forescene-agent-control'] = 'read-write'` before launch.
- The header shows **Agent control active** with a **Stop** button that immediately returns to read-only and clears the CLI seed.

## Status shape

```json
{
  "ready": true,
  "apiVersion": 1,
  "controlMode": "read-only",
  "writeAccess": false,
  "projectLoaded": true,
  "projectId": "...",
  "projectName": "...",
  "workspace": "build",
  "revisionId": "...",
  "projectUpdatedAt": "...",
  "busy": {
    "criticalWrite": false,
    "grayboxRender": false,
    "packageExport": false
  },
  "persistence": {
    "ready": true,
    "status": "saved"
  }
}
```

## Export planning

`createExportPlan({ shotIds?: string[] })` calls the same pure `createExportPlan()` engine used by the Export workspace. It does not render or download anything.

When `shotIds` is omitted, every shot is planned (matching the Export workspace default selection).

## Preview

`previewPlan` works in read-only mode. It never writes the live project.

Supported commands in this milestone:

- `project.updateInfo`
- `object.create` / `object.update` / `object.delete` / `object.duplicate`
- `shot.create` / `shot.updateCamera` / `shot.stageObject` / `shot.clearStaging`
- `workspace.open` / `selection.set`

Plan-local `ref` values bind created entities so later commands can target them. Ambiguous name queries return `ambiguous_target` with candidate ids and abort the whole plan.

Optional `expectedFingerprint` (from a prior inspect/preview) rejects stale projects.

## Apply and undo

`applyPlan` requires read-write mode. It:

1. Prepares the plan on a clone (same path as preview)
2. Confirms the live fingerprint is unchanged
3. Calls `runDestructiveProjectMutation()` (pre-change recovery snapshot)
4. Replaces project + selection/workspace in one Zustand `setState`
5. Records an in-memory history entry for `undoLastPlan()`

`undoLastPlan()` restores the preceding project only when the current fingerprint still matches the applied result. Manual edits after apply refuse undo.

Enable writes from the Project menu (**Enable Agent Writes**) or CLI `--write`. The header badge **Stop** button immediately returns to read-only.

## Shot staging

Supported shot commands:

- `shot.create` / `shot.rename` / `shot.updateDescription` / `shot.updateCamera`
- `shot.select` / `shot.copyStagingToNext`
- `shot.stageObject` (transform, visible, humanPose, posePreset)
- `shot.clearStaging` (`clearPoseOnly` keeps transform/visibility)

Staging never mutates Build scene objects. Absolute overrides are idempotent.

## Visual CLI

```bash
npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
npm run agent:run -- --plan plans/conversation.preview.json --screenshot artifacts/conversation.png --write
```

## Deferred / not in this milestone

- Landmark create/update/delete commands
- Export configuration writes
- Package download control
- Selected-keyframe transient staging
- In-app Agent Console
