# Grok Build CLI closure goal 7: stale job generations and visual-gate semantics

You are working in the ForeScene/PanoRef repository. Use Grok 4.6 with high reasoning effort. Continue the existing remediation work in the current checkout. Do not commit or push.

The benchmark remediation has already gone through six Grok closure passes. The independent gates are currently green: the full unit/integration suite passes serially (208 files, 1543 tests), TypeScript lint passes, the production build passes, `npm run agent:help -- --json` is valid, `git diff --check` passes, and the Chromium smoke suite passes 22/22. This is not permission to stop at green tests: perform the adversarial closure below and fix any issue you find.

## Required adversarial closure

### 1. Make job-generation isolation real, not just finalization-safe

Audit `src/engine/agent/jobQueue.ts` and its tests. The current generation guard appears to protect final/catch state transitions, but the old `runJob` closures still read the mutable `job.abortController` and share `completedIndexes`, `errors`, `artifactIds`, and pin-release bookkeeping with a resumed run.

Add a deterministic regression test with a handler that deliberately ignores the AbortSignal and resolves late:

1. start a job;
2. let the first handler begin;
3. pause it;
4. resume it before the old handler resolves;
5. resolve the old handler after the new generation has begun.

Prove that the stale generation cannot duplicate work, mark current-generation items complete, append stale errors, register stale artifacts, release or resurrect current pins, or overwrite the current status/finishedAt. Capture the controller/signal and generation per run, and guard every shared-state mutation that can be reached by a late handler. Isolate per-run artifact bookkeeping where needed. Preserve valid pause/resume/cancel behavior and add tests for the terminal cases.

### 2. Ensure visual preflight warnings cannot masquerade as a fully passed quality gate

Audit `src/engine/visualPreflight.ts` and the validation/provenance composition path. The current policy reportedly turns a visible shot containing a recognized subject plus an unresolved visible renderable object (for example, an imported prop or model) into a warning while leaving `item.ok === true`. `composeAgentValidationEvidence`/`recordRunValidation` count `!item.ok`, so the visual gate can still report passed even though content was silently omitted from the scored subject set. That recreates the benchmark’s central failure mode: structural validation passes while visual intent is not fully accounted for.

Define and implement an explicit policy:

- explicit environment-only shots remain valid;
- an ordinary shot with unresolved visible renderable content must not report a fully passed visual gate;
- if a non-blocking set-dressing mode is intentionally supported, it must be an explicit, persisted opt-in and must be represented in the validation summary/provenance as a warning state rather than `passed`/`ok:true`.

Add a contract test through the real validation composition path proving that a mixed human/prop shot with the prop unresolved cannot pass the ordinary visual gate. Cover empty-set/no-intent behavior and requested subject IDs too. Update CLI/report/provenance fields and docs if their semantics change. Do not silently drop visible object IDs.

### 3. Audit adjacent proof and lifecycle edges

Re-read the recent remediation around package ZIP proof, bounded artifact transfer, retry/cancel telemetry, revision-bound validation evidence, cache/in-flight cleanup, provenance, and CLI run identity. Look specifically for any equivalent stale-generation, “warning but passed”, fabricated-proof, or terminal-lifecycle loophole. Fix only concrete issues in scope and add regression coverage.

## Verification required before you finish

Run focused tests for the changed behavior, then the full unit/integration suite serially, `npm run lint`, `npm run build`, `npm run agent:help -- --json`, `git diff --check`, and the Chromium smoke suite. Report exact results and any pre-existing build warnings. Do not commit or push.

Completion means the implementation and tests close the two adversarial cases above, not merely that existing tests remain green.
