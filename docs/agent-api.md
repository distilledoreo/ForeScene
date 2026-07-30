# ForeScene Agent API

ForeScene exposes a browser Agent API on `window.foreScene` so CLI coding agents can inspect (and later mutate) the open project without clicking through the UI.

Playwright hosts and observes the browser. The Agent API performs exact project reads and (in later milestones) protected mutations.

## Status

**Milestone 1 — read-only vertical slice** ✓  
**Milestone 2 — plan validation and preview** ✓

Available now:

- Inspection APIs from milestone 1
- `previewPlan(plan)` — parse, resolve refs, apply on a `structuredClone`, return summary/diff
- `npm run agent:preview -- --plan path/to/plan.json`

Mutations (`applyPlan` / `undoLastPlan`) still require write access and return `not_implemented` until the atomic-commit milestone.

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

## Deferred / not in this milestone

- Atomic `applyPlan` / `undoLastPlan` commits
- Landmark create/update/delete commands
- Export configuration writes
- Package download control
- Viewport capture runtime services
- In-app Agent Console
