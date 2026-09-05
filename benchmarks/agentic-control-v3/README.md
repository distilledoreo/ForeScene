# Agentic Control V3 — import-idempotency (Family C)

Benchmark for **cheap Composer-class agents** verifying that repeated `agent:import-model` of the same GLB does not duplicate assets or imported objects.

Distinct from Family A (`lifecycle-control`, open/frame/save/package) and Family B (`operator-intent`, prose operator brief with corridor seed).

## Seed project

`seed/import-empty.fsp` — minimal graybox with one origin shot and **no imported models**.

Regenerate:

```bash
npm run benchmark:agentic-control -- --build-seed --contract benchmarks/agentic-control-v3/contract.json
```

## Prepare a run

```bash
npm run benchmark:agentic-control -- --prepare --contract benchmarks/agentic-control-v3/contract.json --run-root /home/distilledoreo/forescene-benchmarks/agentic-control-v3-cheap-01
```

The harness copies `tests/fixtures/ordinary-cube.glb` into the run root as `ordinary-cube.glb`.

## Score a completed run

```bash
npm run benchmark:agentic-control -- --score --contract benchmarks/agentic-control-v3/contract.json --run-root /path/to/run
```

## Oracle dry-run (harness only)

```bash
npm run benchmark:agentic-control -- --oracle --contract benchmarks/agentic-control-v3/contract.json --run-root /path/to/fresh-run
```

## Hard pass criteria

- CLI envelopes ok for open, inspect (×3), import-model (×2), save
- Saved `project.fsp` > 1 KB
- First import increased asset or imported-model counts versus seed
- Second import did not increase those counts versus post-first-import

## Hosted app policy

Reuse Vite on ports **3047**, **3048**, or **3045**; do not kill existing Vite processes; `PLAYWRIGHT_BROWSERS_PATH=/home/distilledoreo/.cache/ms-playwright`.
