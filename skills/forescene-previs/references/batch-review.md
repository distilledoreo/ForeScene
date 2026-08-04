# Batch review modes

## Rapid-previs batch rule

Rapid-previs is the default for rough, communicative, editable spatial references. After the three-part canary passes, use **6–8 shots** per batch. During capability discovery, use 3–4 shots. A failed shot is quarantined and does not block unrelated shots.

For each rapid-previs batch:

1. Apply only the selected staging and camera changes using existing bindings.
2. Apply all batch mutations before the single save/reopen check; do not reopen per shot.
3. Render one canonical review frame per shot.
4. Generate one contact sheet and inspect suspicious individual frames.
5. Apply only camera-only shot-size cleanup for obviously over-wide frames, then regenerate the contact sheet.
6. Stop for human review. Do not package, author motion, or run an autonomous creative repair loop.

Accept a rough but communicative frame as `accepted` or `accepted_asset_limited`. Quarantine only `needs_revision` and `blocked_capability` shots. A passing command, file existence, or numeric validation alone does not approve a batch.

## Production-integrity batch rule

Production-integrity mode uses batches of **3–5 shots** by default. Do not autonomously process every shot in a long production after one command succeeds.

For each production-integrity batch:

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

Production-integrity shot results must identify the reviewed output paths and
match the manifest’s criteria exactly once. Use `pass`, `fail`, or
`not_applicable` only when the criterion definition permits it. Every result
needs a concrete reason. Every still and temporal artifact in the manifest must
be listed in `reviewedArtifacts` with the matching SHA-256.

Rapid-previs does not require an extensive per-shot manifest. Retain the
capability/binding preflight, one batch persistence record, frame directory,
contact sheet, and concise blockers or asset limitations.

If a result is unknown, mark the shot failed until the evidence is inspected.
After repair, append or replace the review with a fresh manifest hash and
artifact records; do not approve using stale evidence.
