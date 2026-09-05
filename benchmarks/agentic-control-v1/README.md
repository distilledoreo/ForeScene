# Agentic Control V1 — lifecycle-control (Family A)

Benchmark for **cheap Composer-class agents** operating ForeScene through the documented Agent CLI on a representative lifecycle workflow. This suite scores **operability**, not visual quality.

## Purpose

The older V3-Lite visual triad overfit global locomotion camera policy. Family A asks whether an agent can:

1. Discover CLI capabilities
2. Open a seed project
3. Inspect and record project identity
4. Render one clay frame
5. Save and reopen the project
6. Re-inspect with continuity checks
7. Export a package when the capability exists

## Seed project

`seed/lifecycle-temple.fsp` — built from `createDefaultProject()` (temple graybox primitives, one origin shot, no external GLB binaries).

Regenerate:

```bash
npm run benchmark:agentic-control -- --build-seed
```

## Prepare a run

```bash
# Auto-increment run root on ext4
npm run benchmark:agentic-control -- --prepare

# Or specify run root
npm run benchmark:agentic-control -- --run-root /home/distilledoreo/forescene-benchmarks/agentic-control-v1-03
```

This creates profile, copies seed + contract, resolves hosted app URL, and writes `harness/BRIEF.md`.

Print the brief:

```bash
npm run benchmark:agentic-control -- --print-brief --run-root /path/to/run
```

## Score a completed run

After the candidate writes `work/candidate-report.json` and artifacts:

```bash
npm run benchmark:agentic-control -- --score --run-root /path/to/run
```

Writes `report.json` with `technicalPass: boolean`.

## Oracle dry-run (harness only)

Prove the scorer against live CLI (not a cheap-agent attempt):

```bash
npm run benchmark:agentic-control -- --oracle --run-root /path/to/fresh-run
```

## Hard pass criteria

| Check | Requirement |
| --- | --- |
| CLI invocations | Each recorded step: exit 0, envelope `ok: true` |
| Clay frame | `work/artifacts/clay-frame.png` > 1 KB |
| Saved project | `project.fsp` > 1 KB |
| Continuity | Same `projectId`; shot ids unchanged; cast count did not increase |
| Package | Completed when `export.package` is true; explicit skip otherwise |
| Source drift | Optional — no new dirty tracked files vs `harness/git.json` |

## NOT scored

- Graybox / composition / chase readability
- Pixel gates, `quality-report.json`, visual-preflight grades
- Camera policy tuning

## Hosted app policy

- Reuse Vite on ports **3047**, **3048**, or **3045** when HTTP 200
- Otherwise start from `/home/distilledoreo/forescene-app` on a new port with `DISABLE_HMR=true`
- **Do not** kill existing Vite processes
- `PLAYWRIGHT_BROWSERS_PATH=/home/distilledoreo/.cache/ms-playwright`

## Dirty tree

Unlike V3-Lite doctor, Family A does **not** require a clean git tree by default. The scorer records `repository.clean` as a warning when the working tree drifts; set `FORESCENE_BENCHMARK_REQUIRE_CLEAN=1` to make a dirty tree fail `technicalPass`.

## When to ROTATE to a new family

Rotate (new seed / new family B, C, …) when any of these become true for Family A:

- The seed or error strings are special-cased in product code just to pass this suite
- New CLI flags are added only for benchmark convenience
- Scoring requires named-entity shortcuts (creature, Joseph, chase-motion, etc.)
- Agents routinely pass Family A but fail real workflows — the seed no longer represents production operability

Document rotation in a new `benchmarks/<family>/` folder; keep Family A frozen once published.

## Files

| File | Role |
| --- | --- |
| `contract.json` | Machine-readable contract for harness + scorer |
| `BRIEF.md` | Candidate-facing instructions |
| `seed/lifecycle-temple.fsp` | Neutral lifecycle seed |
