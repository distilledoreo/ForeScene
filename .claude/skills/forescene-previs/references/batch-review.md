# Batch review modes

## Rapid-previs batch rule

Use coherent batches, often 6–8 shots once required capabilities work. A genuine blocker does not prevent unrelated shots from progressing, but remains uncovered.

1. Apply the selected staging, camera, timeline, or asset changes through previewed operations.
2. Save/reopen at the batch checkpoint, not after every shot.
3. Render one canonical frame per still; render temporal samples and video where motion carries intent.
4. Inspect the contact sheet and individual frames needed to judge subject role, framing, action, contact, and progression.
5. Repair the actual cause, rerender affected outputs, and record the fresh visual result.
6. Continue the authorized task. Pause for a human only at user-requested checkpoints, explicit product approval gates, or unresolved decisions that materially change the brief.

Style approval does not approve every future frame. Record agent and human reviews distinctly. Rough proxies may be `accepted_asset_limited` when the action reads; missing core action is `needs_revision` or `blocked_capability`. A command success, file, or numeric validation cannot approve a shot.

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
