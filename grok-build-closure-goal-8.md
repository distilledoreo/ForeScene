# Grok Build CLI closure goal 8: drain paused generations before resume

You are working in the ForeScene/PanoRef repository. Use Grok 4.6 with high reasoning effort. Continue the existing remediation work in the current checkout. Do not commit or push.

The seventh closure pass made stale-generation mutations safe and made unresolved visible renderables fail the ordinary visual gate. Independent checks after that pass are green: focused remediation tests, the full fast suite (208 files, 1547 tests), lint, build, CLI help JSON, diff check, and Chromium smoke 22/22. Do not stop at those results; close the runtime race below and add regression coverage.

## 1. Do not overlap a paused generation with its resume

`src/engine/agent/jobQueue.ts` now prevents late generation-1 results from mutating generation-2 state, but `resumeAgentJob()` can still start generation 2 while a generation-1 handler that ignores AbortSignal is still executing. The current adversarial test demonstrates this with `handlerCalls === 2`, but it does not assert that the calls are serialized. That can duplicate GPU/render work and is exactly the orphaned-work cost the benchmark exposed.

Implement a real drain/serialization contract:

- pause/cancel may mark the public job state immediately and abort the captured controller;
- `resumeAgentJob()` must await the paused/failed generation's in-flight worker/handler drain before launching the new generation;
- generation 2 must not invoke a handler until every generation-1 handler has settled, even when the old handler ignores AbortSignal;
- preserve terminal cancel behavior, timeout behavior, retry semantics, artifact pin release, and the stale-generation guards;
- avoid a race when two resumes are requested and avoid leaving an unhandled promise behind.

If the existing timeout/orphan policy deliberately waits for a handler to settle, preserve that invariant and document it. Do not “solve” this by abandoning a live handler or by weakening the tests.

Add a deterministic regression test that pauses a signal-ignoring handler, calls `resumeAgentJob()` while the old handler is blocked, proves the resume promise/new handler cannot start yet, releases the old handler, and then proves the new generation starts only after the old one has settled. Assert no overlapping handler interval and no duplicate in-flight artifact pin. Update existing stale-generation tests to assert the intended serialized behavior.

## 2. Audit vacuous visual verification and empty selections

Check the full path from CLI shot selection through `recordRunValidation` / `composeAgentValidationEvidence`. Look for these concrete false-pass cases:

- `composeAgentValidationEvidence({ visualPreflight: [] })` currently derives a passed visual gate from an empty status list;
- a CLI visual-preflight/verify selection containing only nonexistent shot ids may select zero shots and use `every(...)`, which can report success vacuously.

Choose and document the correct contract. An explicitly requested visual selection with no matching shots must fail with a useful diagnostic; an explicitly supplied empty visual result must not claim a fully passed visual gate. Preserve the distinction between an omitted gate (skipped because the caller did not request it) and a requested-but-empty gate (invalid/failed). Add tests through the real CLI/API composition path. Ensure `verify` still behaves correctly for genuinely empty projects if that is a supported state.

## 3. Adjacent audit and verification

Re-audit package ZIP proof, bounded artifact transfer, retry/cancel telemetry, revision-bound evidence, cache/in-flight cleanup, provenance, and visual warning propagation for equivalent “work still running” or vacuous-pass loopholes. Fix concrete issues in scope and update docs/help when public semantics change.

Run focused tests, then the full unit/integration suite serially, `npm run lint`, `npm run build`, `npm run agent:help -- --json`, `git diff --check`, and the Chromium smoke suite. Report exact results and any existing build warnings. Do not commit or push.
