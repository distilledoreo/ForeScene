# Production Integrity

Production-integrity is opt-in for final packages, client approvals, motion
deliverables, or high-value projects where complete evidence matters.

Use `npm run agent:production`. Do not call `window.foreScene` production APIs when `production.orchestrate` is true. Retain the full
project preservation preflight and final comparison, recovery revisions,
capability-covering canary, artifact hashes, detailed batch review, motion
samples, and approval gates.

Use 3–5-shot batches. A failed shot blocks the next batch until the failure is
repaired and its affected evidence is regenerated. Command success, file
existence, and numeric validation never replace visual approval.

For imported humanoids, require explicit rendered pose telemetry:

```json
{
  "poseApplied": true
}
```

Do not package or approve a production delivery until preservation, visual,
projection, and artifact checks pass.
