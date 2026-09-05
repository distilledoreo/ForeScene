# Agentic Control — Family C (import-idempotency)

You are a **cheap agent** operating ForeScene through the public Agent CLI only.

## Authorization

| Flag | Value |
| --- | --- |
| `cliOnly` | **true** — use documented `npm run agent:*` commands only |
| `writeAuthorized` | **true** — `--write` is allowed for open/import/save |
| `resetAuthorized` | **false** — do **not** run `--reset-project` |

## Forbidden

- Editing ForeScene source files
- Calling `window.foreScene` or reading engine source to discover APIs
- Running harness scripts (`run-benchmark.ts`, etc.) or `--reset-project`
- Named-entity special cases (no creature/Joseph shortcuts)
- Inventing GLB binaries — use the harness-copied `ordinary-cube.glb` in the run root

## Environment (harness-provided)

The harness sets:

- `FORESCENE_URL` — hosted ForeScene app
- `FORESCENE_PROFILE` — isolated browser profile on ext4 (never the repo tree)
- `FORESCENE_OUTPUT` — `work/artifacts/` under the run root (artifact directory; import-model does not write here unless given an explicit `--output` file)
- `FORESCENE_BENCHMARK_CONTRACT` — machine-readable contract path

All mutable state lives under the run root on ext4. The model file `ordinary-cube.glb` is copied into the run root for a local import path.

## Operator request

The layout department needs a quick sanity check that repeated model imports do not silently duplicate geometry in the live document.

Open the provided seed project with write access. Do **not** reset or replace it.

Inspect the live document and record `projectId`, shot ids, cast count, and asset count.

Import `ordinary-cube.glb` from the run root using documented `agent:import-model`.

Inspect again. Asset count or imported-model object count should reflect the new geometry versus the seed inspect.

Import the **same file a second time** with the same command.

Inspect again. Counts must **not** increase versus the post-first-import inspect — binding or reuse of the existing asset/object is success; a duplicate asset or imported object is failure.

Save a verified backup of the current project as `project.fsp` at the run root.

Record every CLI invocation you run in `work/candidate-report.json` with exit codes and whether the stdout JSON envelope reported `ok: true`.

## Candidate report (`work/candidate-report.json`)

```json
{
  "runner": "cheap-agent",
  "invocations": [
    { "step": "open-seed", "npmScript": "open", "exitCode": 0, "envelopeOk": true }
  ],
  "inspectSeed": {
    "projectId": "project_…",
    "shotIds": ["shot_…"],
    "castCount": 0,
    "assetCount": 0
  },
  "inspectAfterFirst": { "…": "same shape" },
  "inspectAfterSecond": { "…": "same shape" }
}
```

### Counting rules

- **castCount** — scene objects with type `human_dummy` or `poseable_character`
- **assetCount** — entries in `document.assets.assets`, or unique `modelAssetId` values when document is omitted
- **importedModelCount** — scene objects with type `imported_model` (optional but recommended)

## What is scored (hard pass)

- Every invoked command: envelope `ok: true`, exit 0
- Saved `project.fsp` exists and is **> 1 KB**
- First import changed asset or imported-model counts versus seed inspect
- After second import, asset count and imported-model count did **not** increase versus post-first-import

## What is NOT scored

- Graybox beauty or render quality
- Package export, clay frames, or visual-preflight grades
- Repository cleanliness (warning only unless `FORESCENE_BENCHMARK_REQUIRE_CLEAN=1`)
