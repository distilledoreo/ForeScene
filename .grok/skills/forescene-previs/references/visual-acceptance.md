# Visual acceptance is authoritative

## Required visual checks

For each final still, compare the opened frame with its shot description. Confirm that:

- The intended primary subject is visible.
- The camera frames the intended anatomical region and composition.
- Required props and real creatures actually appear.
- The correct character variant is staged where required.
- Required clay, projected, clean-plate, character-only, and depth passes are meaningful and present.

Empty rooms, irrelevant body fragments, a missing required prop, an obscured primary subject, and a proxy counting as the final creature automatically fail. A contact sheet is required for human-readable coverage but never replaces opening suspicious individual frames.

For motion shots, inspect start, midpoint, and endpoint frames and open or sample the MP4. Confirm the motion preserves the intended framing and subject visibility across the move.

## Evidence hierarchy

File existence does not equal success. Numeric validation is useful for diagnostics but cannot override obvious visual failure.

**When visual evidence conflicts with `validation.json`, trust the visual evidence and mark the shot failed.** Record the conflict and repair plan in the batch review. Do not convert a visual failure to a warning merely because a pixel/statistics or composition record passed.

Do not approve an MP4 from its filename alone. It must be nonempty, associated with the correct shot/pass, sampled or opened, visually accepted, and newer than the last relevant scene change.
