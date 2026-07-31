# Error recovery

## Manifest validation failed

Fix the listed diagnostics (`duplicate_shot_number`, `unknown_reference`, `unsupported_template`, …).
Re-run; do not reset unless the project itself is wrong.

## Hash mismatch on resume

`run-state.json` belongs to a different manifest.

**Correction loop (preferred):**

1. Edit only failed/warned shots in the manifest.
2. Re-run with `--update-manifest` (no `--reset-project`).
3. ForeScene invalidates only changed shots and dependents; completed shots stay complete.

```bash
npm run agent:previs -- \
  --manifest path/to/manifest.json \
  --write \
  --update-manifest \
  --output artifacts/previs
```

**Location / cast / prop edits:** also pass `--reset-project` with `--update-manifest` so the scene rebuilds without duplicate creates. Shot-only edits do not need `--reset-project`.

**Full restart:** `--reset-project` with a fresh/clean `--output` directory.

## Partial run / browser closed

Re-run the same command **without** `--reset-project`. Completed phases and shots are skipped.

## Shot compile/render failed

1. Read `validation.json` / `run-state.json` for that shot number.
2. Adjust blocking, camera template, or subjects.
3. Re-run with `--update-manifest`.

Automatic repairs (max 2 attempts/shot):

- subject_too_small → move closer
- subject_too_large → pull back
- subject_out_of_frame → recenter
- camera_inside_geometry → alternate angle
- character_underground → reground
- subjects_overlapping → separate / pull back

After each repair, ForeScene reloads the project document and re-validates.
After repairs are exhausted, the shot is `needs_review` and the run continues.
