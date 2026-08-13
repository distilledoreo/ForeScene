# Grok Build CLI closure goal 9: clean up late unpublished job artifacts

You are working in the ForeScene/PanoRef repository. Use Grok 4.6 with high reasoning effort. Continue the existing remediation work in the current checkout. Do not commit or push.

The eighth closure pass serialized paused-generation resume and rejected empty visual selections. Independent checks after that pass are green. Do not stop at those results; close the artifact-lifecycle leak below and add regression coverage.

## 1. Close the late-artifact pin leak

Re-audit `src/engine/agent/jobQueue.ts` together with `artifactRegistry.ts` and the production job handlers. A signal-ignoring handler can create/register a real artifact with `jobId` and `inFlight: true` (and usually `authoritative: true`) after pause/cancel, then call `ctx.registerArtifact()` after the generation is no longer current. The stale context call is correctly ignored, but the artifact is not in `job.artifactIds` or the run's published artifact list. The current cleanup only releases tracked artifact IDs, so this ignored late output can remain pinned forever and defeat the cache/memory cleanup contract.

Implement a safe ownership/cleanup contract:

- A late artifact from an aborted/stale generation must not appear as a successful job result and must not remain pinned as an orphan after that generation drains.
- Cleanup must happen after the old generation's handlers have settled, including when pause/cancel marked public state immediately.
- Preserve artifacts published by the current generation and preserve legitimate persisted/project-attached artifacts. Do not release or delete an artifact belonging to a still-active generation.
- Preserve the existing stale-mutation guards, resume drain serialization, terminal cancel behavior, timeout behavior, retry semantics, and exactly-once release behavior.
- Avoid unhandled rejections and make reset/test cleanup safe.

Prefer a run/job ownership mechanism or an explicit post-drain cleanup of unpublished artifacts associated with that job; do not rely only on the caller remembering to call `ctx.registerArtifact()`. If deletion is the right cleanup for an unpublished job output, make that policy explicit and ensure it cannot remove a published/persisted/project-attached artifact.

Add a deterministic regression test that pauses or cancels a signal-ignoring handler, has it create a real `registerAgentArtifact({ jobId, inFlight: true, authoritative: true })` after abort and then call `ctx.registerArtifact()`, releases the handler, and proves:

1. the late artifact is absent from the completed/resumed job result;
2. it is no longer pinned (or is removed according to the documented orphan policy);
3. the current-generation artifact remains correctly pinned while running and is released once on completion; and
4. the behavior is safe for both pause/resume and terminal cancel if both paths are affected.

## 2. Adjacent adversarial audit

While in this area, check for equivalent untracked late artifacts across render-shot, pass-matrix, and contact-sheet handlers, and check that cleanup does not accidentally release a valid artifact from a concurrent worker in the same active generation. Re-check cache/in-flight telemetry, provenance, and job snapshots for false success or retained work. Fix concrete issues in scope and update docs/help/tests when public semantics change.

Run focused tests, then the full unit/integration suite serially, `npm run lint`, `npm run build`, `npm run agent:help -- --json`, `git diff --check`, and the Chromium smoke suite. Report exact results and any existing build warnings. Do not commit or push.
