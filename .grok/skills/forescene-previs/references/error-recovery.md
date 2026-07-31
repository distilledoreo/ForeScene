# Error recovery

## Manifest validation failed

Fix the listed diagnostics (`duplicate_shot_number`, `unknown_reference`, `unsupported_template`, …).
Re-run; do not reset unless the project itself is wrong.

## Hash mismatch on resume

`run-state.json` belongs to a different manifest. Either:

- restore the original manifest, or
- start fresh with `--reset-project` and a new/clean `--output` directory.

## Partial run / browser closed

Re-run the same command **without** `--reset-project`. Completed phases and shots are skipped.

## Shot compile/render failed

1. Read `validation.json` / `run-state.json` for that shot number.
2. Adjust blocking, camera template, or subjects.
3. Re-run without reset.

Automatic repairs (max 2 attempts/shot):

- subject_too_small → move closer
- subject_too_large → pull back
- subject_out_of_frame → recenter
- camera_inside_geometry → alternate angle
- character_underground → reground
- subjects_overlapping → separate / pull back

After repairs fail, the shot is `needs_review` and the run continues.
