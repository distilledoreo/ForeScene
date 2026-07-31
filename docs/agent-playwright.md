# ForeScene Agent Playwright CLI

The Agent CLI uses Playwright (not raw CDP) to connect to a running ForeScene instance and call `window.foreScene`.

## Scripts

```bash
npm run agent:inspect
npm run agent:preview -- --plan plans/example.json
npm run agent:apply -- --plan plans/example.json --write
npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
npm run agent:verify -- --workspace build --output artifacts/verify.png
npm run agent:run -- --plan plans/example.json --screenshot artifacts/out.png --write
npm run agent:package -- --write --output artifacts/package.zip
```

`preview` prepares a plan without mutating the live project (read-only mode is enough).  
`apply` / `run` / `package` **require** explicit `--write` or `--persist-write` and refuse to start without it.

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
