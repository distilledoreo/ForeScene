# Grok Build CLI closure goal

The first remediation pass was useful but is not complete. Treat this as a concrete engineering closure goal, not a request for another report. Work directly in the current ForeScene repository and implement, test, and verify the remaining benchmark-derived issues below. Use the existing architecture and preserve unrelated user-owned artifacts. Do not modify `output/`, `.playwright-cli/`, generated harness adapters, or the existing benchmark artifacts.

## Verified gaps to close

1. Durable panorama unlink semantics are still broken in application paths. `linkAllShotsToCanonicalPano` and its callers can relink a shot whose `linkedPanoId` is explicitly `null` during workspace open, canonical-pano import/replacement, and pano add/remove flows. Preserve explicit unlink across those paths and export/import. If an operation truly needs force-relink-all, make that an explicit separate operation. Add regression tests for each relevant path.

2. Visual preflight is too permissive. A missing requested subject can still produce `ok: true`; camera-direction checks use base scene positions instead of shot-effective state; and one-time sampling does not cover camera keyframes/motion. Make missing requested subjects a failure, use effective shot state, sample meaningful keyframe/time points, and expose per-sample failures. Integrate visual preflight and full-shot candidate evaluation into the normal `scripts/agent/previs.ts` repair loop so a worse repair cannot persist after a better candidate. Rollback must cover camera, keyframes, object overrides, pano linkage, and other shot-scoped mutations. Add a regression test that proves a worse full-shot repair is rejected/restored.

3. The new visual-preflight, asset/pose-contract, repair-candidate, provenance/cache, and resume/cancel capabilities are not sufficiently exposed through the normal CLI workflow. Add focused CLI commands or make standard `previs`/`verify`/`package` invoke and report the relevant checks. Keep help/discovery/docs aligned and add CLI tests.

4. Recovery-resource failures remain possible before package/export. Reconcile and verify project recovery resources/manifests before export, including missing recovery PNG/binary diagnostics, and add a regression test for the benchmark failure mode. Do not merely suppress the error.

5. Package and artifact paths still carry avoidable performance cost. `packageExport.ts` still builds JSZip archives in memory, and `artifactIo.ts` still transfers binary data through `Array.from(bytes)`. Implement a safe streaming/direct-transfer path where the current runtime permits it; otherwise isolate and document the bounded fallback with tests. Add bounded configurable batch concurrency where safe, and remove remaining unnecessary per-frame/warm `waitForIdle` calls in the normal render path without weakening correctness.

6. Provenance/cache telemetry is still incomplete. Add stable app/build/source commit identifiers when available, CLI/harness/profile identity, operation timings, retries/cancellation, artifact identifiers/hashes, and per-operation cache hit/miss/reason data to run provenance and the CLI/run manifest. Do not label entry totals as operation-level hits/misses.

7. The artifact registry LRU must not evict persisted, authoritative, project-attached, or in-flight artifacts needed by callers. Pin those classes, expose actionable eviction information, and add a regression test.

8. Keep `runAgentShotVideo` artifact-first for API callers where possible; make browser download side effects explicit rather than the only reliable result path.

## Verification requirements

Run focused tests while iterating, then at minimum `npm.cmd run lint`, the relevant targeted Vitest files, the full `npm.cmd run test`, `npm.cmd run build`, and `git diff --check`. Exercise a real CLI/help or smoke path for changed commands. Inspect the final diff and report any genuinely external limitation (for example, an already-deployed hosted URL) separately from source-repository completion.

When done, summarize exact files, tests, and any residual limitation. Do not stop at identifying gaps; implement the fixes.
