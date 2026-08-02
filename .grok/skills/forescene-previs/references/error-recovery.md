# Error recovery and evidence-based summaries

## Preservation or reset conflict

If inspection finds shots or panoramas and the user did not explicitly authorize reconstruction, stop any reset path. Do not use `--reset-project` or `resetProject`. Write the preservation preflight, refine incrementally, and retain all required IDs. A final preservation check with missing IDs is a failed run.

## Manifest validation failed

Fix the listed diagnostics (`duplicate_shot_number`, `unknown_reference`, `unsupported_template`, invalid motion duration/order, unknown subjects, or invalid pose presets). Re-run validation; do not reset unless the user explicitly asked to reconstruct the project.

For motion, correct duration, keyframe order, final keyframe time, unknown subjects, invalid pose presets, excessive movement, or a subject leaving the usable set zone. Reduce keyframes before attempting to approximate nuanced acting.

## Hash mismatch or stale manifest on resume

`run-state.json` belongs to a different manifest.

1. Edit only failed/warned shots when creative intent changed.
2. Re-run with `--update-manifest` and without `--reset-project` for shot-only edits.
3. Confirm the changed shot is invalidated and its old MP4 is not reused.

For a retained project, location, cast, or prop changes are incremental refinement work. Import/update the affected asset and selected shot plans; do not use reset as a duplicate-create workaround. A full reset requires explicit reconstruction authorization and a preservation record that acknowledges it.

## Export-plan omission

Call `createExportPlan()` after changing export settings. If a required projected artifact is omitted with `missing-projector`, stop and repair the usable panorama/projector or obtain an explicit revised deliverables request. Any required omitted kind blocks package success.

## Video cancelled, stale, or failed

- Re-run the same valid work without resetting.
- Check the current busy state and viewport readiness before retrying.
- Confirm the previous valid video remains untouched; do not treat a partial replacement as valid.
- For a changed shot, verify the prior MP4 is invalidated and render a new artifact.
- Render and inspect start, midpoint, and endpoint stills, then open or sample the MP4 before approving it.

## Visual or batch review failed

Read the batch review and correct the actual visual cause: subject selection, character variant, real-creature replacement, staging, camera, timeline, required prop, or output pass. Let ForeScene’s numeric repair system handle only the mechanical framing issue after the creative selection is correct.

Do not advance to the next batch until every shot in the current batch passes a fresh visual review. If the frame is visually unusable despite a passing `validation.json`, the shot remains failed.

## Partial run or browser closed

Re-run the same command without resetting. Completed phases and shots are reusable only when their inputs and scene revision remain valid. Recheck the preservation record, changed shots, and artifact timestamps before trusting prior outputs.

## Final summary integrity

Derive final summaries from verified artifact records and passed review records, not intent, filenames, estimated export-plan counts, or `validation.json` pass counts alone. State that a deliverable succeeded only when all of these are true:

1. The required file exists and is nonempty.
2. Its pass/shot identity is correct.
3. Its associated visual review record passed.
4. Its latest render occurred after the latest relevant scene change.

Never claim four successful videos when logs show four failures, creatures refined when the refinement log applied no commands, or all 31 shots complete when some are visually empty. A required failed artifact makes `productionComplete: false`.

```json
{
  "requestedShots": 31,
  "visuallyApprovedShots": 22,
  "failedShots": 9,
  "requiredArtifacts": 186,
  "verifiedArtifacts": 158,
  "failedArtifacts": 28,
  "productionComplete": false
}
```

## Agent busy

Wait through `window.foreScene.waitForIdle({ timeoutMs: 60_000 })` or retry after package export, graybox render, character import, or video activity finishes. `waitForIdle` only covers busy state; use viewport readiness before judging a frame. Never start overlapping Agent writes.
