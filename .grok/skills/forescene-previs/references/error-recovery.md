# Error recovery

## Manifest validation failed

Fix the listed diagnostics (`duplicate_shot_number`, `unknown_reference`, `unsupported_template`, invalid motion duration/order, unknown subjects, or invalid pose presets). Re-run validation; do not reset unless the project itself is wrong.

For motion, correct duration, keyframe order, final keyframe time, unknown subjects, invalid pose presets, excessive movement, or a subject leaving the usable set zone. Reduce keyframes before attempting to approximate nuanced acting.

## Hash mismatch or stale manifest on resume

`run-state.json` belongs to a different manifest.

1. Edit only failed/warned shots when creative intent changed.
2. Re-run with `--update-manifest` and without `--reset-project` for shot-only edits.
3. Confirm the changed shot is invalidated and its old MP4 is not reused.

Location, cast, or prop edits also require `--reset-project` with `--update-manifest` so the scene rebuilds without duplicate creates. A full restart uses `--reset-project` with a fresh or clean output directory.

## Video cancelled

- Re-run the same manifest without resetting.
- Check the current busy state before retrying.
- Confirm the previous valid video remains untouched; do not treat a partial replacement as valid.

## Video stale after a manifest update

- Re-run with `--update-manifest`.
- Confirm the changed shot’s video is invalidated.
- Do not reuse the previous MP4; render a new artifact and review its temporal samples.

## Video render failed

1. Inspect progress and diagnostics.
2. Verify viewport readiness with `waitForViewportReady`, not only `waitForIdle`.
3. Render start, midpoint, and endpoint still frames separately.
4. Decide whether the failure is rendering-related or authoring-related.
5. Retry the video only after the static samples pass.

## Motion validation failed

Correct the reported field rather than hiding the failure:

- `durationSeconds` must be positive and equal the final keyframe time.
- Keyframe times must be strictly increasing; use at least two.
- Subjects and pose presets must exist and be supported.
- Movement must remain conservative and within the usable set zone.

## Shot compile/render failed

Read `validation.json` and `run-state.json` for the shot. Adjust blocking, camera template, subjects, or motion intent, then re-run with `--update-manifest`. Let ForeScene’s numeric repair system handle distance, recentering, headroom, and OTS shoulder corrections.

## Partial run or browser closed

Re-run the same command without `--reset-project`. Completed phases and shots are skipped when their inputs remain valid.

## Agent busy

Wait through `window.foreScene.waitForIdle({ timeoutMs: 60_000 })` or retry after package export, graybox render, character import, or video activity finishes. Never start overlapping operations. `waitForIdle` only covers busy state; use viewport readiness before judging a frame.
