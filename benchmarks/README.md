# ForeScene Benchmark Harness V3

The candidate model must **not** administer this experiment. This repository-owned
harness owns mechanical bookkeeping. The candidate owns previs.

## Boundary

| Harness owns | Candidate owns |
| --- | --- |
| Fresh `RUN_ROOT` and browser profile | Inspect the scene |
| Git/commit identity | Understand shot requirements |
| Copy base `.fsp` when provided | Import/use assets |
| Candidate brief / authorization | Stage, pose, place cameras |
| Invoke the candidate command | Render, visually inspect, repair |
| Collect artifacts and hashes | Render required motion |
| Cold-open, incremental, recovery records | |
| Technical validator and timing report | |

Candidates must not create `run-benchmark.ts`, `open-package.ts`, or
`render-stills.ts`. Use documented `npm run agent:*` commands from
`docs/agent-capability-matrix.md`.

## Run

```bash
npm run benchmark:run -- --spec benchmarks/three-shot.json --prepare-only
npm run benchmark:run -- --spec benchmarks/three-shot.json --skip-live --skip-candidate
npm run benchmark:run -- --spec benchmarks/three-shot.json --url http://127.0.0.1:3000 --candidate '<your agent command>'
```

`--prepare-only` writes the run layout, git identity, and candidate brief, then exits 0 without collecting artifacts. Use it to smoke the harness. Without `--prepare-only`, missing stills/MP4s are a `MODEL_FAILURE`.

Live cold-open / incremental / recovery steps call `agent:inspect`, `agent:save`, and `agent:open` against `--url`. Pass `--skip-live` in unit tests.

The harness writes `harness/brief.json`:

```json
{
  "mode": "benchmark",
  "writeAuthorized": true,
  "resetAuthorized": true,
  "repairBudget": 2,
  "cliOnly": true
}
```

If ForeScene times out (`character.import` etc.), the report records
`INFRASTRUCTURE_FAILURE` with `operation` set and **stops**. The candidate is
not allowed to modify the harness to make the run pass.

Technical validation answers “is this a structurally valid project/output?”
Visual quality is a separate later layer and must not hard-code camera
coordinates. The visual grader consumes `agent:visual-preflight` metrics
(subject, camera direction, environment/visibility, motion continuity). A
technical pass is not visual approval.
