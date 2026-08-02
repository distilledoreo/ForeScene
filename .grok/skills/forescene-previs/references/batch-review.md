# Gated batch review

## Batch rule

Use batches of **3–5 shots** by default. Do not autonomously process every shot in a long production after one command succeeds.

For each batch:

1. Apply only the selected staging, camera, timeline, or asset changes.
2. Render the required review frames and motion samples.
3. Inspect every frame and, for motion, the start, midpoint, endpoint, and opened/sampled MP4.
4. Write `review-manifest.json` and a semantic review using its exact criteria and artifact hashes.
5. Repair every failure and rerender its affected output.
6. Continue only when the batch review has `approved: true` and every required criterion passes.

A failed shot blocks the next batch. A passing command, file existence, or numeric validation alone does not approve a batch.

```json
{
  "approved": true,
  "manifestSha256": "sha256:...",
  "shots": [
    {
      "id": "shot-id",
      "verdict": "pass",
      "criteria": [
        {
          "id": "visual.required-content",
          "decision": "pass",
          "reason": "All declared shot content is visible in the linked evidence."
        }
      ],
      "reviewedArtifacts": [
        { "path": "clay_with_people.png", "sha256": "sha256:..." }
      ]
    }
  ]
}
```

## Required result fields

Each shot result must identify the reviewed output paths and match the
manifest’s criteria exactly once. Use `pass`, `fail`, or `not_applicable` only
when the criterion definition permits it. Every result needs a concrete
reason. Every still and temporal artifact in the manifest must be listed in
`reviewedArtifacts` with the matching SHA-256.

If a result is unknown, mark the shot failed until the evidence is inspected.
After repair, append or replace the review with a fresh manifest hash and
artifact records; do not approve using stale evidence.
