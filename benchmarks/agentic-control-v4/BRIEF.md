# Agentic Control — Family D (fresh-profile-recovery)

You are a **cheap agent** operating ForeScene through the public Agent CLI only.

## Authorization

| Flag | Value |
| --- | --- |
| `cliOnly` | **true** — use documented `npm run agent:*` commands only |
| `writeAuthorized` | **true** — `--write` is allowed for open/save/frame |
| `resetAuthorized` | **false** — do **not** run `--reset-project` |

## Forbidden

- Editing ForeScene source files
- Calling `window.foreScene` or reading engine source to discover APIs
- Running harness scripts (`run-benchmark.ts`, etc.) or `--reset-project`
- Named-entity special cases (no creature/Joseph shortcuts)
- Inventing GLB binaries or importing models for this family

## Environment (harness-provided)

The harness sets:

- `FORESCENE_URL` — hosted ForeScene app
- `FORESCENE_PROFILE` — primary isolated browser profile (`profile/`) for open, inspect, and save
- `FORESCENE_PROFILE_FRESH` — empty fresh profile directory (`profile-fresh/`) for reopen and post-reopen inspect only
- `FORESCENE_OUTPUT` — `work/artifacts/` under the run root
- `FORESCENE_BENCHMARK_CONTRACT` — machine-readable contract path

All mutable state lives under the run root on ext4. Use `--profile` explicitly on every stateful command; the default browser profile is refused.

## Operator request

The editorial team needs confidence that a saved `.fsp` backup survives a cold handoff — the kind of reopen that happens when someone else opens the file in a new browser profile or a fresh machine session.

Open the provided corridor seed project with write access on the **primary** profile. Do **not** reset or replace the seed.

Inspect the live document and record `projectId`, every shot id, cast count, and asset count. Discover shot ids from inspect output; do not guess labels or shot numbers.

Save a verified backup of the current project as `project.fsp` at the run root using the **primary** profile.

Open that backup on the **fresh** profile directory the harness created (`FORESCENE_PROFILE_FRESH`). This must be a different `--profile` path than the one you used for the seed open and save.

Inspect again on the fresh profile. The `projectId` and shot id set must match your earlier inspect, and cast count must **not** increase. Duplicated shots or cast members mean failure.

Optionally, clay-frame one shot after reopen on the fresh profile to prove the project is live. If you do, write the PNG under `work/artifacts/` and record it in your candidate report.

Record every CLI invocation in `work/candidate-report.json` with exit codes, envelope `ok` status, and the profile directory each stateful command used.

## Candidate report (`work/candidate-report.json`)

```json
{
  "runner": "cheap-agent",
  "profiles": {
    "primary": "/absolute/path/to/profile",
    "fresh": "/absolute/path/to/profile-fresh"
  },
  "invocations": [
    { "step": "open-seed", "npmScript": "open", "exitCode": 0, "envelopeOk": true, "profile": "/…/profile" }
  ],
  "inspectBefore": {
    "projectId": "project_…",
    "shotIds": ["shot_…"],
    "castCount": 1,
    "assetCount": 0
  },
  "inspectAfter": { "…": "same shape on fresh profile" },
  "clayFrame": { "status": "skipped", "reason": "optional proof not requested" }
}
```

### Counting rules

- **castCount** — scene objects with type `human_dummy` or `poseable_character`
- **assetCount** — entries in `document.assets.assets`, or unique `modelAssetId` values when document is omitted

## What is scored (hard pass)

- Every invoked command: envelope `ok: true`, exit 0
- Saved `project.fsp` exists and is **> 1 KB**
- Reopen used a **different** profile path than the primary open/save profile
- Re-inspect on fresh profile: same `projectId`; shot id set unchanged; cast count did **not** increase

## What is NOT scored

- Graybox beauty, chase readability, or clay-frame pixels
- Package export, quality-report, or visual-preflight grades
- Repository cleanliness (warning only unless `FORESCENE_BENCHMARK_REQUIRE_CLEAN=1`)
