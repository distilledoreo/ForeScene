# Reliability soak (Gates A–F)

Repository-owned soak. Do **not** retry a failed iteration to make a gate pass.
Do **not** kill Chromium; use `npm run agent:cancel`. If ForeScene times out,
record an infrastructure failure and stop.

A skipped required live gate is **not** evidence that ForeScene is reliable.
Offline mode may report skipped B/C/E/F. Stabilization exit requires a full
live soak (`--url`) with every gate `passed` and `retries: 0`.

```bash
npm run reliability:soak
npm run reliability:soak -- --url http://127.0.0.1:4173
```

| Gate | Name | Offline | Live (`--url`) |
| --- | --- | --- | --- |
| **A** | CLI completeness | Capability matrix, `agent:*` scripts, three-shot capabilities, skill contract, CLI E2E spec present | same |
| **B** | Saved-rig 20/20 | Skipped (not evidence) | documented `agent:soak-saved-rig` → `agent:import-character` 20/20, zero retries |
| **C** | Render reliability | Skipped (not evidence) | repeated clay + projected frames, depth if advertised, two clay videos; artifact bytes + envelopes |
| **D** | Harness 3× | Three isolated complete `benchmark:run` cycles with a fixture candidate, collect, report | plus live lifecycle on each run root |
| **E** | Lifecycle | Stale-lock recovery is additional only; gate skipped without `--url` | repeated mutate/save/reopen-on-fresh-profile/inspect |
| **F** | Visual baseline | Fail-closed fixture sanity; live preflight skipped (not evidence) | fail-closed rules + live `agent:visual-preflight` |

`retries` on every gate must stay `0`. `stabilizationExit` is true only when the soak is live and no required gate is skipped or failed.

## Performance instrumentation

Soak gate `durationMs` is **not** an end-to-end benchmark phase breakdown. Prefer `timing.json` / `report.json` from `npm run benchmark:run`, which records harness, candidate, and ForeScene CLI phases. `npm run reliability:perf` rolls those up when Gate D run roots are present:

```bash
npm run reliability:perf -- --report artifacts/reliability/soak.json
npm run reliability:perf
```

Do **not** optimize around retries, extra Chromium launches, or duplicate work. A pass that used retries is not a performance win. Heartbeats stay on stderr (`[agent-op]`) and are not success evidence.
