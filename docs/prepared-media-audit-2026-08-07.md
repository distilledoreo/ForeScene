# Prepared-Media Audit & Implementation Plan

**Date:** 2026-08-07
**Branch:** `feat/materialized-still-artifact-foundation` @ `448431c92b4a466eb3e093a127bbde5d0a684e31` (PR #114)
**Scope:** +8,824 lines / 60 files vs `origin/main` — materialized still artifacts, background video preparation, export recovery, prepared-media runtime/UI, agent integration.
**Mode:** Read-only audit (no source modified). Findings verified by trace, live reproduction, or targeted reads; key line references re-verified against `448431c`.

---

## 1. Executive summary

PR #114 is functionally complete and CI-green, but the audit found **17 confirmed correctness/resource defects** (several capable of permanent data loss), **1 confirmed protocol divergence** that silently degrades every agent using `captureShotThumbnail`, **20 throughput bottlenecks**, and a **save-time cleanup race that was reproduced live** (a newer unsaved asset is deleted by maintenance running against the older snapshot being verified).

Priority order for the implementation plan: (0) regression tests for the data-loss races, (1) correctness fixes, (2) protocol/facade alignment, (3) render-throughput work, (4) persistence batching and cache budgeting, (5) runtime event scoping and UI polish.

---

## 2. Correctness & resource defects (confirmed)

### C1. Superseded still assets leak from live project state
`commitPreparedStillArtifact.ts:180-191` prunes the old asset from its project copy and blob-deletes it; the final live merge at `materializeShotStills.ts:302-342` spreads the latest asset registry and **only adds** the new asset — `supersededAssetId` is never removed from the live store. Export recovery repeats the pattern at `ensureStillArtifactForExport.ts:176-219`.

- **Impact:** every regeneration leaves an unreferenced live asset record whose blob is already deleted. Registry scans grow indefinitely; a concurrent new reference to the old asset can be corrupted by deletion based on an earlier snapshot. The dangling record survives until the next `updateShot`-triggered `pruneUnreferencedProjectAssets` (`projectSlice.ts:1000`).
- **Verify:** regenerate one spec after N camera changes; asset count should stay constant (currently grows ~1 per regeneration). Introduce a concurrent reference to the superseded asset and assert its blob survives.

### C2. Fast "current" path does not verify backing bytes
`materializeShotStills.ts:237-249` accepts a matching fingerprint when an asset record exists, bypassing the durable-blob check implemented in `prepareStillArtifact.ts:147-167`.

- **Impact:** an evicted/deleted IndexedDB blob is reported `ready` forever; previews fail and ordinary reconciliation never repairs it.
- **Verify:** materialize, delete the storage key, materialize without force → expect one recovery render (currently zero renders, status `current`).

### C3. ForeScene-v2 recovery assets leak and are never committed live
`packageExportV2.ts:378-379,402-417` calls recovery without live-commit hooks; the per-shot signature omits them (`:361-371`) and the caller omits them (`:1035-1045`). Temp cleanup only runs on the success tail (`:970-973`) — unlike legacy's `try/finally` (`packageExport.ts:403-411`). `ensureStillArtifactForExport.ts:274-307` additionally persists an export-only temporary Blob to IndexedDB even though its own comment says only the returned Blob is required.

- **Impact:** cancellation or a later artifact failure leaks object URLs, memory blobs, and IDB rows; successful V2 recovery does a full put-then-delete so the next export recovers again; a temp-write quota failure can poison project persistence status despite usable export bytes.
- **Verify:** force the second V2 still to fail after the first recovery; compare `listProjectAssetBlobKeys()` before/after. Repeat a successful export and assert the second performs zero recovery renders.

### C4. Background-video cancellation is classified as failure
`cancellationError()` returns a plain `Error` (`prepareVideoArtifact.ts:99-104`); the scheduler only `continue`s on `name === 'AbortError'` (`backgroundVideoPreparation.ts:242-246`). Video coordinator jobs also carry no `ownerId` (`:223-232`), so shot-scoped cancellation misses them.

- **Impact:** editing/deleting/disposing a running video reports `failed`; a rejected job can repopulate status after disposal clears it; queued work for a deleted shot stays in the coordinator.
- **Verify:** abort a running real `prepareVideoArtifact`, drain microtasks, assert status is pending/absent rather than failed.

### C5. A failed video candidate can be hidden by a later success
`backgroundVideoPreparation.ts:242-257` sets shot status to `failed` on candidate failure but the loop continues; the next candidate sets `encoding` then `ready`.

- **Impact:** `peopleExportMode: both` can show "Video ready" with one required variant missing.
- **Verify:** fail candidate one, succeed candidate two, require a final failed/partial state with per-candidate diagnostics.

### C6. Offline clay/projected failures leak Three.js resources
`renderViewportClay` (`renderers.ts:1218-1266`) and `renderViewportProjectedInternal` (`:1451-1547`) lack `try/finally` around renderer/scene disposal; depth/character paths do it correctly. `generateProjectorOcclusionMap` (`projectorOcclusion.ts:152-233`) allocates scene/target/material before `CubeCamera.update` but its `finally` only restores renderer state. `loadProjectedSceneResources` (`renderers.ts:1317-1342`) can lose an already-created primary map when secondary generation throws.

- **Impact:** one bad asset/context loss/OOM leaves contexts and render targets alive; subsequent artifacts cascade into context-limit failures.
- **Verify:** inject failures after renderer/target creation; count contexts, render targets, and imported-geometry refs after repeated attempts.

### C7. Agent video persistence failure rolls back unrelated live edits
`videoRenderControl.ts:99-108` starts from a verified snapshot; attachment failure restores the entire snapshot via `setProject(project)` (`:188-209`), which also resets selection/history/active pano (`projectSlice.ts:180-223`).

- **Impact:** edits to other shots/project fields during a long render are silently lost.
- **Verify:** mutate another shot during encode, force attachment flush failure, assert the unrelated mutation survives.

### C8. Queued cancellation is not prompt
`renderWorkCoordinator.ts:125-147` marks canceled entries; their promises, closures, and runtime status linger until the active job completes (`:80-84`). A cancel-while-running entry keeps the single slot (`MAX_CONCURRENT = 1`, `:46`) occupied for its full duration.

- **Impact:** canceling behind a long MP4 leaves callers unresolved for minutes, retains large snapshots, and blocks every queue consumer.
- **Fix:** splice/reject canceled entries immediately; add an active-job controller.

### C9. Save-time maintenance can delete newer unsaved assets (reproduced)
Cleanup runs against the project snapshot that began saving (`projectPersistenceController.ts:355,376` → `projectAssetMaintenance.ts:44-61`); a still durably committed while that save is in flight is not in the snapshot, gets treated as unreferenced, and its blob + object URL are deleted (`projectAssetStore.ts:276-292`). **Reproduced live during the audit**: transient payload existed before cleanup, was selected as stale, gone afterward. Second trigger vector: export-recovery live commits (`ExportWorkspace.tsx:223-227`, `packageExport.ts:443-455`, `ensureStillArtifactForExport.ts:163-169`) land outside any protected mutation and can be swept by an autosave already in flight.

- **Verify:** start a save, commit a new still mid-save, assert its blob survives cleanup; same for a recovered export still.

### C10. Reconciliation scheduler's final `setProject` can clobber another shot's committed artifact
`stillArtifactReconciliation.ts:203-210`: after `materializeShotStills` resolves, the scheduler does `setProject(result.project)` — a whole-project write, unlike every other write on the path (functional merges at `:199-202`, `materializeShotStills.ts:302-342`). `result.project` is captured by `readLive` one microtask earlier (`materializeShotStills.ts:428`).

- **Race:** shot B's merge commit lands between A's read and A's `.then`; A's `setProject(result.project)` overwrites B's committed artifact record. B's blob stays durable but unreferenced, and the next save's cleanup deletes it → **permanent loss of the render**.
- **Verify:** two-shot scheduler test forcing B's commit between A's completion and A's `.then`.
- **Fix:** drop the final write when `commitLiveProject` is supplied (already live), or make it a no-op `setProject(getProject())`.

### C11. Project switch never releases the departed project's blobs/object URLs
`useProjectStore.ts:65-71` switch path cancels prep, clears runtime maps, disposes the video service, rebinds reconciliation — but never releases memory. `projectAssetStore.ts:15-17` are module-global unbounded Maps; `makeObjectUrl:69-80` replaces per-key only. Cleanup sweeps only the *current* project's prefixes; `removeLocalProjectHistory` requires explicit user action.

- **Impact:** every project opened in a session retains its full image/video payload in memory and IDB indefinitely (multi-GB panos/stills in a local-first app).
- **Verify:** switch projects, assert `listProjectAssetBlobKeys()` no longer contains the departed project's `project/{oldId}/` keys (or add LRU and assert eviction).

### C12. Capture-path materialization is not cancellable
`useStillCaptureController.ts:207-219` calls `materializeShotAfterCapture` directly — no AbortSignal, no entry in `shotControllers` (`shotStillActions.ts:21,41-47`). Switch-time cancel (`useProjectStore.ts:66`) only aborts controllers and *queued* coordinator entries. Consequences: (a) a running job completes wasted; its commit is discarded by the fingerprint/shot guard and its blob deleted; (b) a queued job surfaces `setSnapshotError('Could not save the shot preview…')` for a *cancellation*; (c) stale `setStillArtifactJobStatus` calls re-insert runtime entries for the departed shot after `clearStillArtifactRuntime()` — the runtime layer (`stillArtifactRuntime.ts:44-47`) is shotId-keyed with no projectId scoping.

- **Verify:** capture in flight across `setProject(newId)` → signal observed, no error surfaced, runtime map empty after switch.

### C13. Agent pipeline cancellation/timeout paths orphan work
Multiple sites only change bookkeeping while the underlying render keeps running:

| # | Site | Behavior |
|---|------|----------|
| 1 | `jobQueue.ts:269-279` (`cancelAgentJob`), `:345-352` (`pauseAgentJob`), `:138-150` (`timeoutMsPerItem`) | Active item never receives a signal; a timed-out render keeps executing; with `continueOnError` the item is marked settled **while still running** and the next starts → concurrent GPU renders |
| 2 | `productionRunControl.ts:89-101`, sequential per-shot loop `:256-335` | Staleness checked only *between* shots; in-flight `renderShotFrame` runs to completion; cancel leaves the current shot partially materialized |
| 3 | `renderWorkCoordinator.ts:125-147` | Canceled-while-running entry keeps the slot until its `run()` settles (see C8) |
| 4 | `cancelShotStillPreparation` (`browserApi.ts:1247-1250`) | Signal stops at the next spec boundary, but specs already rendered still commit + prune → partial shot state after cancel |
| 5 | `cancelAgentPackageExport` (`packageExportControl.ts:44-73` → `throwIfAborted` `packageExportCore.ts:50`) | Cooperative between units; a 30s MP4 encode finishes its current encode; V2 temp cleanup only on success → leak on abort (see C3) |
| 6 | CLI 300s download window (`cli.ts:958-1006`, `previs.ts:1962-1971`) | `waitForEvent('download')` timeout → `catch(() => null)` → hard CLI failure **even though the browser produced the ZIP**; artifact lost (no saveAs) |

### C14. Agent video double-render
`videoRenderControl.ts:134-148` calls `renderShotCameraMoveMp4` directly, bypassing `prepareVideoArtifact`'s cache/inflight join. If a background video for the same shot is queued, the foreground entry (priority 5 vs background 6, `renderWorkCoordinator.ts:22-30`) jumps the queue, then both encodes run.

### C15. `isBusy` excludes prepared-media work
`browserApi.ts:301-309`; `waitForIdle` (`:1817-1861`) can report idle while the coordinator still renders → CLI `agent:package`/`agent:render-stills` proceed and contend for the single GPU slot.

### C16. `restorePreparedLegacyViewportSlots` mutates outside `runDestructive`
`useForeSceneAgentApi.ts:16-48,64`: raw `useProjectStore.setState` (torn-state race with other destructive ops); only restores stills present at call time.

### C17. Uncapped registries & mislabeled diagnostics
`artifactRegistry.ts:31` and `jobQueue.ts:40` accumulate blobs/entries for the whole session (no TTL/byte caps). `browserApi.ts:~1255` returns non-failure warnings as `code: 'thumbnail_attach_failed'` — mislabeled for consumers filtering on code.

---

## 3. Confirmed protocol divergence (highest-confidence finding)

**Installed `window.foreScene.captureShotThumbnail` ≠ declared protocol.**

- **Declared** (`protocol.ts:1805`): `captureShotThumbnail(...): Promise<AgentShotMaterializationResult>` with `artifacts`, `warnings`, `primaryStillAssetId`, `revisionId` (`protocol.ts:1440-1460`).
- **Implemented** (`browserApi.ts:1106+`): full await-all materialization returning exactly that type — **unreachable via `window.foreScene`**.
- **Installed** (`useForeSceneAgentApi.ts:70-112`): replaces `window.foreScene.captureShotThumbnail` with a v1 facade calling `api.renderShotFrame`, returning `AgentRenderShotFrameResult` (`{...rendered, ok, status, diagnostics}`) — no `artifacts`/`warnings`/`revisionId`/`primaryStillAssetId`; `width/height/pngDataUrl` semantics differ. Divergence is explicit in the module comment (`useForeSceneAgentApi.ts:5-7`).

**Asymmetries:** `captureShotPreparedMedia` is installed (`useForeSceneAgentApi.ts:60-66`) but undeclared in `protocol.ts` and absent from `discovery.ts`/`capabilities.ts` (0 matches) and `docs/agent-api.md`. `regenerateShotStills`/`retryFailedShotStills`/`cancelShotStillPreparation`/`inspectShotPreparedMedia` are declared (`protocol.ts:1805-1812`) and implemented (`browserApi.ts:1271+`) but never exercised by the facade.

**Impact:** every agent typed against `ForeSceneBrowserApi` reading `result.artifacts`/`warnings` gets `undefined` at runtime; TS can't catch it because `window.foreScene` is installed from a different, untyped facade. Callers requesting `timeSeconds` silently get time-0 materialization.

**Coverage gap:** `agentCaptureMaterialization.test.ts` is a source-text grep test against `browserApi.ts` — it passes while the installed API is the facade. No test exercises installed `window.foreScene`.

**Verify:** render the hook; assert installed `captureShotThumbnail` returns the declared shape (or the facade is removed) and that `captureShotPreparedMedia` awaits coordinator completion.

---

## 4. Inferred risks (need validation)

| # | Risk | Evidence | Confidence |
|---|------|----------|------------|
| R1 | C10 clobber window generalized: any non-scheduler store write (video `onPrepared` handler, second scheduler pass) between `materializeShotStills.ts:428` and `stillArtifactReconciliation.ts:207` is overwritten | trace | medium-high |
| R2 | `runDestructiveMutation` divergence: `noteProjectChange` suppressed during capture (`projectPersistenceController.ts:155`); partial commit failure leaves durable-but-unreferenced assets with no pending save — next save's cleanup is the only reaper and can race it (C9) | trace | medium |
| R3 | `ignoreNextProjectChange` is reference-equality-based (`useProjectLifecycle.ts:129` vs `projectSlice.ts:181-183`); normalized imports produce a different store object → spurious autosave ~700ms after every import, possible "Before removing saved project media" snapshot | trace | low-medium |
| R4 | `cancelShotStillPreparation` does not cancel the pending 400ms edit-reconcile timer for the same shot → cancel is transient for edit-triggered work | trace | low |
| R5 | In-flight `prepareStillArtifact` shared job aborts when its last subscriber leaves (`prepareStillArtifact.ts:207-212`), even mid-render — wasted GPU work under bursty UI | trace | low |

---

## 5. Throughput bottlenecks

### T1. Render coordinator: head-of-line blocking + bypasses (highest-impact)
`renderWorkCoordinator.ts:43-97` is a whole-promise semaphore with `MAX_CONCURRENT = 1`. A background MP4 holds the slot through cache access, scene setup, every frame, encoder finalization, and cache persistence. No active-job controller or preemption: a primary still waits for the full video. Meanwhile package videos bypass it (`packageExport.ts:125-169`) and agent review stills bypass it (`browserApi.ts:2147-2209`) — the system both over-serializes and permits competing WebGL jobs.

**Design:** separate GPU-frame/encoder/IDB/ZIP lanes; gate only WebGL work; track active background work and yield at frame boundaries when interactive work arrives; route every renderer through one executor; reject/remove canceled entries immediately; adaptive concurrency with GPU defaulting to one session.

### T2. Agent-only workflows never initialize background preparation
The only application init found is UI capture (`useStillCaptureController.ts:257-263`). Agent capture finishes (`browserApi.ts:1246-1260`) without binding/queueing the service; reconciliation refuses to queue without an existing scheduler (`stillArtifactReconciliation.ts:139-149`). Autonomous operation receives none of the branch's MP4 prewarming; package export remains the encoder bottleneck. **Fix:** bind during lifecycle/agent API setup; queue stable shots after agent mutations via a bulk `prepareMedia({shotIds})` job.

### T3. Agent video bypasses the fingerprinted cache and forces base64
`videoRenderControl.ts:131-148` calls `renderShotCameraMoveMp4` directly; attachment requests `includeDataUrl` and passes the base64 string (`:150-203`) — an already-prepared identical MP4 is re-encoded, then 33% base64 expansion plus a Blob conversion. **Fix:** use `prepareVideoArtifact`; add a Blob-native attachment API.

### T4. Every artifact rebuilds the whole render stack
Renderer/context, scene, materials, camera, textures created per artifact, then context loss forced. Projected renders reacquire the pano texture and release to refcount zero (`projectedStyleMaterials.ts:17-91`); `loadProjectedSceneResources` regenerates occlusion cubemaps (`renderers.ts:1283-1375`); depth range rebuilt per depth artifact (`stillArtifactRender.ts:117-124`) though materialization never supplies the existing `depthRange` hook; background depth candidates repeat it (`backgroundVideoPreparation.ts:207-220`).

**Design:** shot-scoped render session — one renderer/context + compiled scene per resolution/content layer; hold projected textures/occlusion maps for the batch; resolve shot-wide depth range once; update transforms between reference frames; derive with-people/clean-plate/character outputs from a shared layered render graph; dispose once after the batch.

### T5. Data-URL round trip + wasteful pixel stats per still
Clay/projected/depth render to `canvas.toDataURL`, then `stillArtifactRender.ts:138-175,192-254` decodes back to a Blob (`dataUrlToBlob` uses `atob` + byte-by-byte loop, `fileTransfers.ts:16-29`). Clay additionally allocates + reads a full RGBA buffer solely for pixel stats (`renderers.ts:1248-1261`) that materialization discards — 31.6 MiB at 4K. **Fix:** `toBlob`/`OffscreenCanvas.convertToBlob`; opt-in pixel stats; avoid `preserveDrawingBuffer` where capture timing permits; OffscreenCanvas worker for main-thread independence.

### T6. Fingerprints recomputed up to five times per artifact
Stale-only materialization computes at `materializeShotStills.ts:183-189`, `:231-235`, `prepareStillArtifact.ts:304-334`, `commitPreparedStillArtifact.ts:57-70`, and the final live merge `materializeShotStills.ts:302-312`. Each walks scene objects, builds dependency objects, stable-serializes, and fingerprints the timeline twice (`stillArtifactFingerprint.ts:87-181`). **Fix:** one shot dependency digest per immutable snapshot; derive artifact keys from digest + small spec; carry the fingerprint through prepare/commit.

### T7. Fingerprint dependencies broader than rendered pixels
Every still includes the whole shot timeline (`stillArtifactFingerprint.ts:87-90,137-149`) though viewport/character stills render only the current camera. `buildObjectRenderDependency` includes editor-only `locked` and wholesale metadata (`renderArtifactDependencies.ts:51-74`); video filtering ignores content mode (`videoArtifactFingerprint.ts:77-89`). **Impact:** keyframe/metadata edits regenerate unrelated outputs. **Fix:** per-artifact-kind dependencies; mutation-matrix tests asserting both required misses and hits.

### T8. Runtime events trigger whole-library expensive recomputation
`usePreparedMediaRuntimeTick.ts:5-40` exposes one global version; every card subscribes (`ShotsLibraryCard.tsx:48-54`); any artifact transition re-renders all cards and each runs `inspectShotStillRuntime` → full spec build + fingerprints (`stillArtifactRuntime.ts:198-217`). Scales ~ shots × artifacts × scene objects × status events. **Fix:** per-shot versioning/subscriptions; memoize status by project/shot input revision; one resolved poster/media summary into a memoized thumbnail.

### T9. Still persistence is transaction- and commit-heavy
Per-artifact IDB transaction + Zustand commit (`materializeShotStills.ts:221-405`, `commitPreparedStillArtifact.ts:126-137`); each project commit arms a 700ms autosave (`projectPersistenceController.ts:145-160,285-297`) — 4K artifacts interleave full revision work between outputs. **Fix:** batch prepared blobs into one `putProjectAssetBlobs` transaction; final-validate fingerprints; one project merge/autosave per shot or manifest batch.

### T10. Agent capture holds a protected persistence transaction through all rendering
`browserApi.ts:1122-1155` wraps the whole await-all render sequence in `runDestructive` (pre-change snapshot → mutate → write/reload verified revision, `projectPersistenceController.ts:197-230`); revision creation scans assets sequentially (`projectSafety.ts:438-494`). Blocks all other protected agent ops; repeated capture trends quadratic as prepared assets accumulate. **Fix:** render from a frozen snapshot outside the protected mutation; short artifact-specific atomic merge; coalesce derived media into one normal verified save after bulk runs.

### T11. Unbounded Blob caches
`projectAssetStore.ts:15-17,165-175` keeps every loaded/stored Blob + object URL until explicit deletion/test reset; project switching doesn't release them (C11). Agent artifacts: uncapped Map (`artifactRegistry.ts:17-65`). **Fix:** byte-budgeted LRUs, live-project pinning/refcounts, lazy object URLs, agent-artifact TTL/byte caps or durable spillover. Validate with `measureUserAgentSpecificMemory()`.

### T12. Video-cache LRU maintenance is O(n) with Blob-bearing rows per insert
`videoArtifactCache.ts:277-313` runs `getAll()` over the store, sorts, evicts per write → quadratic at 256 entries during bulk prewarming; every memory hit opens a write transaction for LRU metadata (`:342-360`). **Fix:** split metadata from Blob storage; indexed totals/oldest; throttled/batched touches; one bulk candidate read.

### T13. GPU/encoder left serial instead of pipelined
`videoEncode.ts:229-245` renders a frame then awaits encoder backpressure before the next; `BufferTarget` retains the complete MP4 in memory (`:210-214,268-274`). **Fix:** double-buffered canvases with a bounded queue (2–4) so GPU work for frame N+1 overlaps hardware encoding N; adapt depth to encoder pressure; streaming/chunked target into OPFS/cache/package output for long videos.

### T14. Package assembly eagerly duplicates binary data, main-thread, full-memory
`packageExportCore.ts:222-250` converts Blobs to ArrayBuffers for JSZip; video call sites repeat (`packageExport.ts:583-586,643-646,691-694`); `compressZip` builds a complete Blob on the main thread (`:147-190`); multi-shot writers are sequential (`packageExport.ts:339-353`, `packageExportV2.ts:1033-1046`). **Fix:** direct Blob input where supported → worker-based streaming ZIP; STORE for already-compressed PNG/MP4, compress only text/JSON; prefetch/batch IDB reads; release per-shot caches after last consumer.

### T15. Serial multi-shot legacy package loop
`packageExport.ts:339-353` `for...of` + `await appendShotPackageToZip`; every still goes through the single-slot coordinator → total ≈ Σ per-shot; interactive captures (priority 0) permanently starve export-recovery during long capture sessions.

### T16. Await-all capture is per-spec serial + per-spec commit
`materializeShotStills.ts:221-226` sequential spec loop, each through the coordinator (`:259-270`), each with full `save()` + prune (`commitPreparedStillArtifact.ts`); the facade then additionally base64-encodes and attaches a legacy duplicate. Capture resolves only after the last spec commit.

### T17. Per-frame `waitForIdle(60s)` round-trips
`renderSession.ts:141/151/215` before every frame in the serial batch loop (`:210-224`) — 60s budget × N frames of browser round-trip even when idle.

### T18. `renderShotBatch` hard-codes concurrency 1; `frameAgentSubjectsBatch` serial
`browserApi.ts:1797`; `batchControl.ts:43-50`; location-group batching (`renderSession.ts:207-253`) still renders one-by-one.

### T19. `runRenderPasses` executes 6 passes × shots
`cli.ts:653-689`, each a separate `page.evaluate` (pre-existing, but compounds with everything above).

### T20. No per-still timing metrics
`preparedMediaMetrics.ts` records only `exportVideoWaitMs`/`zipAssemblyMs`; render-cost distribution is unquantifiable.

---

## 6. Recommended autonomous pipeline (target architecture)

A single render DAG:

1. Plan all requested shot artifacts once from an immutable input revision.
2. Compute shared shot/scene digests; batch-query still/video caches.
3. Render only misses through long-lived shot sessions with frame-boundary priority yielding.
4. Encode with bounded GPU/encoder overlap.
5. Commit all validated outputs in one IDB transaction and one live project merge.
6. Stream Blobs directly into package output; never convert to base64 internally.
7. Return an agent job/artifact handle immediately with per-shot event subscriptions; only the final package barrier waits for unresolved misses.

The existing acceptance test (`tests/preparedMediaPerformanceAcceptance.test.ts:14-20,68-127`) uses a tiny mock renderer and checks render call counts only — it cannot catch WebGL setup, texture decode, IDB transactions, queue latency, ZIP memory, or React event storms. Add browser-backed acceptance gates for stage timings and peak memory.

---

## 7. Implementation plan

### Phase 0 — Regression tests for the data-loss races (before any fix)
| Test | Proves |
|------|--------|
| Two-shot scheduler interleaving (C10/R1) | B's `materializedMedia.stills` survives A's completion write |
| Save-vs-cleanup race (C9), both triggers | still committed mid-save survives; recovered export still survives autosave-in-flight |
| Superseded-asset leak (C1) | asset count constant across N regenerations; concurrent reference survives |
| Facade/protocol drift (P1) | installed `window.foreScene.captureShotThumbnail` returns declared shape; `captureShotPreparedMedia` awaits coordinator |
| Cancelled video status (C4) | aborted job → pending/absent, never `failed` |
| Blob-eviction recovery (C2) | deleted storage key → one recovery render |

### Phase 1 — Correctness fixes (data integrity first)
1. **C10**: remove the scheduler's final `setProject(result.project)` when `commitLiveProject` is supplied (or no-op it).
2. **C9**: cleanup against the project snapshot that *finished* verifying (or re-check each candidate key against the live store/commit registry before deleting); keep revision safety.
3. **C1**: remove `supersededAssetId` from the live merge; prune within the same merge.
4. **C2**: blob-bytes verification in the fast path (reuse `prepareStillArtifact`'s durable check).
5. **C4/C5**: propagate real cancellation (dedicated error type/name), per-candidate final state with diagnostics; owner metadata for queued video jobs.
6. **C3**: V2 recovery mirrors legacy `try/finally`; live-commit hooks; skip IDB persistence of export-only temp blobs.
7. **C7**: merge only the produced artifact into live state instead of restoring the snapshot.
8. **C6**: `try/finally` for clay/projected/projection-occlusion paths.
9. **C8/C13**: immediate splice/reject of canceled queue entries; signal the active item; surface job state honestly on timeout/pause/cancel (incl. CLI download window: keep the produced artifact and report success).
10. **C12**: AbortSignal through capture materialization; projectId-scope the runtime layer; distinguish cancellation from failure in UI.
11. **C11**: release departed project blobs/object URLs on switch (or LRU).
12. **C14–C17**: route agent video through `prepareVideoArtifact`; include coordinator work in `isBusy`; move legacy-slot restore into `runDestructive`; byte/TTL caps for registries; accurate warning codes.

### Phase 2 — Protocol/facade alignment
13. Make the installed `window.foreScene` match the declared protocol (`protocol.ts`): expose the await-all `captureShotThumbnail` (or remove the facade), declare + document `captureShotPreparedMedia`/`regenerateShotStills`/`retryFailedShotStills`/`cancelShotStillPreparation`/`inspectShotPreparedMedia` in `protocol.ts`, `discovery.ts`, `capabilities.ts`, `docs/agent-api.md`; honor `timeSeconds` in materialization.
14. Replace the base64 duplicate attach in the facade with the materialized asset (T16); Blob-native downloads (drop `blobToDataUrl` in `downloadAgentArtifact`).
15. Replace `agentCaptureMaterialization.test.ts`'s source-grep with a behavioral test driving the installed API.

### Phase 3 — Render throughput
16. **T1**: coordinator lanes (GPU-frame / encoder / IDB / ZIP), frame-boundary yield, single executor for all renderers, immediate cancel.
17. **T4**: shot-scoped render sessions (context/scene/texture/occlusion reuse across the batch).
18. **T5**: Blob-native capture (`toBlob`/`convertToBlob`), opt-in pixel stats, no `preserveDrawingBuffer` where possible.
19. **T6/T7**: one shot dependency digest per snapshot; per-kind dependencies; mutation-matrix tests.
20. **T2**: bind background prep in agent/lifecycle setup; bulk `prepareMedia({shotIds})`.
21. **T3**: agent video via fingerprinted cache.
22. **T17/T18/T19**: drop per-frame `waitForIdle` in batch loops; bounded concurrency for shot batches; fold render passes.

### Phase 4 — Persistence & caches
23. **T9/T10**: batch prepared blobs in one IDB transaction; one merge/autosave per shot batch; render outside protected mutation with atomic artifact merge.
24. **T11**: byte-budgeted LRU + live pinning for project assets and agent artifacts.
25. **T12**: split video-cache metadata from blobs; indexed LRU maintenance.
26. **T13**: double-buffered encode pipeline with bounded queue; streaming chunked output.
27. **T14/T15**: streaming ZIP (STORE for compressed media), direct Blob input, parallel shot packaging within lane limits.

### Phase 5 — Runtime & UI
28. **T8/D4**: per-shot runtime subscriptions/versioning; memoized status per project/shot revision; single resolved poster into memoized thumbnail.
29. **D5**: label noise — suppress "No references configured"/"Video pending" for shots outside the prepared lifecycle.
30. **D6**: reconcile `resolveShotThumbnail` priority with `resolveShotMediaPoster` so grid and cards agree.
31. **T20**: per-kind still render timing metrics for capacity planning.

### Acceptance criteria
- Deterministic two-shot + save-in-flight tests pass with zero data loss (Phase 0 tests).
- Warm still reuse: zero renders; metadata-only edits: zero renders; camera edit: only affected shot regenerates (existing acceptance suite).
- Browser-backed stage-timing gates: primary-still queue latency bounded to a frame boundary during background MP4; per-transition card render count = 1; ZIP peak memory bounded.
- Installed-agent API shape tests pass (Phase 2).

---

## 8. Coverage gaps in the existing suite
None of `stillArtifactReconciliation.test.ts`, `liveStillCommit.test.ts`, `preparedMediaConcurrencyRegression.test.ts`, `projectAssetMaintenance.test.ts`, or `agentCaptureMaterialization.test.ts` exercise: the scheduler final-`setProject` interleaving (C10), switch-time blob release (C11/C2), the installed-facade shape (P1), or settled-but-running cancellation (C8/C13) — all green-field tests listed in Phase 0.
