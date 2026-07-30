# ForeScene Agent Playwright CLI

The Agent CLI uses Playwright (not raw CDP) to connect to a running ForeScene instance and call `window.foreScene`.

## Scripts

```bash
npm run agent:inspect
npm run agent:preview -- --plan plans/example.json
npm run agent:apply -- --plan plans/example.json
npm run agent:screenshot
npm run agent:verify
```

`preview` / `apply` require a later milestone (currently return `write_access_required` or `not_implemented`). `screenshot` / `verify` are stubs.

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
  return status?.ready && status.projectLoaded;
});
```

## Write access for CLI profiles

```bash
npm run agent:inspect -- --write
```

This seeds `localStorage['forescene-agent-control'] = 'read-write'` in the persistent profile before the app boots. Normal browser profiles never set that key and stay read-only.

## Origin consistency

A project opened under port 3000 is a different browser storage origin than port 4173. Keep the Agent CLI on one URL (prefer the Vite dev server on 3000).

## Visual verification

Screenshots remain normal Playwright:

```ts
await page.locator('[data-testid="scene-viewport"]').screenshot({ path: outputPath });
```

(`agent:screenshot` will wrap this in a later milestone.)
