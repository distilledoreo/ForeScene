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

The harness also accepts the frozen external
`music-video-v2-panorama-triad/shot-manifest.json` format directly. It adapts
that specification at the harness boundary, copies its canonical neutral base
package, and writes a validated production manifest before candidate launch:

```bash
npm run benchmark:run -- --spec "C:\path\to\music-video-v2-panorama-triad\shot-manifest.json" --run-root "C:\fresh\MV3-Benchmark-NN" --prepare-only
```

The adapter preserves the frozen three-shot requirements and full artifact
contract. `Hand_Monster_v3.glb` remains an ordinary imported model; the Joseph
assets remain saved-rig characters. The candidate does not translate either
manifest format.

`--prepare-only` writes the run layout, git identity, and candidate brief, then exits 0 without collecting artifacts. Use it to smoke the harness. Without `--prepare-only`, missing stills/MP4s are a `MODEL_FAILURE`.

When `FORESCENE_BENCHMARK_EXPECTED_COMMIT` is set, preparation accepts that
stabilization commit or a clean descendant containing later harness fixes. An
unrelated commit and every dirty working tree still fail closed; `git.json`
records both expected and actual identities.

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

## Phase timing

`timing.json` and `report.timingSummary` record wall time for the actual
benchmark, not soak-gate aggregates. Phases include prepare / git-verify /
profile, candidate invocation, classified Agent CLI operations (open, inspect,
imports, apply, stills by appearance, visual-preflight, repair passes, video,
save/package), collect/forbidden/technical validation, cold-open / incremental /
recovery, and visual grade.

`candidateWallMs` is the candidate process. `foresceneToolMs` is the sum of CLI
envelope durations. `candidateMinusToolMs` is leftover candidate wall time
(orchestration / model). Missing cache telemetry is `cache.present: false`, not
an implicit hit. Chromium launches are counted from `[agent] chromium-launch`
when present. Retries stay 0; do not optimize by retrying.
