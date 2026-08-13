# Grok Build CLI closure goal 10: close the CLI shot-selection contract

You are working in the ForeScene/PanoRef repository. Use Grok 4.6 with high reasoning effort. Continue the existing benchmark-remediation work in the current checkout. Do not commit or push.

The ninth remediation closure is complete and its independent focused tests pass. During the adversarial audit I found a concrete CLI contract mismatch that must be fixed before this work can be considered complete:

1. `scripts/agent/cliCommands.ts` and the user-facing docs say `verify` uses `collectVisualPreflightValidation`, and explicitly say an `--shots` selection that matches nothing fails. `scripts/agent/cli.ts` parses `--shot`/`--shots`, but `runVerify()` does not accept or pass `shotIds`; it always calls `api.collectVisualPreflightValidation()` with no selection. Therefore `agent:verify -- --shots <id>` silently validates every shot, and an unknown requested ID is silently ignored. This is an actual behavior/documentation contradiction, not a test-only concern.

Implement the smallest complete repair:

- Thread `args.shotIds` through the `verify` command into `runVerify()` and pass it to the browser API when the selection is explicit.
- Preserve the intended distinction between omitted selection and an explicitly supplied selection. Unknown IDs and an explicitly empty result must make the visual validation fail, with the unmatched IDs/diagnostic visible in the JSON result and provenance.
- Audit other commands that parse the shared `--shot`/`--shots` flags but are single-shot commands (`frame`, `video`, and any analogous command). Do not let a multi-ID value be silently truncated; either implement a clearly documented multi-shot behavior or reject it with an actionable argument diagnostic before opening the browser. Keep existing documented single-shot forms working.
- Audit `asset-contract`, which currently uses only the first parsed shot ID. Decide from its documented contract whether it should support all requested IDs or reject multiple IDs explicitly; do not silently ignore additional IDs. Keep the API's `shotId` form intact.
- Add behavioral/command-level regression tests that would fail against the current code: verify's selected IDs reach the collection path and unknown IDs fail; single-shot commands do not silently discard a second ID. Prefer a small extracted pure argument/selection helper if needed so this is testable without a live browser, but also keep the live CLI help/docs aligned.
- Update `docs/agent-api.md`, `docs/agent-playwright.md`, `skills/forescene-previs/SKILL.md`, or help text only where the actual supported command behavior changes. Do not claim a feature that is not implemented.

Re-read the prior remediation around visual gates, provenance/run identity, cancellation, artifact transfer, package proof, recovery, cache telemetry, and job generation cleanup. Fix any adjacent concrete issue you encounter in these in-scope CLI paths, but avoid unrelated refactors.

Required verification before reporting completion:

1. Focused tests for the changed CLI/visual-selection paths, including the new regressions.
2. `npm.cmd run test` (serial full fast suite), `npm.cmd run lint`, and `npm.cmd run build`.
3. Live machine-readable help: `npm.cmd run agent:help -- --json`, confirming it remains valid JSON after the npm banner and advertises the real selection semantics.
4. `git diff --check`.
5. `PLAYWRIGHT_SKIP_BUILD=1 npm.cmd run test:e2e:smoke` (all Chromium smoke tests).

Preserve user-owned `output/`, `.playwright-cli/`, benchmark files, session notes, and all existing remediation changes. Do not weaken or delete tests. Report exact test counts, warnings, changed files, and any genuine blocker. Do not stop at a report: implement the goal.
