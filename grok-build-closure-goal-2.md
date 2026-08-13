# Grok Build CLI closure goal 2

The first closure pass is not complete. An independent `npm.cmd run test` failed in `tests/skillSync.test.ts`: the canonical `skills/forescene-previs/SKILL.md` and `.claude/skills/forescene-previs/SKILL.md`, `.grok/...`, `.kilo/...` adapters are not byte-identical because of LF/CRLF drift. Fix this using the repository's official skill-sync workflow and verify the invariant with the actual test. Do not weaken the test or normalize the assertion.

Then perform a second adversarial audit of the closure implementation, not merely a report. Re-read the final diff and close any remaining source gap you can prove:

- Confirm `linkAllShotsToCanonicalPano` preserves explicit `linkedPanoId: null` through every real caller and that force relinking is explicit.
- Confirm visual preflight fails missing requested subjects, uses effective shot state, samples keyframes, and that the normal previs repair loop restores the complete prior shot when a worse candidate is attempted.
- Confirm `agent:visual-preflight`, `agent:asset-contract`, and normal `verify`/`previs` outputs are real executable CLI paths with aligned help/docs.
- Confirm recovery-resource reconciliation actually blocks current missing binaries before backup/package export and does not silently discard a live project asset.
- Confirm package assembly and artifact transfer do not make a whole-file `Array.from(bytes)` or equivalent number-array copy; if the runtime necessarily returns a Blob, keep the bounded fallback explicit and tested. Confirm concurrency settings are bounded and safe.
- Confirm provenance/cache telemetry records operation-level decisions rather than entry totals, and includes source/build/profile identity, timings, retries/cancellation, and artifact identity where available.
- Confirm persisted/authoritative/project-attached/in-flight artifact handles cannot be evicted before a caller can download them.
- Confirm video API results are artifact-first and download is explicit.

Preserve user-owned `output/`, `.playwright-cli/`, benchmark files, and session notes. Do not weaken tests. Run focused checks, then `npm.cmd run lint`, the full `npm.cmd run test`, `npm.cmd run build`, `git diff --check`, and a live CLI help/smoke command. Finish only after the skill-sync failure and any other verified gap are fixed.
