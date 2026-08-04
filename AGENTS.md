# AGENTS.md

## Cursor Cloud specific instructions

### What this is
ForeScene (`forescene` package) is a **local-first, browser-only** React 19 + TypeScript + Vite 6 app for previsualization, continuity, and AI-video handoff (Three.js 3D + 360 panorama tooling). There is **no backend, database, account system, or secrets** — running the single Vite dev server exercises the whole product end to end.

### Operating ForeScene vs developing ForeScene

**Operating ForeScene** — the user wants you to manipulate a live ForeScene project (hosted or local) from a shot list / production brief. Use the Agent CLI and the ForeScene previs skill. **Do not edit application source code.**

Preferred commands:

- `npm run agent:inspect`
- `npm run agent:previs`
- `npm run agent:preview`
- `npm run agent:apply`
- `npm run agent:render-stills`
- `npm run agent:contact-sheet`
- `npm run agent:package`

For ForeScene previs or production operation, read `skills/forescene-previs/SKILL.md`.
Harness-specific copies under `.grok/`, `.claude/`, and `.kilo/` are generated
adapters; do not edit them directly. Do not edit ForeScene source while
operating the app unless the user explicitly authorizes switching from
production operation to application development.

See `docs/previs-production-manifest.md` for the manifest reference.

**Developing ForeScene** — the user wants you to change the application itself. Normal source-code development is allowed; follow the validation levels below.

### Running (see `package.json` scripts / `README.md` for the canonical list)
- Dev server: `npm run dev` → serves on port **3000** (`--host=0.0.0.0`). This is the whole app.
- Build: `npm run build` (Vite; does not type-check). Preview built output: `npm run preview` (port 4173).

### Validation levels (do not overvalidate)

During implementation, run only tests directly related to changed behavior. Do not run the full Vitest, Playwright, responsive, visual, WebKit, or production-build suites after every edit. Run TypeScript and affected tests at coherent checkpoints. Run the full pre-merge validation once after implementation stabilizes. CI and nightly workflows own broad regression coverage.

Prefer better-targeted tests over more tests. A focused behavioral regression for the real failure mode beats broad suites that still miss it.

#### 1. Active coding (inner loop)
Run only:
- The directly relevant test file (`npx vitest run tests/<file>.test.ts`)
- Browser-backed files the same way (`npx vitest run tests/browser/<file>.test.ts`) — default Vitest config includes them; `npm run test` uses the fast config that excludes them
- The specific test name when narrowing a bug (`npx vitest run tests/<file>.test.ts -t "name"`)
- Optionally `npm run lint:fast` after TypeScript-heavy edits

Do **not** run after every adjustment:
- Full Vitest (`npm run test` / `npm run test:all`)
- Production build
- Playwright smoke / responsive / visual / WebKit / heavy
- Screenshot baselines

Vitest loads only the paths you pass; prefer a file path so unrelated tests never load.

#### 2. Coherent milestone / commit checkpoint
Run:
- `npm run lint:fast` (incremental) or `npm run lint` if you need a clean check
- `npx vitest run <relevant test files>` or `npm run test:changed` when several files changed
- One focused Chromium/Playwright test **only** when the milestone changes a visible browser workflow

#### 3. Before opening or merging a PR
Run once after the implementation is stable:
- `npm run lint`
- `npm run build`
- `npm run test` (fast unit suite; no Chromium)
- `npm run test:browser` when renderer / projection / WebGL code changed
- `npm run test:e2e:smoke` (Chromium desktop smoke)
- Any feature-specific E2E you added

Leave tablet/phone responsive, WebKit, screenshot baselines, and heavy workflows to path-conditional CI or the full-regression workflow (main / nightly / manual).

### Test suite split
| Script | What it runs | Needs Chromium? |
|--------|----------------|-----------------|
| `npm run test` | Fast unit/integration under `tests/**`, excluding `tests/browser/**` | No |
| `npm run test:browser` | WebGL / canvas / shader / pixel-readback gates in `tests/browser/**` | Yes |
| `npm run test:all` | Entire Vitest tree | Yes (for browser tests) |
| `npm run test:changed` | Fast suite filtered to files changed vs `origin/main` | No |
| `npm run lint:fast` | Incremental `tsc --noEmit` using `.tsbuildinfo` | No |
| `npm run lint` | Clean `tsc --noEmit` (CI / pre-merge) | No |

### Non-obvious caveats
- **Node 22+ is required** (uses React 19 / Vite 6 / ESM).
- **`npm run lint` is `tsc --noEmit`** and must remain clean. It is the separate TypeScript validation because `npm run build` (Vite) skips `tsc`; run it before delivery. Prefer `npm run lint:fast` during the inner loop.
- **`npm run test` does not need Playwright Chromium.** Browser-backed WebGL tests live in `tests/browser/**` and run via `npm run test:browser` (or `npm run test:all`). Install Chromium with `npm run test:e2e:install` / `npx playwright install chromium` before those.
- Playwright E2E (`npm run test:e2e`) auto-runs `npm run build` + `vite preview` on port 4173 unless `PLAYWRIGHT_BASE_URL` is set. Prefer tagged suites: `test:e2e:smoke` (required on PR), `test:e2e:responsive`, `test:e2e:visual`, `test:e2e:heavy`, `test:e2e:webkit`, `test:e2e:webkit-gpu` (canary). Set `PLAYWRIGHT_SKIP_BUILD=1` when `dist/` is already built. `FULL_REGRESSION=1` enables serial workers + one retry (main/nightly).
- Set `DISABLE_HMR=true` to disable Vite HMR/file watching (lowers CPU during heavy agent edits).
- **`agent:previs --reset-project` requires `--write`.** `--write` alone does not authorize project replacement.

### What to assert in tests
Prefer behavioral proofs (“opening Stage starts zero automatic preview renders”) over source-wiring inspections (“this `useEffect` must list these exact dependency names”). Keep UI label / Help inventory guards when they protect discoverability; prune implementation-structure string matches when a real behavioral test already covers the regression.
