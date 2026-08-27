# ForeScene Agent API

ForeScene exposes a browser Agent API on `window.foreScene`. The **canonical public automation surface** is the Agent CLI (`npm run agent:*`). Agents should query `npm run agent:capabilities` and use documented CLI commands instead of calling `window.foreScene` or inspecting source for supported operations. See [agent-capability-matrix.md](./agent-capability-matrix.md).

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
- `npm run agent:screenshot` / `agent:verify` / `agent:visual-preflight` / `agent:asset-contract` / `agent:run` / `agent:package`
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

JSON is written to stdout as a stable envelope (`ok`, `operation`, `durationMs`, `warnings`, `error`, `result`). Diagnostics and progress go to stderr.

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
project mutation. Importing the same file bytes again (matching stored `contentHash`)
reuses the existing model asset and imported object instead of creating duplicates;
the result includes `reused: true` when binding is reused. It requires `read-write`
access. Heavy geometry returns a
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
  },
  "provenance": {
    "productName": "ForeScene",
    "productVersion": "0.1.0",
    "schemaVersion": "1.2",
    "agentApiVersion": 1,
    "revisionId": "...",
    "cli": { "command": "verify", "harness": "forescene-agent-cli", "runId": "cli_…" },
    "retries": 0,
    "cancelled": false,
    "validation": {
      "revisionId": "...",
      "activeRevisionId": "...",
      "revisionBinding": "current",
      "current": true,
      "ok": true,
      "gates": { "visualPreflight": "passed", "assetPose": "passed", "projectHealth": "passed", "revisionBound": "passed" },
      "visualPreflight": { "shotCount": 1, "passedCount": 1, "failedCount": 0, "warningCount": 0, "failedShotIds": [], "warningShotIds": [], "unresolvedVisibleObjectIds": [], "unresolvedVisibleCount": 0 }
    },
    "cache": { "renderEntries": 0, "readyEntries": 0, "invalidatedEntries": 0, "operations": [] }
  }
}
```

## Agent API v1 improvements

### Shot panorama

```ts
await foreScene.setShotPanorama({ shotId, panoId: 'pano_…' });
await foreScene.setShotPanorama({ shot: { shotNumber: '02' }, panoId: null }); // durable unlink
```

```bash
npm run agent:shot-panorama -- --shot 01 --pano pano_… --write --profile ./run-profile
npm run agent:shot-panorama -- --shot 02 --pano null --write --profile ./run-profile
```

Atomically updates `linkedPanoId`, `panoCrop`, active panorama state, and persistence.
`panoId: null` writes `linkedPanoId: null` (not a missing field). Hydrate, reopen, and
export/import preserve that unlink and do **not** reattach the canonical panorama.

Shot targets accept `id`, `ref`, `query`, or `shotNumber` everywhere the plan compiler
and installed API resolve a shot.

### Render / export result contract

Render and export operations now return a stable `status` plus optional `artifact`:

| `status` | Meaning |
|----------|---------|
| `completed` | Artifact produced, no quality issues |
| `completed_with_warnings` | Artifact produced; inspect `diagnostics` |
| `failed` | No usable artifact |
| `stale_revision` | Project changed during render |
| `cancelled` / `busy` | Operation did not complete |

`ok` is `true` when `status` is `completed` or `completed_with_warnings` — a frame with `frame_zero_variance` still returns the PNG in `artifact` / `pngDataUrl`.

### Artifact handles

Video render, package export, and project backup register blobs in-memory:

```ts
const video = await foreScene.renderShotVideo({ shotId, download: false });
const downloaded = await foreScene.downloadArtifact({ artifactId: video.artifact!.artifactId });
const blob = downloaded.blob;
const backup = await foreScene.exportProjectBackup({ download: false });
```

`downloadArtifact` returns a Blob by default. Use `includeDataUrl: true` only for legacy consumers that still require base64 data URLs.

Job result handles are pinned as `in-flight` while that generation is running. Published authoritative results stay pinned after the item settles. Pause and cancel may flip public job state immediately, but the previous generation is still drained first.

Unpublished job-scoped outputs from an aborted or stale generation are **deleted after that generation drains** — they are not successful job results and must not remain pinned as orphans. The sweep is owned by the job/generation, not by the handler remembering to call `registerArtifact()`. It never deletes an artifact that was published onto the job, belongs to a still-active generation, or is persisted / project-attached. Durable unpublished artifacts only lose a leftover in-flight pin.

### Discovery

```ts
foreScene.describeCapabilities();
foreScene.describeOperation('setShotPanorama');
foreScene.getAgentSchema();
```

CLI: `npm run agent:help -- --json`

### Spatial primitives

All spatial primitives are **shot-scoped** — they read shot-effective transforms and write sparse `shot.objectOverrides` (never base `scene.objects`).

`snapObjectToFloor({ shotId, object })`, `placeObjectNearLandmark`, `frameSubjects`, `orientObjectToward`, and `trackSubjects` follow this model.

`trackSubjects` samples subject transforms at `startTime` and `endTime`, solves distinct cameras, and warns when subject displacement is negligible or the cameras are identical. Tracking inserts or updates keyframes at the requested times without rescaling existing timeline timing.

### Timeline helpers

`sampleShotState`, `captureShotStateAsKeyframe`, and `upsertObjectKeyframe` preserve explicit staging at timeline times.

### Shot diagnostics

`inspectShotDiagnostics({ shotId, timeSeconds?, subjectIds? })` returns diagnostics for explicitly requested objects of any type, or infers likely subjects when `subjectIds` is omitted. `shotNumber` is accepted as a shot target.

`inspectShotVisualPreflight({ shotId | shot, timeSeconds?, subjectIds?, environmentOnly?, allowUnresolvedSetDressing? })` adds scored quality gates for subject visibility, framing/coverage, ground contact, camera direction, cropping, and motion continuity. Missing requested subjects fail the gate (`ok: false`, `gateStatus: "failed"`). Camera-direction checks use shot-effective transforms. When a shot has camera keyframes, the preflight samples start, mid, and end times and reports `samples[]` with per-sample failures.

`ok` is true only when `gateStatus === "passed"`. A warning or failure is never a fully passed visual gate. `composeAgentValidationEvidence` / `recordRunValidation` use `gateStatus` (not just `!item.ok`) so a warning cannot be reported as `gates.visualPreflight: "passed"`.

Visual-gate presence is distinct from the result:

- Omit `visualPreflight` when the caller did not request the gate → `gates.visualPreflight: "skipped"`.
- Supply `visualPreflight: []`, or an explicit shot selection that matches nothing → requested-but-empty, `gates.visualPreflight: "failed"`, with `emptySelection` / `unmatchedShotIds` / `diagnostic`. This is never a vacuous pass.
- `verify` and `visual-preflight` with no `--shots` on a project that has no shots omit the visual gate (skipped). Empty projects are supported; they are not treated as “every selected shot passed”.
- `collectVisualPreflightValidation({ shotIds })` is the CLI/API composition path. Any unmatched requested id fails the selection (same rule as other CLI shot resolvers).

A legitimate environment-only shot stays supported only through **explicit intent**: `environmentOnly: true`, `shot.metadata.environmentOnly`, or `shot.metadata.shotKind === "environment"`. Those shots report `environmentOnly: true` with `subjectPolicy: "environment_only"` and N/A subject/coverage checks. Empty subject inference never silently classifies ordinary visible content as environment-only.

Set-dressing policy for ordinary shots (`subjectPolicy: "subjects_expected"`):

- Visible non-environment content that is not identified or scored is reported in `unresolvedVisibleObjectIds` and is never dropped from the validation summary.
- No inferred subjects plus unresolved visible content (imported model, monster, prop, or other renderable) fails `subject_visibility`.
- Inferred/requested subjects plus additional unresolved visible content **fails** the ordinary visual gate (`ok: false`, `gateStatus: "failed"`). The extra content cannot be silently omitted from the scored subject set while the gate still reports passed.
- Non-blocking set dressing is an explicit persisted opt-in: `allowUnresolvedSetDressing: true` or `shot.metadata.allowUnresolvedSetDressing === true`. That path uses `subjectPolicy: "set_dressing_allowed"`, keeps the unresolved ids, and reports `gateStatus: "warning"` — never `passed` / `ok: true`.
- An ordinary shot that still has candidate subjects (humans, poseable characters) but infers none fails.
- A set-only shot without explicit environment-only intent is a warning (`ok: false`, `gateStatus: "warning"`), not an N/A perfect score.
- Requesting an object as `subjectIds` identifies it so it is scored instead of treated as unresolved set dressing.

Repair loops should call `beginShotRepairSession`, then `evaluateShotRepairCandidate` after each mutation, then `commitBestShotRepairCandidate` so a later worse repair cannot silently replace a better validated snapshot. Snapshots cover camera, keyframes, object overrides, panorama linkage, and other shot-scoped fields. `agent:previs` uses this loop automatically.

CLI:

```bash
npm run agent:visual-preflight -- --shots 01,02
npm run agent:asset-contract
npm run agent:asset-contract -- --shot <shotId>
npm run agent:verify
npm run agent:verify -- --shots 01,02
```

`verify` and `visual-preflight` pass an explicit `--shot`/`--shots` list to `collectVisualPreflightValidation`. Omitted selection validates every shot (or skips the visual gate on an empty project). An unknown requested id or an explicitly empty selection fails, and the unmatched ids/diagnostic appear in the JSON result and provenance. `frame` and `video` accept exactly one shot and reject extra ids before the browser opens. `asset-contract` accepts one optional `--shot` and rejects additional ids; the API stays `inspectAssetPoseContract({ shotId? })`.

`verify` now reports visual preflight, asset/pose contract, project health, and run provenance. Those already-computed results are also stored as `getStatus().provenance.validation` — a bounded, revision-bound quality summary. `recordRunValidation` never re-renders or re-runs the gates. `gates.visualPreflight` is `passed` only when every recorded shot fully passed; an explicit empty result or unmatched `--shots` selection is `failed`. Unresolved visible content is `failed` by default and `warning` only with the explicit `allowUnresolvedSetDressing` opt-in. A warning gate makes `validation.ok` false — it cannot masquerade as a full pass. Evidence whose `revisionId` does not match the live project revision is preserved as `revisionBinding: "stale"` / `historical: true` and cannot be reported as a valid current summary (`ok: false`, `current: false`, `gates.revisionBound: "failed"`). Matching or omitted-but-active revision ids bind as `current`. Absent revisions on both sides are `unbound`.

Every CLI invocation generates a `runId` and publishes it as `provenance.cli.runId`. Source commit / build identity is included only when the host actually provides `FORESCENE_SOURCE_COMMIT`, `GITHUB_SHA`, `VITE_GIT_COMMIT`, `FORESCENE_BUILD_ID`, or `VITE_BUILD_ID`. `beginRunSession({ runId })` resets retry/cancel/validation counters so one invocation cannot inherit another run's process-wide state.

`retries` increments when `withRevisionRetry` actually retries, when a paused/failed job or production run resumes, or when `retryFailedShotStills` is called. `cancelled` becomes true only when a real in-flight job, package export, video render, production run, character import, still-prep, or render-work cancel happens — idle cancel calls do not set it. Cancelling a job that is already `completed`, `completed_with_warnings`, `failed`, or `cancelled` is a no-op with a `job_already_terminal` diagnostic: status, `finishedAt`, artifacts, and provenance stay as they were. `finishedAt` is set only for those terminal statuses; pause does not stamp it, and resume clears it.

`inspectAssetPoseContract({ shotId?, packageManifestPaths?, producedPackageManifest? })` reports asset resolution, package inclusion, and pose-preset alias mapping (`running` → `walk-contact-left`, `shield-ready` → `elbows-bent`). `includedInPackage` is `true` only when `producedPackageManifest` comes from `extractProducedPackageManifest` on real ZIP bytes (`Blob`, `ArrayBuffer`, or `Uint8Array`) and that archive actually lists the planned entry. Planned-path strings, fabricated proof objects, fabricated `{ files: { plannedPath } }` objects, in-memory JSZip instances, artifact ids, and digest-as-path values stay `not_verified` (or `false` when packaging rules omit the asset). An available model without ZIP proof is `not_verified`, never a false-positive `true`.

CLI `package` and `video` downloads include `transfer` on the command result (`transferMode`, `pageMaterialization`, `byteLength`, `chunkCount`). That names the CLI path (`chunked-base64` with `blob-slice`, or explicit `uint8array-fallback`) and does **not** pretend `downloadArtifact`'s `browser-blob` handle is a streamed file. Previs `summary.json` records `packageTransfer`; refinement writes the same metadata onto the finalization report.

Per-subject fields:

- `screenCoverage` — projected frame occupancy
- `visibleFraction` — in-frame visible subject fraction (`visibleArea / unclippedArea * (1 - occlusionRatio)`)
- `groundClearanceMeters` — signed distance to identified floor (negative = below floor)
- `behindCamera`, `clipped`, `occlusionRatio`
- `humanLandmarks` — optional head/body landmarks for humanoid objects

Shot-level fields:
- `cameraIntersectsSolidGeometry` — camera inside a wall/box/column
- `cameraInsideEnvironmentBounds` — camera inside inferred navigable envelope
- `linkedPanoramaResolved` — panorama link resolves (not a render confirmation)
- `cameraDisplacementMeters` and `subjectDisplacements`

### Revision sync

Every mutation returns `revisionId`. Call `refreshRevision()` before retrying after `stale_revision`.

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

Semantic approval must include a generic criterion result for every criterion
listed by the manifest. Renderable shots include `temporal.motion` and must
pass it; non-renderable shots do not receive that criterion. Every still and
temporal artifact must also appear in `reviewedArtifacts` with its matching
SHA-256.

## Prepared-media capture

The installed API exposes two intentionally different capture paths:

```ts
// Fast sampled thumbnail. Writes the legacy viewport slot and honors timeSeconds.
await foreScene.captureShotThumbnail({ shotId, timeSeconds: 1.5 });

// Full configured still set. Awaits the prepared-media coordinator and returns
// the materialized artifact records; it does not create a second base64 copy.
await foreScene.captureShotPreparedMedia({ shotId });

await foreScene.inspectShotPreparedMedia({ shotId });
await foreScene.regenerateShotStills({ shotId });
await foreScene.retryFailedShotStills({ shotId });
foreScene.cancelShotStillPreparation({ shotId });
```

`captureShotThumbnail` renders one sampled clay frame, attaches it to the shot's
legacy viewport thumbnail slot, and honors `timeSeconds` when provided.
`captureShotPreparedMedia` is the explicit durable path for package/export
workflows and returns the declared
`AgentShotMaterializationResult` fields:
`revisionId`, `primaryStillAssetId`, `artifacts`, and `warnings`. Prepared-media
work is included in `getStatus()` / `waitForIdle()` so an agent cannot proceed
while still or background-video GPU work is active.

`cancelShotStillPreparation({ shotId })` cancels queued or in-flight capture,
regeneration, and retry work for that shot. Already committed artifacts remain
attached; the cancelled call rejects with an `AbortError` rather than reporting
a render failure.

## Existing-project refinement

`agent:refine` is intentionally separate from the greenfield previs manifest.
It captures a durable preservation baseline before the first mutation, then
permits one batch at a time. The baseline protects project, shot, panorama,
existing-object, camera, and timeline identities; import/replacement work may
add objects and alter only the required staging overrides.

```json
{
  "version": 2,
  "mode": "existing-project-refinement",
  "preserve": {
    "project": true, "shots": true, "panoramas": true,
    "environmentObjects": true, "cameras": true, "timelines": true
  },
  "allowMutations": {
    "shotStaging": [], "pose": [], "camera": [], "timeline": [], "visibility": []
  },
  "characterImports": [
    { "id": "subject-variant-a", "batchId": "batch-01", "file": "production/<production-id>/subject-variant-a.glb", "rigPackage": "production/<production-id>/subject-variant-a.fsrig", "rigMode": "saved-rig" }
  ],
  "modelImports": [
    { "id": "replacement-object-a", "batchId": "batch-01", "file": "production/<production-id>/replacement-object-a.glb", "mode": "combined" }
  ],
  "characterAssignments": [
    { "id": "assign-subject-a", "importId": "subject-variant-a", "replaceObjectId": "existing-subject-placeholder", "shots": ["01"] }
  ],
  "proxyReplacements": [
    { "id": "replace-object-a", "batchId": "batch-01", "proxyObjectId": "proxy-object-a", "replacementImportId": "replacement-object-a", "shots": ["01"] }
  ],
  "batches": [{ "id": "batch-01", "shots": ["01"] }],
  "deliverablesProfile": "ai-control-full",
  "reviewPolicy": { "additionalCriteria": [], "shotRequirements": [] },
  "finalization": { "scope": "reviewed_shots" },
  "subjectObjectIds": []
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
pass every shot, provide a concrete reason for every manifest criterion, and
include the SHA-256 of every reviewed pass and temporal artifact. Allowed
camera or timeline changes add the `refinement.authorized-change` criterion.
Finalization applies `deliverablesProfile`
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

Refinement finalization defaults to `scope: "reviewed_shots"` and exports the
deduplicated shot ids stored on approved batch state. Set
`finalization.scope` to `"entire_project"` to require an approved review for
every project shot; missing and extra reviewed ids are reported explicitly.
The finalization report records `reviewedShotIds`, `plannedShotIds`,
`exportedShotIds`, `unreviewedExportedShotIds`, `reviewedButUnexportedShotIds`,
and `productionComplete`. Direct export API calls reject unknown, duplicate,
or explicitly empty `shotIds` selections.

Approval also stores an `approval-record.json` containing the exact manifest
hash, semantic-review hash, reviewed shot ids, criterion ids, and artifact
count. Approval recomputes the manifest and semantic hashes and reads every
still and temporal output from disk; finalization repeats those checks before
it can produce a package.

For a production copy, start from
`examples/refinement/six-shot-pilot.template.json`, replace every placeholder
object/shot id with IDs from that copied project, and run the pilot before
adding later production batches. It demonstrates three saved-rig subject
variants, two replacement objects, and a sixth motion shot. Motion shots
also emit start/mid/end clay frames plus a downloaded 720p MP4 preview, so
framing and temporal output can be reviewed together.

## Preview

`previewPlan` works in read-only mode. It never writes the live project.

Supported plan commands:

- `project.updateInfo`
- `object.create` / `object.update` / `object.delete` / `object.duplicate`
- `shot.create` / `shot.rename` / `shot.updateDescription` / `shot.updateCamera`
- `shot.frameSubjects` — solver-backed framing intent (see below)
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

### `shot.frameSubjects` — cinematic framing as a plan command

```js
await window.foreScene.previewPlan({
  version: 1,
  planId: 'medium-two-shot',
  commands: [{
    op: 'shot.frameSubjects',
    shot: { id: 'shot-id' },
    subjects: [{ id: 'actor-object-id' }],
    composition: 'medium', // establishing | wide | full_body/full | medium | medium_close_up | close_up | three_quarter_tracking | over_the_shoulder | two_shot
  }],
});
```

The plan compiler solves the camera with the same solver as the `frameSubjects`
Agent API primitive and expands the command into an equivalent
`shot.updateCamera` against the mid-plan project state. That means framing
intent composes with staging commands in one plan and inherits the whole plan
lifecycle: preview diff, atomic apply, fingerprint checks, and undo. Solver
warnings (for example an unknown composition falling back to `medium`) surface
as plan warnings; an unresolvable shot or subject target fails the whole plan.

## Apply and undo

`applyPlan` / `undoLastPlan` require read-write mode. They wait for persistence idle (`criticalWrite` / graybox / package export) before committing, then:

1. Prepare the plan on a clone (same path as preview)
2. Confirm the live fingerprint is unchanged
3. Call `runDestructiveProjectMutation()` (pre-change recovery snapshot)
4. Replace project + selection/workspace in one Zustand `setState`
5. Record an in-memory history entry for `undoLastPlan()`

If persistence throws after the live commit, the catch path restores the exact pre-plan project and selection (no history entry).

`applyPlan(plan, { expectedRevisionId })` adds a compare-and-swap guard: the
apply refuses with `stale_revision` when the live verified revision is missing
or different (same contract as `expectedRevisionId` on package export). The CLI
exposes it as `npm run agent:apply -- --plan plan.json --write --expected-revision <id>`.

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

`download: false` is build-only: returns the package metadata without downloading and without marking shots exported. CLI `agent:package` and `agent:video` persist through the artifact handle (`downloadArtifact`) and do **not** wait for a browser download event. Pass `expectedRevisionId` to refuse a stale flush. Video results include `cacheStatus` and stage timings.

`--profile` is forwarded by inspect, preview/apply, screenshot, frame, video, package, character import/analyze, model import, replace-proxy, render-passes, plan-exports, refine, previs, production, and render-stills.

```bash
npm run agent:package -- --write --output artifacts/package.zip
npm run agent:package -- --write --shot <shotId> --output artifacts/one-shot.zip --profile ./browser-profile
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
  --output artifacts/refinement/replacement-object.json --write
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
## Missing assets

`foreScene.getStatus()` and `foreScene.inspectProject()` expose `missingAssetCount`. `foreScene.listMissingAssets()` returns each stable asset ID, original filename, resolution status, affected scene instances, and affected shots. With read-write control, `foreScene.relinkAsset({ assetId, file, mode: 'locate' | 'replace' })` reconnects or intentionally replaces the binary without recreating scene objects; `foreScene.removeMissingAsset(assetId)` removes the unresolved asset and its explicit instances. Package export omits missing placeholders and returns warning strings while keeping the project document intact.
