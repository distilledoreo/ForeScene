# ForeScene Benchmark: GPT-5.6 Luna Reasoning Effort Sweep

Date: 2026-08-12

Benchmark: `music-video-v2-panorama-triad`

Model: `gpt-5.6-luna`

Hosted app: `https://forescene.distilledlabs.org`

Tooling commit: `3c247539e2da09158a0227d14eb8867d08cf48ce`
Application source edits during the runs: none

## Scope and contract

Each condition was assigned a fresh isolated run root and persistent browser profile. The workflow covered:

1. Cold authoring/render/export.
2. Warm rerun without authored project changes.
3. One-shot incremental edit with artifact hash comparison.
4. Cancellation, reopen, and continuation.

The shared contract preserved 22 base objects, 28 landmarks, and 4 panorama references; produced exactly three shots; and used Shot 02 keyframes at `0`, `1.5`, and `3` seconds. The final validator passed every final condition with zero errors and zero warnings.

## Results at a glance

Agent task wall time is orchestration time from the task logs. Software timings are operation-local measurements emitted by the hosted renderer/exporter. They are not additive and should not be treated as equivalent metrics.

| Reasoning effort | Agent task wall time | Cold software evidence | Warm software evidence | Incremental result | Recovery result | Validator |
|---|---:|---|---|---|---|---|
| Low | 17m 31s | Setup 6.200s; render 1.683s; encode 293.975s; finalize 0.217s; 4 cache misses | Warm frame 4.244s; 0 hits reported | Shot 03 only; `fighter-final.png` rerendered | No cancellable progress observed; resume failed | PASS |
| Medium | 35m 49s* | Five stills 45.746s total; Shot 02 video 60.882s | Warm stills 50.159s; video 0.256s | Shot 01 only; `creature-final.png` in 9.227s | Cancellation saw no active render; continuation video 0.486s, but this was not a true mid-render cancel | PASS |
| High | 54m 01s | Aggregate cold timestamp was not emitted; per-operation logs are retained | Warm package 14.266s; 4 hits / 0 misses | Shot 01 only; `creature-final.png`; package 22.236s; five media hashes unchanged | 4K cancel acknowledged at 2% / 0 of 90 frames; reopen and 1080p resume succeeded | PASS |
| Xhigh | 49m 29s | Still frames 55.173s; repair frames 34.361s; native video 64.713s | Warm rerun 163.227s; cache counters unavailable and persisted cache index was empty | Shot 03 only; `fighter-final.png` and contact sheet affected; five media hashes unchanged | Cancelled at 8 of 90 frames; reopen and resume succeeded; resumed video elapsed 0.246s | PASS |
| Max | 1h 46m 30s | Shot 02 canonical video 54.600s; cold run completed with repair | Warm wall time 181.064s; 0 hits / 4 misses | Shot 02 only; three chase stills plus motion affected; creature/fighter hashes unchanged; video 182.973s; package 148.428s | Cancelled at 3 of 90 frames; reopen recovered; 0.774s continuation succeeded, but it was a fresh cached 1080p render rather than frame-level resume | PASS via validator-compatible fallback |

\* Medium also had an earlier 4m 34s evidence attempt that was rejected because it carried media from a prior run rather than independently executing the workflow. It is excluded from the final comparison; the 35m 49s figure is the completed medium run.

## Per-condition results

### Low

- Cold package telemetry: `setupMs=6200`, `renderMs=1683`, `encodeMs=293975`, `finalizeMs=217`.
- Cold cache telemetry: 4 misses, 0 hits.
- Warm operation: one sampled frame completed in `4244ms`.
- Incremental edit: Shot 03 only; `fighter-final.png` rerendered.
- Recovery limitation: no cancellable render progress was observable, so cancellation and resume were not proved.
- Final project and full package handoff were present; validator passed.

### Medium

- Cold still timings: creature `10506ms`, chase start `4680ms`, chase mid `8595ms`, chase end `9334ms`, fighter `12631ms`.
- Cold Shot 02 motion: `60882ms`, H.264, 1920×1080, 3 seconds, 30 fps.
- Warm still timings were unchanged-content renders rather than a clean cache-hit package measurement; warm motion completed in `256ms`.
- Incremental edit affected only `creature-final.png` in `9227ms`.
- The initial cancellation attempt reported `No shot video render is in progress`; the render completed instead. The later continuation completed in `486ms`, so recovery persistence was exercised but true mid-render cancellation was not.
- The separate package-download failure is documented in the run report.

### High

- Cold operation timing was not aggregated by the direct-render helper; the report explicitly records that limitation.
- Warm package/export: `14266ms`, with 4 cache hits and 0 misses.
- Incremental edit changed only the Shot 01 creature still. Unchanged hashes were proved for the three chase stills, fighter still, and chase motion.
- A post-recovery package re-export timed out after 300 seconds. The latest successful native package from the incremental case was retained.
- Cancellation, reopen, persistence, and resumed native video were all successful.

### Xhigh

- Cold canonical stills: Shot 01 `6115ms`; Shot 02 start `7424ms`, mid `15048ms`, end `11887ms`; Shot 03 `14699ms`.
- Shot 02 repair frames took `34361ms`; native 90-frame H.264 motion took `64713ms`.
- Warm rerun wall time was `163227ms`, but direct canonical APIs did not expose production cache counters and persisted cache inspection reported zero entries before and after.
- Incremental edit rerendered Shot 03. `creature-final.png`, all three chase stills, and `chase-motion.mp4` remained byte-for-byte unchanged; the fighter still and contact sheet were affected.
- Recovery cancellation was acknowledged at frame 8 of 90. Reopen recovered the project with zero missing assets, and the resumed video completed.
- The hosted runtime rehydrated Shot 02's null panorama linkage on reopen; the run detached it again before final export. The exported contract was valid.

### Max

- Cold run completed with repair after the first Shot 02 gray render was rejected during inspection. The repaired canonical frames were used.
- Cold native Shot 02 video timing: `54600ms`.
- Warm rerun: `181064ms`, with 0 cache hits and 4 misses. Internal telemetry recorded substantial encode time, but its component totals do not reconcile cleanly with the wall-time field; the wall-time value is the comparison value.
- Incremental edit changed only Shot 02's endpoint camera. Shot 01 and Shot 03 stills remained unchanged; Shot 02's three stills and motion were regenerated.
- Cancellation was acknowledged at frame 3 of 90. Reopen recovered 30 objects, 28 landmarks, 4 panoramas, and zero missing assets. The successful continuation was a fresh cached 1080p render, not frame-level encoder resume.
- Native backup export failed after 120 seconds because a recovery PNG resource was missing. The validator-compatible `final-project.fsp` fallback and separate `final-package-v2.fsp` handoff were retained.

## Reference baseline (not part of the effort sweep)

The earlier merged-app acceptance run is included for context only; it was not a GPT-5.6 Luna reasoning-effort condition.

- Cold: `373.4s`, 4 cache misses.
- Warm: `47.6s`, 4 cache hits and 0 misses.
- Incremental: Shot 01 only; Shots 02/03 and all five unchanged media hashes were preserved.
- Recovery: cancellation acknowledged at frame 33 of 90; reopen recovered 30 objects, 3 shots, and zero missing assets; 4K render completed afterward.
- Validator: passed with zero errors and zero warnings.

## Interpretation

The runs show two different clocks:

1. The app clock: renderer, encoder, persistence, cache, and package operations.
2. The agent clock: inspection, visual review, retries, wrapper workarounds, recovery decisions, and waiting.

The app clock is usually seconds for a cache hit or small incremental still, tens of seconds for a small affected operation or native motion render, and minutes for cold encoding/export. The agent clock ranged from roughly 18 minutes to 107 minutes because the conditions encountered different visual defects, cache states, wrapper failures, cancellation behavior, and export failures.

Therefore this sweep is useful for evaluating end-to-end agent robustness, but it is not a controlled renderer benchmark. The conditions did not all expose the same cache counters or measure identical operation sets. A future software-speed benchmark should run the same API operation repeatedly with fixed cold/warm cache state and report render, encode, persistence, package, and orchestration durations separately.

## Raw evidence locations

The binary artifacts and per-run JSON reports remain in the isolated benchmark roots:

- `C:\Users\disti\Documents\ForeScene Benchmark\music-video-v2-panorama-triad\runs\MV2-Benchmark-5.6-Luna-low-2026-08-12`
- `C:\Users\disti\Documents\ForeScene Benchmark\music-video-v2-panorama-triad\runs\MV2-Benchmark-5.6-Luna-medium-2026-08-12`
- `C:\Users\disti\Documents\ForeScene Benchmark\music-video-v2-panorama-triad\runs\MV2-Benchmark-5.6-Luna-high-2026-08-12`
- `C:\Users\disti\Documents\ForeScene Benchmark\music-video-v2-panorama-triad\runs\MV2-Benchmark-5.6-Luna-xhigh-2026-08-12`
- `C:\Users\disti\Documents\ForeScene Benchmark\music-video-v2-panorama-triad\runs\MV2-Benchmark-5.6-Luna-max-2026-08-12`

Each root contains its own `run-report.json` and `validation-report.json`; this document is the single repo-tracked consolidation of their results.
