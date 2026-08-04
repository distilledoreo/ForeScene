# Visual acceptance is authoritative

Human review remains authoritative for rough previs. Objective validation proves
state and render health; it does not decide whether a frame communicates the
shot.

## Required visual checks

For each final still, compare the opened frame with its shot description. Confirm that:

- The intended primary subject is visible.
- The camera frames the intended subject region and composition.
- Required scene elements and replacement assets actually appear.
- The correct character variant is staged where required.
- Required clay, projected, clean-plate, character-only, and depth passes are meaningful and present.

For humanoid shots, compare the achieved frame with the original shot-list
Framing field: extreme close-up isolates the named detail; close-up is head and
shoulders; medium close-up is head through upper chest; medium is head through
waist; medium full is head through knees; full/wide includes feet only when
requested. Ambiguous humanoid shots default to medium. Aim using rig-derived
head, eyes, and chest landmarks, never the character root or complete assembly
center. Use shield or weapon bounds only for crop safety.

Empty rooms, irrelevant fragments, a missing required scene element, and an
obscured intended subject fail. In rapid-previs, a supplied asset that cannot
provide a requested pose or embedded feature may be accepted as
`accepted_asset_limited` when the frame still communicates the shot. A proxy
counting as a required final replacement asset remains a failure in
production-integrity mode. A contact sheet is required for human-readable
coverage but never replaces opening suspicious individual frames.

For motion shots, inspect start, midpoint, and endpoint frames and open or sample the MP4. Confirm the motion preserves the intended framing and subject visibility across the move.

## Evidence hierarchy

File existence does not equal success. Numeric validation is useful for diagnostics but cannot override obvious visual failure.

**When visual evidence conflicts with `validation.json`, trust the visual evidence.** In rapid-previs, classify the frame as `accepted`, `accepted_asset_limited`, `needs_revision`, or `blocked_capability`; in production-integrity, mark a visual failure failed. Record the conflict and repair plan when a repair is authorized. Do not convert a visual failure to a warning merely because a pixel/statistics or composition record passed.

In production-integrity mode: **When visual evidence conflicts with `validation.json`, trust the visual evidence and mark the shot failed.**

Do not approve an MP4 from its filename alone. It must be nonempty, associated with the correct shot/pass, sampled or opened, visually accepted, and newer than the last relevant scene change.
