# Agentic Control V2 — operator-intent (Family B)

Benchmark for **cheap Composer-class agents** operating ForeScene from an underspecified operator brief. Scores **operability**, not visual quality.

## Why Family B exists

Family A (`agentic-control-v1`) became a numbered CLI cookbook. Cheap Composer 2.5 followed the eight `npm run agent:*` steps on the first try, which invites harness overfitting without proving the agent can translate real coordinator language into the right CLI sequence.

Family B keeps the same technical gates (envelopes, artifact size, project/shot/cast continuity) but replaces the ordered command list with prose operator intent and a **different seed** (`operator-corridor.fsp` — two-shot corridor graybox, not the temple lifecycle seed).

## Seed project

`seed/operator-corridor.fsp` — built-in corridor graybox (walls, doorway, stairs, one blocking figure, **two shots**, no external GLB binaries).

Regenerate:

```bash
npm run benchmark:agentic-control -- --build-seed --contract benchmarks/agentic-control-v2/contract.json
```

## Prepare a run

```bash
# Auto-increment run root on ext4
npm run benchmark:agentic-control -- --prepare --contract benchmarks/agentic-control-v2/contract.json

# Or specify run root
npm run benchmark:agentic-control -- --contract benchmarks/agentic-control-v2/contract.json --run-root /home/distilledoreo/forescene-benchmarks/agentic-control-v2-01
```

Print the brief:

```bash
npm run benchmark:agentic-control -- --print-brief --contract benchmarks/agentic-control-v2/contract.json --run-root /path/to/run
```

## Score a completed run

```bash
npm run benchmark:agentic-control -- --score --contract benchmarks/agentic-control-v2/contract.json --run-root /path/to/run
```

## Oracle dry-run (harness only)

```bash
npm run benchmark:agentic-control -- --oracle --contract benchmarks/agentic-control-v2/contract.json --run-root /path/to/fresh-run
```

## Hard pass criteria

Same as Family A — see `benchmarks/agentic-control-v1/README.md`. Repository drift is a **warning** by default; set `FORESCENE_BENCHMARK_REQUIRE_CLEAN=1` to fail on dirty tree.

## Hosted app policy

Same as Family A — reuse Vite on ports **3047**, **3048**, or **3045**; do not kill existing Vite processes; `PLAYWRIGHT_BROWSERS_PATH=/home/distilledoreo/.cache/ms-playwright`.

## Files

| File | Role |
| --- | --- |
| `contract.json` | Machine-readable contract for harness + scorer |
| `BRIEF.md` | Candidate-facing operator brief (prose, not a command script) |
| `seed/operator-corridor.fsp` | Corridor two-shot seed |
