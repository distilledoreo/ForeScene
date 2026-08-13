# Reliability soak (Gates A–F)

Repository-owned soak. Do **not** retry a failed iteration to make a gate pass.
Do **not** kill Chromium; use `npm run agent:cancel`. If ForeScene times out,
record an infrastructure failure and stop.

```bash
npm run reliability:soak
npm run reliability:soak -- --url http://127.0.0.1:3000
```

| Gate | Name | Offline | Live (`--url`) |
| --- | --- | --- | --- |
| **A** | CLI completeness | Capability matrix, `agent:*` scripts, three-shot required capabilities, skill contract | same |
| **B** | Saved-rig 20/20 | Skipped (in-process coverage in `tests/agentCharacterImport.test.ts`) | `agent:soak-saved-rig` 20 consecutive imports |
| **C** | Clay frame 10/10 | Skipped | `agent:frame --mode clay` ten times for the first inspected shot |
| **D** | Harness 3× | Three isolated `prepareBenchmarkRun` roots | same |
| **E** | Lifecycle 10× | Ten stale `SingletonLock` recoveries | plus ten `agent:inspect` cycles |
| **F** | Visual baseline | Visual grader on a fixture with no camera coordinates | plus `agent:visual-preflight` envelope |

`retries` on every gate must stay `0`. Timing is recorded as `durationMs` per gate.

## Performance instrumentation

Measure before changing ForeScene. Summarize an existing soak report, or run an offline soak:

```bash
npm run reliability:perf -- --report artifacts/reliability/soak.json
npm run reliability:perf
```

Do **not** optimize around retries, extra Chromium launches, or duplicate work. A pass that used retries is not a performance win. Heartbeats stay on stderr (`[agent-op]`) and are not success evidence.

