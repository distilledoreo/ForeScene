# Gated batch review

## Batch rule

Use batches of **3–5 shots** by default. Do not autonomously process every shot in a long production after one command succeeds.

For each batch:

1. Apply only the selected staging, camera, timeline, or asset changes.
2. Render the required review frames and motion samples.
3. Inspect every frame and, for motion, the start, midpoint, endpoint, and opened/sampled MP4.
4. Write `artifacts/previs/reviews/batch-<nn>.json`.
5. Repair every failure and rerender its affected output.
6. Continue only when the batch review has `approved: true` and every required pass is present.

A failed shot blocks the next batch. A passing command, file existence, or numeric validation alone does not approve a batch.

```json
{
  "shots": ["01", "02", "03", "04"],
  "approved": false,
  "results": [
    {
      "shotNumber": "01",
      "primarySubjectVisible": true,
      "framingMatchesDescription": true,
      "correctCharacterVariant": true,
      "realCreatureVisible": null,
      "requiredPassesPresent": true,
      "decision": "pass"
    },
    {
      "shotNumber": "03",
      "primarySubjectVisible": false,
      "framingMatchesDescription": false,
      "requiredPassesPresent": true,
      "decision": "fail",
      "reasons": ["The intended primary subject is outside the camera frame."]
    }
  ]
}
```

## Required result fields

Each shot result must identify the reviewed output paths/revision and include:

- `primarySubjectVisible`
- `framingMatchesDescription`
- `correctCharacterVariant` when a variant is required
- `realCreatureVisible` when a creature is required
- `requiredPassesPresent`
- `decision` and concrete `reasons` for every failure

If a result is unknown, mark the batch failed until the frame is inspected. After repair, append or replace the review with a fresh render/revision record; do not approve using a stale review.
