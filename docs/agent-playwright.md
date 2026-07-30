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
`apply` / `run` / `package` require `--write` (or an already seeded CLI profile) and commit through Project Safety / Export package control.

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
```

## Write access for CLI profiles

```bash
npm run agent:apply -- --write --plan plans/conversation.preview.json
```

This seeds `localStorage['forescene-agent-control'] = 'read-write'` in the persistent profile before the app boots. Normal browser profiles never set that key and stay read-only.

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
