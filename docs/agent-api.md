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
**Milestone 9 — temporal authoring and controlled video** ✓

Available now:

- Inspection, preview, atomic apply/undo
- Shot staging, landmarks, export configuration patches
- Package export via API / CLI / Agent Console
- `npm run agent:screenshot` / `agent:verify` / `agent:run` / `agent:package`
- Project menu → **Agent Console** (same `window.foreScene` path)
- Timeline inspection and arbitrary-time sampling without changing the live shot
- Declarative timeline replacement, keyframe create/update/delete, staging, preview/apply, and undo
- Multipass still review via `renderShotFrame({ shotId, appearance, peopleVariant, content })`
- Controlled shot video rendering with progress and cancellation via `renderShotVideo()`
- `getShotDocument({ id })` for exact shot staging/keyframe inspection
- `importModel({ file })` for the same protected geometry import used by the manual dialog

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

## Model import

`importModel({ file, mode })` uses the shared model conversion and local-recovery
commit path behind **Import 3D scene**. It creates texture-free graybox geometry,
registers its binary payloads, and adds the resulting objects in the same protected
project mutation. It requires `read-write` access. Heavy geometry returns a
structured `requiresConsent` result until its caller sends the explicit
`allow-heavy-model-imports` token; extreme imports also require the literal
`IMPORT` confirmation.

`getShotDocument({ id })` returns a structured copy of the requested `Shot`,
including `objectOverrides` and `cameraKeyframes`. Use it when a workflow must
copy exact staging rather than infer it from summary inspection fields.

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

Use the CLI when a review workflow needs a persisted preflight plan and a
post-export archive check:

```bash
npm run agent:plan-exports -- --shots 01,02,03 --output artifacts/preflight/deliverables-plan.json
npm run agent:verify-package -- \
  --plan artifacts/preflight/deliverables-plan.json \
  --package artifacts/package.zip
```

`agent:verify-package` reads the ZIP and requires every file from every
`produce` artifact in the recorded export plan. It reports each missing entry
with its shot and artifact kind, so a requested projected, clean-plate,
character-only, or depth pass cannot silently disappear from delivery.

## Multipass still review

`renderShotFrame` uses the same render paths as package export without writing
assets or changing the live shot. `appearance` is `clay`, `projected`, or
`depth`; `peopleVariant` is `with_people` or `clean_plate`; and `content` is
`full_scene` or `characters_only`. Character-only is a transparent pass with
the environment removed. Depth results include linear camera-depth metadata and
the sampled grayscale ratio. Projected requests fail with a clear diagnostic
when no valid styled panorama/projector is available.

```bash
npm run agent:render-passes -- \
  --shots 01,02,03,04 \
  --output artifacts/reviews/batch-01
```

This writes six deterministic files per shot — clay with characters, clay clean
plate, projected with characters, projected clean plate, characters only, and
depth — plus `review-manifest.json`. The manifest records each renderer source,
pixel/depth inspection data, and a SHA-256 for comparison before packaging.
`agent:refine` adds a `temporal` record for every renderable camera move to
that same manifest:

```json
{
  "temporal": {
    "renderable": true,
    "start": { "output": "temporal/start.png", "sha256": "sha256:..." },
    "mid": { "output": "temporal/mid.png", "sha256": "sha256:..." },
    "end": { "output": "temporal/end.png", "sha256": "sha256:..." },
    "video": {
      "output": "temporal/motion-preview.mp4",
      "sha256": "sha256:...",
      "durationSeconds": 3
    }
  }
}
```

Semantic approval must approve renderable motion and provide matching hashes
for all four temporal artifacts. A non-renderable shot must explicitly use
`motionDecision: "not_applicable"`.

## Existing-project refinement

`agent:refine` is intentionally separate from the greenfield previs manifest.
It captures a durable preservation baseline before the first mutation, then
permits one batch at a time. The baseline protects project, shot, panorama,
existing-object, camera, and timeline identities; import/replacement work may
add objects and alter only the required staging overrides.

```json
{
  "version": 1,
  "mode": "existing-project-refinement",
  "preserve": {
    "project": true, "shots": true, "panoramas": true,
    "environmentObjects": true, "cameras": true, "timelines": true
  },
  "allowMutations": {
    "shotStaging": [], "pose": [], "camera": [], "timeline": [], "visibility": []
  },
  "characterImports": [
    { "id": "joseph-intact", "batchId": "batch-01", "file": "assets/joseph.glb", "rigPackage": "assets/joseph.fsrig", "rigMode": "saved-rig" }
  ],
  "modelImports": [
    { "id": "spider-model", "batchId": "batch-01", "file": "assets/spider.glb", "mode": "combined" }
  ],
  "characterAssignments": [
    { "id": "assign-joseph", "importId": "joseph-intact", "replaceObjectId": "existing-joseph-placeholder", "shots": ["01"] }
  ],
  "proxyReplacements": [
    { "id": "replace-spider", "batchId": "batch-01", "proxyObjectId": "proxy-spider", "replacementImportId": "spider-model", "shots": ["01"] }
  ],
  "batches": [{ "id": "batch-01", "shots": ["01"] }],
  "deliverablesProfile": "ai-control-full"
}
```

Run a batch, complete a semantic visual review, approve it explicitly, then
advance or finalize:

```bash
npm run agent:refine -- --plan production/refinement-plan.json --batch batch-01 --write --output artifacts/refinement
npm run agent:refine -- --plan production/refinement-plan.json --approve batch-01 --review artifacts/refinement/reviews/batch-01.semantic.json --output artifacts/refinement
npm run agent:refine -- --plan production/refinement-plan.json --finalize --write --output artifacts/refinement
```

A batch ends in `awaiting_visual_review` only if every required still pass,
temporal sample (for motion shots), and preservation check succeeds. The next
batch is blocked until `--approve` receives a semantic review file. It must
pass every shot, give concrete reasons, affirm the subject, variant, framing,
creature, proxy absence, props, and motion decision, and include the SHA-256
of every reviewed pass. Allowed camera or timeline changes are recorded in the
review manifest and require an explicit `authorizedMutationDecision: "approved"`
for the affected shot. Finalization applies `deliverablesProfile`
(`ai-control-full`) before creating the export plan, then rejects missing
required clay, projected, clean-plate, cast, depth, or renderable-motion
artifacts. The planner emits one artifact per viewport pass containing both
people variants, and finalization validates those filenames inside the shared
artifact. Character still output is also produced as a transparent image for a
cast-free shot, keeping the package pass matrix predictable. `--profile`
selects only the persistent Playwright browser directory, never a deliverables
profile. Use `--retry batch-id` to restore a failed batch's starting revision
and run it again, or `--rollback batch-id` to restore without rerunning.
Finalization refuses
unapproved batches, failed/missing replacement work, visible proxies, any
preservation drift, or a package that omits a planned artifact.

For a production copy, start from
`examples/refinement/six-shot-pilot.template.json`, replace every placeholder
object/shot id with IDs from that copied project, and run the pilot before
adding later production batches. It requires three saved-rig Joseph variants,
spider and hand-monster replacements, and a sixth motion shot. Motion shots
also emit start/mid/end clay frames plus a downloaded 720p MP4 preview, so
framing and temporal output can be reviewed together.

## Preview

`previewPlan` works in read-only mode. It never writes the live project.

Supported plan commands:

- `project.updateInfo`
- `object.create` / `object.update` / `object.delete` / `object.duplicate`
- `shot.create` / `shot.rename` / `shot.updateDescription` / `shot.updateCamera`
- `shot.select` / `shot.copyStagingToNext` / `shot.stageObject` / `shot.clearStaging` / `shot.delete`
- `landmark.create` / `landmark.update` / `landmark.delete` / `landmark.linkObject`
- `shot.timeline.replace` / `shot.timeline.clear` / `shot.timeline.setDuration`
- `shot.keyframe.create` / `shot.keyframe.update` / `shot.keyframe.delete`
- `shot.keyframe.stageObject` / `shot.keyframe.clearStaging`

## Temporal authoring

Inspection is available through `inspectShotTimeline({ shotId })` and
`sampleShotAtTime({ shotId, timeSeconds })`. Sampling clamps to the shot duration
and returns interpolated camera and object overrides; it does not persist changes.

```js
await window.foreScene.previewPlan({
  version: 1,
  planId: 'demo-motion',
  commands: [{
    op: 'shot.timeline.replace',
    shot: { id: 'shot-id' },
    durationSeconds: 4,
    keyframes: [
      { timeSeconds: 0, camera: { position: [0, 2, 6], target: [0, 1, 0] } },
      { timeSeconds: 4, camera: { position: [2, 2, 4], target: [0, 1, 0] } },
    ],
  }],
});
```

The CLI exposes the same render path:

```bash
npm run agent:frame -- --shot shot-id --time 2 --output artifacts/midpoint.png
npm run agent:video -- --shot shot-id --write --resolution 1080p --output artifacts/shot.mp4
```

Video rendering is exclusive with other Agent writes, reports progress through
`getShotVideoRenderProgress()`, and can be stopped with
`cancelShotVideoRender()`. A failed or cancelled render leaves the previous shot
video attachment intact.
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
- `shot.delete` (refuses to delete the last remaining shot)

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

## Character import

Character analysis and import are exposed through the Agent API and appear in capability reporting as `characterImport`. The CLI stages the file through a browser file input, so binary model bytes are not serialized through `page.evaluate` arguments:

```bash
npm run agent:analyze-character -- --file path/to/actor.glb
npm run agent:import-character -- --file path/to/actor.glb --rig-mode auto --write
npm run agent:analyze-character -- --file path/to/actor.glb --rig-package path/to/actor.fsrig --rig-mode saved-rig --output artifacts/preflight/actor.json
npm run agent:import-character -- --file path/to/actor.glb --rig-package path/to/actor.fsrig --rig-mode saved-rig --name "Actor" --allow-heavy-character-imports --write
```

Auto mode preserves an existing rig only when the analysis reports skeleton and skinning data, no required mappings are missing, and mapping confidence is at least 0.7; otherwise it selects autorig. `saved-rig` stages both binary inputs, validates the package and source topology before writing, then applies the shared saved-rig importer. Results include GLB, rig-package, and combined fingerprints; a repeated exact pair reuses the existing character instead of creating a duplicate. Large imports use the device-aware model-import budget and require explicit consent (`--allow-heavy-character-imports` or `--consent-token`). Character imports participate in `waitForIdle` and block plan, reset, package, and video operations until they finish or are cancelled.

## Ordinary model import and proxy replacement

```bash
npm run agent:import-model -- --file input/model.glb --write
npm run agent:replace-proxy -- \
  --proxy proxy-id --replacement imported-model-id --shots 08,09,10 \
  --output artifacts/refinement/hand-monster.json --write
```

`agent:import-model` calls `window.foreScene.importModel()` and the exact shared
engine service used by **Import 3D scene**. It does not create a separate agent
asset path. Heavy geometry requires `--allow-heavy-imports`; extreme geometry
also requires `--consent-token IMPORT`.

`agent:replace-proxy` gets full shot documents (including direct and keyframe
object overrides), creates one atomic plan, renders before evidence, previews,
applies, rereads and verifies the project, then renders after evidence. It
refuses missing objects, empty/partial shot coverage, failed previews, failed
renders, or any project/shot/panorama/camera/timeline verification mismatch. A
post-apply failure invokes Agent undo and records that rollback in its JSON
report. The report sits beside per-shot `.before.png` and `.after.png` clay
frames.

## Visual CLI

```bash
npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
npm run agent:run -- --plan plans/conversation.preview.json --screenshot artifacts/conversation.png --write
```

## Deferred / not in this milestone

- Selected-keyframe transient staging
- `file.import`
- `viewport.capture` (screenshots use Playwright against the live canvas today)

## Autonomous previs (production manifest)

Higher-level graybox pipeline stacked on the Agent API. See `docs/previs-production-manifest.md`.

New browser methods:

- `resetProject({ name, description?, aspectRatio?, frameRate?, expectedProjectId?, resetAuthorization })` — requires read-write **and** `resetAuthorization: "reset-project"`
- `getProjectDocument()` — read-only `structuredClone` of the live `LocationProject`

`shot.create` accepts optional `shotNumber` / `productionShotId` so previs shot numbers are preserved exactly.

```bash
npm run agent:previs -- \
  --manifest examples/previs/minimal-dialogue.json \
  --write --reset-project \
  --output artifacts/previs
```
