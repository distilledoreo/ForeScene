# ForeScene Benchmark V3-Lite

V3-Lite is the frozen `music-video-v2-panorama-triad` benchmark path. It
measures one candidate's ability to operate ForeScene. The harness owns setup,
freshness, artifact bookkeeping, and structural validation; it does not run
the product lifecycle/recovery suite as part of a model candidate run.

The checked-in contract is:

- `benchmarks/panorama-triad-v3-lite/contract.json`
- `benchmarks/panorama-triad-v3-lite/production-manifest.json`

The manifest is production-schema input, not a generated translation of a
benchmark schema. The external frozen input root supplies the immutable base
package and assets. The doctor resolves those paths immediately before the
candidate and writes the normalized manifest into the fresh run root.
The contract SHA-256 is computed from canonical parsed JSON, so LF/CRLF
checkout conversion does not change identity while semantic manifest edits
still fail closed.

## Doctor

Run the deterministic setup gate without launching a candidate:

```text
npm run benchmark:doctor -- --input-root "C:\\path\\to\\music-video-v2-panorama-triad" --url https://forescene.example --run-root "C:\\fresh\\MV3-Lite-doctor"
```

The doctor checks the clean repository, hosted app response, frozen manifest,
all base/character/model/rig files, asset preflight, isolated profile
writability, and one non-mutating `agent:inspect` call. Any failed check blocks
candidate launch.

## One-candidate run

```text
npm run benchmark:run -- --input-root "C:\\path\\to\\music-video-v2-panorama-triad" --url https://forescene.example --run-root "C:\\fresh\\MV3-Lite-01" --candidate production
```

The harness invokes the candidate exactly once. `production` is one documented
`agent:production` process; its benchmark environment automatically opens the
frozen base in the same isolated profile before the production pass. A custom
candidate command receives the same environment:

`FORESCENE_URL`, `FORESCENE_PROFILE`, `FORESCENE_OUTPUT`,
`FORESCENE_BENCHMARK_BRIEF`, `FORESCENE_BENCHMARK_MANIFEST`,
`FORESCENE_BENCHMARK_PROJECT_PACKAGE`, `FORESCENE_BENCHMARK_FINAL_PROJECT`,
and `FORESCENE_CLI_DOCUMENTATION`.

There are no harness retries, model repair loops, or post-candidate product
interventions. Existing cold reopen, mutation, save/revision, recovery,
identity, persistence-golden, saved-rig, process-death, profile-isolation,
package, and AgentSession coverage remains under product reliability/CI paths.

## Results

The run root contains `harness/doctor.json`, candidate stdout/stderr logs,
`validation-report.json`, `run-report.json`, and compatibility aliases
`validation.json` / `report.json`. Required stills must exist with bytes; the
required chase MP4 must contain a plausible `ftyp` box; and the final project
backup must exist with bytes.

Technical completion and quality are separate. A candidate can be technically
complete while `harness/quality.json` grades its compositions `low` or
`failed`; that is not converted into an infrastructure failure. Quality
evidence is optional, and missing evidence is reported as `not-graded`.

After the candidate exits, the harness samples required still PNGs. Flat or
mostly-gray frames, and composition/validation evidence that a required
subject is not visible, are recorded as pixel-gate quality findings. Those
findings can fail or withhold a visual-control grade; they do not change
technical validation and are never promoted into an infrastructure failure.
Occupancy telemetry alone is not treated as proof that a still is visually
controlled.
