# Agentic Control — Family B (operator-intent)

You are a **cheap agent** operating ForeScene through the public Agent CLI only.

## Authorization

| Flag | Value |
| --- | --- |
| `cliOnly` | **true** — use documented `npm run agent:*` commands only |
| `writeAuthorized` | **true** — `--write` is allowed for open/save/frame/package |
| `resetAuthorized` | **false** — do **not** run `--reset-project` |

## Forbidden

- Editing ForeScene source files
- Calling `window.foreScene` or reading engine source to discover APIs
- Running harness scripts (`run-benchmark.ts`, etc.) or `--reset-project`
- Named-entity special cases (no creature/Joseph shortcuts)

## Environment (harness-provided)

The harness sets:

- `FORESCENE_URL` — hosted ForeScene app
- `FORESCENE_PROFILE` — isolated browser profile on ext4 (never the repo tree)
- `FORESCENE_OUTPUT` — `work/artifacts/` under the run root
- `FORESCENE_BENCHMARK_CONTRACT` — machine-readable contract path

All mutable state lives under the run root on ext4.

## Operator request

The production coordinator left you a corridor previs package and needs a quick operability check before the team reviews blocking.

Open the provided seed project with write access. Do **not** reset or replace it — work from the package the harness copied into your run root.

Before you render anything, inspect the live document and record the project identity: `projectId`, every shot id, cast count, and asset count. **Discover shot ids from inspect output; do not guess display names or shot numbers.**

Render a **clay** still of the **first shot** (use the shot's preservation `id` from inspect, not its label) into `work/artifacts/clay-frame.png`.

Save a verified backup of the current project as `project.fsp` at the run root.

Reopen that backup (reusing the same browser profile is fine) and inspect again. Confirm you did **not** duplicate shots or cast — the `projectId` and shot id set should match your earlier inspect, and cast count must not increase.

If the CLI advertises package export, produce `work/artifacts/export-package.zip`. If export is unavailable, record an explicit skip reason in your report instead of attempting a workaround.

Record every CLI invocation you run in `work/candidate-report.json` with exit codes and whether the stdout JSON envelope reported `ok: true`.

## Candidate report (`work/candidate-report.json`)

```json
{
  "runner": "cheap-agent",
  "invocations": [
    { "step": "capabilities", "npmScript": "capabilities", "exitCode": 0, "envelopeOk": true }
  ],
  "capabilities": { "exportPackage": true },
  "inspectBefore": {
    "projectId": "project_…",
    "shotIds": ["shot_…"],
    "castCount": 1,
    "assetCount": 0
  },
  "inspectAfter": { "…": "same shape" },
  "package": { "status": "completed" }
}
```

Use `"package": { "status": "skipped", "reason": "…" }` when export is unavailable.

### Counting rules

- **castCount** — scene objects with type `human_dummy` or `poseable_character`
- **assetCount** — entries in `document.assets.assets`, or unique `modelAssetId` values when document is omitted

## What is scored (hard pass)

- Every invoked command: envelope `ok: true`, exit 0
- Clay frame exists and is **> 1 KB** (not a visual grade)
- Saved `project.fsp` exists and is **> 1 KB**
- Re-inspect: same `projectId`; shot id set unchanged; cast count did **not** increase
- Package completed when `export.package` is true; explicit skip otherwise

## What is NOT scored

- Graybox beauty, composition, chase readability
- `quality-report.json`, pixel gates, or visual-preflight grades
- Repository cleanliness (warning only unless `FORESCENE_BENCHMARK_REQUIRE_CLEAN=1`)
