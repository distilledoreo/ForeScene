# Rapid Previs

Rapid-previs is the default quality mode for rough, communicative, editable
frames used as spatial control references.

## Core loop

```text
Inspect once
→ verify the unique working project
→ resolve bindings and capabilities once
→ run the three-part canary
→ author 6–8 shots
→ save and reopen once
→ render one frame per shot and one contact sheet
→ apply camera-only shot-size cleanup
→ human accepts or rejects
→ revise rejected shots only
```

Use 3–4 shots while capabilities are unproven. After the canary passes, use
6–8 shots per batch. Apply all batch writes before the single reopen check and
do not reopen per shot.

## Acceptance

Objective validation checks project/shot identity, character variant,
closed-world presence, location/panorama, required pose telemetry, missing
assets, nonblank render, persistence, and gross cropping. Human review decides
whether the frame communicates the shot.

Use these categories:

- `accepted`
- `accepted_asset_limited`
- `needs_revision`
- `blocked_capability`

Quarantine failed or blocked shots instead of blocking unrelated shots. Do not
run broad autonomous repair. Preserve the capability map, batch persistence
record, frame directory, contact sheet, and concise blockers.

## Framing cleanup

Compare the achieved frame with the original shot-list Framing field. Apply
camera-only corrections to obviously over-wide or over-tight frames, regenerate
the contact sheet, and stop for human review. Do not restage, rebind, rerig, or
perform autonomous creative repair during this pass.
