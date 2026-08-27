# Agentic Control V4 — fresh-profile-recovery (Family D)

Benchmark for **cheap Composer-class agents** verifying that a saved `.fsp` reopens correctly on a **different browser profile** without losing project identity or duplicating entities.

Distinct from Family A/B (`lifecycle-control` / `operator-intent`, same-profile open/frame/save/package) and Family C (`import-idempotency`, import-model twice).

## Seed project

Reuses `../agentic-control-v2/seed/operator-corridor.fsp` — built-in corridor graybox with two shots and one cast member (no GLBs).

Ensure the seed exists:

```bash
npm run benchmark:agentic-control -- --build-seed --contract benchmarks/agentic-control-v2/contract.json
```

## Prepare a run

```bash
npm run benchmark:agentic-control -- --prepare --contract benchmarks/agentic-control-v4/contract.json --run-root /home/distilledoreo/forescene-benchmarks/agentic-control-v4-cheap-01
```

The harness creates `profile/` (primary) and `profile-fresh/` (reopen only), and sets `FORESCENE_PROFILE` / `FORESCENE_PROFILE_FRESH`.

## Score a completed run

```bash
npm run benchmark:agentic-control -- --score --contract benchmarks/agentic-control-v4/contract.json --run-root /path/to/run
```

## Oracle dry-run (harness only)

```bash
npm run benchmark:agentic-control -- --oracle --contract benchmarks/agentic-control-v4/contract.json --run-root /path/to/fresh-run
```

## Hard pass criteria

- CLI envelopes ok for open, inspect (×2), save, reopen-fresh
- Saved `project.fsp` > 1 KB
- Fresh-profile reopen used a different `--profile` than primary open/save
- Post-reopen inspect: same `projectId`, same shot id set, cast count did not increase

## Hosted app policy

Reuse Vite on ports **3047**, **3048**, or **3045**; do not kill existing Vite processes; `PLAYWRIGHT_BROWSERS_PATH=/home/distilledoreo/.cache/ms-playwright`.
