# Grok Build CLI closure goal 3

The second pass fixed skill-sync and the full independent suite passes, but the adversarial source audit found remaining concrete gaps. Implement them directly; do not just document them.

## Proven gaps

1. `src/engine/agent/assetPoseContract.ts` still reports `includedInPackage: Boolean(object.modelAssetId) && !missing.has(...)`. That is not package inclusion verification; an available asset can still be omitted from a package manifest. Change the contract/API so it cannot claim inclusion without using the real export inclusion rules/manifest (or explicitly reports `not_verified` rather than false-positive `true`). Add regression tests for an available-but-not-package-verified model and for verified inclusion.

2. `runProvenance` artifact entries still expose IDs/sizes/revisions but no content hashes, despite the benchmark requirement for artifact identity/hashes. Add stable SHA-256 (or an explicit unavailable state) to registered artifact metadata and provenance/run manifests. Do not claim a hash merely because an artifact ID exists. Add tests.

3. Audit current-project recovery handling for assets whose `resolutionStatus` is `missing`, `corrupt`, or `unsupported`. A current project resource must not silently disappear from reconciliation just because its status is non-available; package/backup should either produce the existing actionable missing-asset diagnostic or the new recovery diagnostic and block when the binary is required. Add the regression case that most directly represents the benchmark’s missing recovery PNG/binary failure.

4. Audit every `registerAgentArtifact` caller. Any result handle that a caller is expected to download after an operation must be authoritative/pinned or otherwise protected until retrieval. In particular check still-frame, pose, production/job, storyboard/contact-sheet, package, backup, and video results. Add a focused regression test for the most exposed unpinned result.

5. Re-check the package/CLI transfer path for whole-file copies. Keep the chunked binding path as the normal path, but ensure the fallback is explicit, bounded, and never silently selected after a failed binding setup when the caller needs a reliable artifact. If the browser API must return a Blob, keep that limitation honest and ensure telemetry names the transfer mode.

Preserve `output/`, `.playwright-cli/`, benchmark artifacts, session notes, and generated skill adapters except through the official sync workflow. Do not weaken tests. Run focused tests, then `npm.cmd run lint`, full `npm.cmd run test`, `npm.cmd run build`, `git diff --check`, and `npm.cmd run agent:help -- --json`. Finish only after each proven gap is either fixed with a regression test or explicitly impossible for a demonstrated runtime reason.
