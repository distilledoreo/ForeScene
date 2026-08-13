# ForeScene Agent Playwright CLI

The Agent CLI uses Playwright (not raw CDP) to connect to a running ForeScene instance and call `window.foreScene`.

## Scripts

```bash
npm run agent:inspect
npm run agent:preview -- --plan plans/example.json
npm run agent:apply -- --plan plans/example.json --write
npm run agent:capabilities
npm run agent:open -- --file path/to/project.fsp --write
npm run agent:save -- --output artifacts/project.fsp --write
npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
npm run agent:verify -- --workspace build --output artifacts/verify.png
npm run agent:verify -- --shots 01,02
npm run agent:visual-preflight -- --shots 01,02
npm run agent:asset-contract
npm run agent:asset-contract -- --shot <shotId>
npm run agent:frame -- --shot <shotId> --output artifacts/frame.png
npm run agent:frame -- --shot <shotId> --mode projected --output artifacts/frame.projected.png
npm run agent:video -- --shot <shotId> --write --output artifacts/shot.mp4
npm run agent:run -- --plan plans/example.json --screenshot artifacts/out.png --write
npm run agent:package -- --write --output artifacts/package.zip
npm run agent:analyze-character -- --file path/to/actor.glb --rig-package path/to/actor.fsrig --rig-mode saved-rig
npm run agent:import-character -- --file path/to/actor.glb --rig-package path/to/actor.fsrig --rig-mode saved-rig --name "Actor" --write
npm run agent:import-model -- --file path/to/set.glb --write
npm run agent:replace-proxy -- --proxy proxy-id --replacement model-id --shots 08,09 --output artifacts/refinement/swap.json --write
npm run agent:render-passes -- --shots 01,02 --output artifacts/reviews/batch-01
npm run agent:plan-exports -- --shots 01,02 --output artifacts/preflight/deliverables-plan.json
npm run agent:verify-package -- --plan artifacts/preflight/deliverables-plan.json --package artifacts/package.zip
npm run agent:refine -- --plan production/refinement-plan.json --batch batch-01 --write --output artifacts/refinement
```

`preview` prepares a plan without mutating the live project (read-only mode is enough).  
`apply` / `run` / `package` **require** explicit `--write` or `--persist-write` and refuse to start without it.

`agent:verify` and `agent:visual-preflight` honor `--shot`/`--shots`. An explicit selection that matches nothing fails, and unmatched ids appear in the JSON result and provenance. An empty project with no `--shots` skips the visual gate instead of reporting a vacuous pass. `agent:frame` and `agent:video` accept exactly one shot and reject extra ids before the browser opens. Clay, projected, and depth are `--mode` values on those commands (`--appearance` remains an alias). `agent:asset-contract` accepts one optional `--shot` (API `shotId`) and rejects additional ids.

`agent:import-model` takes the same ordinary-model path as **Import 3D scene**.
Use `--allow-heavy-imports` only after reviewing a returned heavy-import estimate.
An extreme import additionally requires `--consent-token IMPORT`.

`agent:replace-proxy` insists on complete affected-shot coverage. It writes a
JSON plan/preview/apply/verification report plus `before`/`after` clay renders
for each requested shot; if the reread or render check fails after apply, it
immediately asks the Agent API to undo the replacement.

`agent:render-passes` is read-only and writes six review PNGs per requested
shot plus `review-manifest.json`: clay with characters, clay clean plate,
projected with characters, projected clean plate, characters only, and depth.
Projected rendering fails explicitly when the project has no usable styled pano;
the manifest keeps that diagnostic rather than disguising a clay fallback.

`agent:plan-exports` persists the exact shared Export workspace plan.
`agent:verify-package` then checks every planned `produce` file against the
actual ZIP and exits nonzero with the missing shot, pass kind, and path.

`agent:refine` is the guarded existing-project workflow. It creates
`refinement-state.json` beside the evidence, captures the first preservation
snapshot, imports/replaces only the named batch, previews proxy mutations,
renders the six-pass review matrix, and stops in `awaiting_visual_review`.
Motion shots also write start, midpoint, endpoint, and MP4 evidence into the
same `review-manifest.json`; each temporal record includes its output path and
SHA-256. Use `--approve batch-id --review path/to/batch.semantic.json` after
semantic review; it must pass every manifest criterion and match every
rendered still and temporal hash.
The following batch is rejected until that explicit state transition exists.
`--finalize --write` runs the final preservation comparison, export plan,
package download, and ZIP verification. It cannot set production complete while
a proxy remains visible, an import/replacement did no work, a review is
incomplete, or preserved IDs, cameras, or timelines changed.

## Write authorization

| Flag | Effect |
|------|--------|
| _(none)_ | Clears any stale localStorage write seed; stays read-only |
| `--write` | Session-only write seed (`sessionStorage`); cleared when the tab closes |
| `--persist-write` | Trusted profile seed (`localStorage`); survives reloads until Stop / demotion |

Without one of those flags, `npm run agent:apply -- --plan plan.json` errors at the CLI and does not enable writes.

## Defaults

| Setting | Default |
|---------|---------|
| URL | `FORESCENE_URL` / `CONTINUITY_STAGE_URL`, else search `http://127.0.0.1:3000`–`3010` |
| Profile | `.forescene-agent/browser-profile/` (persistent) |
| Viewport | 1600×1000 |
| Headed | yes (use `--headless` or CI) |
| stdout | JSON result |
| stderr | progress / diagnostics |

## Handshake

```ts
await page.waitForFunction(() => {
  const status = window.foreScene?.getStatus();
  return status?.ready && status.projectLoaded && status.persistence?.ready;
});
await page.evaluate(() => window.foreScene!.waitForIdle({ timeoutMs: 60_000 }));
```

`openAgentBrowser` / CLI write paths wait for idle before apply, undo, and package so initial autosave cannot return `busy`.

## `agent:run`

```bash
npm run agent:run -- \
  --plan plans/conversation.preview.json \
  --screenshot artifacts/conversation.png \
  --workspace shots \
  --write
```

Returns:

```json
{
  "ok": true,
  "planId": "...",
  "verifiedRevisionId": "...",
  "affectedObjects": 2,
  "affectedShots": 1,
  "screenshot": "artifacts/conversation.png"
}
```

## `agent:package`

```bash
npm run agent:package -- --write --output artifacts/package.zip
npm run agent:package -- --write --shot <shotId> --output artifacts/one-shot.zip
```

Calls `window.foreScene.exportPackage()` and, when `--output` is set, captures the browser download via Playwright.

## Origin consistency

A project opened under port 3000 is a different browser storage origin than port 4173. Keep the Agent CLI on one URL (prefer the Vite dev server on 3000).

## Visual verification

Screenshots target `[data-testid="scene-viewport"]` when present, otherwise the page viewport.

## Agent Console

The in-app **Agent Console** (Project menu) is the same API surface. Prefer the CLI for automation; use the Console for interactive paste/preview/apply while debugging plans.

## `agent:previs`

Orchestrates shot-list → graybox project → first frames.

```bash
# Initialize / optional reset only
npm run agent:previs -- \
  --manifest examples/previs/minimal-dialogue.json \
  --write --reset-project --initialize-only \
  --output artifacts/previs

# Full run (optional isolated browser profile)
npm run agent:previs -- \
  --manifest examples/previs/music-video-graybox.json \
  --write --reset-project \
  --profile .forescene-agent/music-video-profile \
  --output artifacts/previs

# Correction loop after editing failed/warned shots
npm run agent:previs -- \
  --manifest path/to/manifest.json \
  --write \
  --update-manifest \
  --output artifacts/previs
```

Safety:
- `--reset-project` requires `--write`.
- Manifest hash is stored in `run-state.json`; a silently changed manifest is refused.
- Pass `--update-manifest` to invalidate only changed shots (and dependents). Shot-only edits resume without `--reset-project`. Location/cast/prop edits also need `--reset-project` so creates are not duplicated.
- `--profile` selects a persistent Playwright user-data dir (defaults to `.forescene-agent/profile`).
- Unless `--skip-package` is set, a failed package phase makes the run `ok: false`.


## `agent:render-stills` / `agent:contact-sheet`

```bash
npm run agent:render-stills -- --write --output artifacts/previs
npm run agent:contact-sheet -- \
  --input artifacts/previs/shots \
  --output artifacts/previs/contact-sheet.png
```
