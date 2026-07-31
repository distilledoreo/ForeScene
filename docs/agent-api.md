# ForeScene Agent API

ForeScene exposes a browser Agent API on `window.foreScene` so CLI coding agents can inspect and mutate the open project without clicking through the UI.

Playwright hosts and observes the browser. The Agent API performs exact project reads and protected mutations.

## Status

**Milestone 1 — read-only vertical slice** ✓  
**Milestone 2 — plan validation and preview** ✓  
**Milestone 3 — atomic apply + undo** ✓  
**Milestone 4 — shot staging commands** ✓  
**Milestone 5 — visual CLI (screenshot / run)** ✓  
**Milestone 6 — landmarks & export configuration** ✓  
**Milestone 7 — package-export control** ✓  
**Milestone 8 — in-app Agent Console** ✓

Available now:

- Inspection, preview, atomic apply/undo
- Shot staging, landmarks, export configuration patches
- Package export via API / CLI / Agent Console
- `npm run agent:screenshot` / `agent:verify` / `agent:run` / `agent:package`
- Project menu → **Agent Console** (same `window.foreScene` path)

## Quick start

```bash
npm run dev
npm run agent:inspect
```

JSON is written to stdout. Diagnostics and progress go to stderr.

## Permission model

Agent control mode is an **accidental-write guard**, not a security boundary against hostile page scripts (those already own the origin).

| Mode | Inspection | Mutations / package export |
|------|------------|----------------------------|
| `off` | blocked | blocked |
| `read-only` (default) | allowed | blocked (`write_access_required`) |
| `read-write` | allowed | allowed |

**Escalation** (grant writes) is deliberate only:

- Project menu → **Enable Agent Writes**, or Agent Console toggle (UI → Zustand store)
- CLI `--write` → sessionStorage seed for this tab only
- CLI `--persist-write` → localStorage seed for a trusted persistent profile

**Demotion** is available to every caller:

- Header **Stop**, Project menu **Disable Agent Writes**, Agent Console toggle
- `window.foreScene.disableWrites()` (never grants `read-write`)

CLI launches always clear a stale localStorage write seed unless `--persist-write` is present. `apply` / `run` / `package` refuse to start without an explicit `--write` or `--persist-write`.

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

Supported plan commands:

- `project.updateInfo`
- `object.create` / `object.update` / `object.delete` / `object.duplicate`
- `shot.create` / `shot.rename` / `shot.updateDescription` / `shot.updateCamera`
- `shot.select` / `shot.copyStagingToNext` / `shot.stageObject` / `shot.clearStaging`
- `landmark.create` / `landmark.update` / `landmark.delete` / `landmark.linkObject`
- `export.sceneDefaults.patch`
- `export.shotOverrides.patch` / `reset` / `copy` / `promote`
- `workspace.open` / `selection.set`

Plan-local `ref` values bind created entities so later commands can target them. Ambiguous name queries return `ambiguous_target` with candidate ids and abort the whole plan.

Optional `expectedFingerprint` (from a prior inspect/preview) rejects stale projects.

## Apply and undo

`applyPlan` / `undoLastPlan` require read-write mode. They wait for persistence idle (`criticalWrite` / graybox / package export) before committing, then:

1. Prepare the plan on a clone (same path as preview)
2. Confirm the live fingerprint is unchanged
3. Call `runDestructiveProjectMutation()` (pre-change recovery snapshot)
4. Replace project + selection/workspace in one Zustand `setState`
5. Record an in-memory history entry for `undoLastPlan()`

If persistence throws after the live commit, the catch path restores the exact pre-plan project and selection (no history entry).

`undoLastPlan()` restores the preceding project only when the current fingerprint still matches the applied result. Manual edits after apply refuse undo.

`listPlanHistory()` returns in-memory `{ planId, description }` entries for the Agent Console.

## Shot staging

Supported shot commands:

- `shot.create` / `shot.rename` / `shot.updateDescription` / `shot.updateCamera`
- `shot.select` / `shot.copyStagingToNext`
- `shot.stageObject` (transform, visible, humanPose, posePreset)
- `shot.clearStaging` (`clearPoseOnly` keeps transform/visibility)

Staging never mutates Build scene objects. Absolute overrides are idempotent.

## Landmarks & export configuration

Landmark commands mutate `project.landmarks` and clean `shot.landmarkIds` on delete. `landmark.linkObject` sets/clears `linkedObjectId` after resolving the object target.

Export configuration commands reuse `exportConfiguration.ts`:

- `export.sceneDefaults.patch` → `patchSceneExportDefaults`
- `export.shotOverrides.patch` → `setShotExportOverride`
- `export.shotOverrides.reset` → full reset or one `field` path
- `export.shotOverrides.copy` / `promote`

## Package export

```ts
await window.foreScene.exportPackage({ shotIds?: string[], download?: true });
window.foreScene.getPackageExportProgress();
window.foreScene.cancelPackageExport();
```

Flow matches Export workspace: wait idle → flush verified revision → `createExportPlan` → reject blocking errors → `buildMultiShotPackage` → optional `downloadBlob`. Requires read-write.

`download: false` is build-only: returns the package metadata without downloading and without marking shots exported.

```bash
npm run agent:package -- --write --output artifacts/package.zip
npm run agent:package -- --write --shot <shotId> --output artifacts/one-shot.zip
```

## Agent Console

Project menu → **Agent Console** opens an in-app dialog that calls the same `window.foreScene` methods (preview / apply / undo / export / cancel). Enabling writes uses the UI store path; disabling uses `disableWrites()`.

## Visual CLI

```bash
npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
npm run agent:run -- --plan plans/conversation.preview.json --screenshot artifacts/conversation.png --write
```

## Deferred / not in this milestone

- Selected-keyframe transient staging
- `file.import`
- `viewport.capture` (screenshots use Playwright against the live canvas today)
