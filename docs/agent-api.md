# ForeScene Agent API

ForeScene exposes a browser Agent API on `window.foreScene` so CLI coding agents can inspect (and later mutate) the open project without clicking through the UI.

Playwright hosts and observes the browser. The Agent API performs exact project reads and (in later milestones) protected mutations.

## Status

**Milestone 1 — read-only vertical slice**

Available now:

- `getStatus()` / `getCapabilities()`
- `inspectProject()` / `listObjects()` / `inspectObject()`
- `listShots()` / `inspectShot()` / `listLandmarks()`
- `createExportPlan()`
- `setControlMode()`
- `waitForIdle()`
- Mutation stubs (`previewPlan`, `applyPlan`, `undoLastPlan`) that return `write_access_required` unless write access is enabled (then `not_implemented`)

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

## Deferred / not in this milestone

- Plan validation, preview diffs, and atomic commits
- Object / shot / landmark mutations
- Package download control
- Viewport capture runtime services
- In-app Agent Console

See the architecture notes in the PR description for the full roadmap.
