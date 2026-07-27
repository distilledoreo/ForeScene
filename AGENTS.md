# AGENTS.md

## Cursor Cloud specific instructions

### What this is
`continuity-stage` is a **local-first, browser-only** React 19 + TypeScript + Vite 6 app (Three.js 3D + 360 panorama tooling). There is **no backend, database, account system, or secrets** — running the single Vite dev server exercises the whole product end to end.

### Running (see `package.json` scripts / `README.md` for the canonical list)
- Dev server: `npm run dev` → serves on port **3000** (`--host=0.0.0.0`). This is the whole app.
- Build: `npm run build` (Vite; does not type-check). Preview built output: `npm run preview` (port 4173).

### Non-obvious caveats
- **Node 22+ is required** (uses React 19 / Vite 6 / ESM).
- **`npm run lint` is `tsc --noEmit`** and must remain clean. It is the separate TypeScript validation because `npm run build` (Vite) skips `tsc`; run it before delivery.
- **`npm run test` (Vitest) needs the Playwright Chromium browser.** A few tests (`tests/projected*.test.ts`) launch a real headless Chromium for WebGL shader compilation and fail with "Executable doesn't exist" until `npx playwright install chromium` has been run. The startup update script installs it; if tests suddenly can't find the browser, re-run `npm run test:e2e:install`.
- Playwright E2E (`npm run test:e2e`) auto-runs `npm run build` + `vite preview` on port 4173 unless `PLAYWRIGHT_BASE_URL` is set.
- Set `DISABLE_HMR=true` to disable Vite HMR/file watching (lowers CPU during heavy agent edits).
