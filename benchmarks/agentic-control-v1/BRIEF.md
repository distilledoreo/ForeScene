# Agentic Control — Family A (lifecycle-control)

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

## Task

Complete these steps in order. Parse **stdout JSON envelopes** (`ok`, `operation`, `result`). Record every step in `work/candidate-report.json`.

1. **`agent:capabilities`** — note whether `export.package` is true.
2. **`agent:open`** — open the seed `.fsp` from the harness with `--write`.
3. **`agent:inspect --document`** — record `projectId`, shot ids, cast count, asset count.
4. **`agent:frame`** — render the **first shot** from inspect (use its `id`, not the display number) with `--mode clay` to `work/artifacts/clay-frame.png`.
5. **`agent:save`** — write `project.fsp` at the run root.
6. **`agent:open`** — reopen `project.fsp` (same profile is OK for v1).
7. **`agent:inspect --document`** — record the same fields again.
8. **`agent:package`** — **only if** capabilities say `export.package` is true; write `work/artifacts/export-package.zip`. Otherwise record an explicit skip with reason in your report.

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
- Optional: no unauthorized edits to git-tracked ForeScene source

## What is NOT scored

- Graybox beauty, composition, chase readability
- `quality-report.json`, pixel gates, or visual-preflight grades

## v2 note

Family A v1 allows reopen on the **same** profile. A future **fresh-profile recovery** family will require reopen on a new profile directory and verify project identity there.
