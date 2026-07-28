# Code Cleanup — Agent Handoff Plan

> **Status:** planning document. **Do not implement new product features this cycle.**
> Treat the current build as a product milestone: use it, break it, polish it.
> This file is the authoritative brief for the next coding agent working on
> `feature/code-cleanup-v3` (branched from `origin/main` at `0b8bfce`).

## 1. Mandate (from the product owner)

1. **No major features for one cycle.** Polish-only.
2. **Finish the architecture refactor** — strictly behavior-neutral:
   - real Zustand slice implementations (no single store implementation containing every domain mutation);
   - move camera-move orchestration out of `ShotsWorkspace`;
   - move still-capture orchestration out;
   - move preview/timeline orchestration out;
   - extract App project lifecycle into `useProjectLifecycle` — **✅ DONE (PR #42)**;
   - separate app chrome/menu from startup and persistence wiring.
   - Size targets: workspaces ≈ 600–900 lines; hooks/controllers ≈ 300–500; engine functions ≈ 200–300.
3. **Raise the type-safety floor** — **✅ DONE (PR #41)**: `@types/react` + `@types/react-dom` added, `strict: true` in `tsconfig.json`. CI (`npm run lint` = `tsc --noEmit`) now enforces strict mode. Do not weaken it; fix code, not the config.
4. **Add a storage and performance budget** (explicit supported limits).
5. **Turn the strongest manual workflows into E2E tests** (list in §5 T5).

## 2. What is already done

| PR | Commit | Content |
| --- | --- | --- |
| #41 | `c0ba7e7` | Strict TypeScript + React types; 55 errors fixed behavior-neutrally |
| #42 | `9130ce4` | `src/hooks/useProjectLifecycle.ts` (360 lines) extracted from `App.tsx` (901 → 611). App keeps chrome/menu state + `navigateWorkspace`; hook closes help/safety overlays via a `closeProjectOverlays` callback. Code-split dynamic imports (`projectIO`, `projectSafety`, `projectPersistenceController`) moved with the hook. |

## 3. Current measurements (total lines, `ReadAllLines`)

| File | Lines | Target | Note |
| --- | --- | --- | --- |
| `src/App.tsx` | 611 | 600–900 | In range, but chrome/menu vs startup wiring split still pending (§5 T1) |
| `src/hooks/useProjectLifecycle.ts` | 360 | 300–500 | ✅ |
| `src/components/workspaces/ShotsWorkspace.tsx` | 2,864 | 600–900 | Biggest job (§5 T2) |
| `src/components/workspaces/BuildWorkspace.tsx` | 1,493 | 600–900 | Later |
| `src/components/workspaces/ReferenceWorkspace.tsx` | 738 | — | ✅ |
| `src/components/workspaces/ExportWorkspace.tsx` | 698 | — | ✅ |
| `src/components/viewers/SceneViewport.tsx` | 2,352 | — | Not on the mandate list; leave alone unless time remains |
| `src/state/slices/continuityStoreImpl.ts` | 1,673 | slices | §5 T3 |

Existing Shots controller hooks (thin, already wired): `useShotCameraController` (56), `useShotRenderController` (74), `useShotStagingController` (46), `useVideoAuthoringController` (59) — the video pipeline already runs through the `engine/videoAuthoringMachine` reducer; `ShotsWorkspace` consumes `videoAuthoring.mode/captureState/timelineOpen/isPreviewing`.


## 4. Repo knowledge you need before touching anything

### Validation (run before every commit)
- `npm run lint` — `tsc --noEmit` (strict). **Must stay clean.**
- `npm run build` — Vite (does **not** type-check).
- `npm run test` — Vitest; needs Playwright Chromium for `tests/projected*.test.ts`.
- E2E: build once, then `PLAYWRIGHT_SKIP_BUILD=1 npx playwright test --project=desktop-chromium --grep "@smoke"`.

### Hard constraints
- **Behavior-neutral only.** Screenshot baselines **never** regenerated.
- **Line endings: most files are CRLF.** Mixed: `StyledPanoImportButton.tsx`, `PanoViewer.tsx`. Multi-line edits: convert to LF, edit, convert back to CRLF — zero diff noise for uniform-CRLF files. Never round-trip mixed-EOL files.
- **Source-string tests pin file layout.** Move pins with code. Known: `startupLoading.test.ts`, `productionPath.test.ts`, `storeSubscriptions.test.ts`, `storeSlices.test.ts`, `shotStillCapture.test.ts` (reads ShotsWorkspace between `const snapshotPreview` / `const captureStill` — read before T2), `uiFidelity.test.ts`.
- **E2E navigation must use `goToWorkspace`** from `e2e/workspace-navigation.ts` (never bare tab clicks).
- Long runs >30 s → detached `.cmd` + log polling.
- Stash `wip: stray cline dep...` holds unrelated `package.json` junk — never commit.

### Known pre-existing failures (fix separately in T0, not inside refactors)
- `@heavy` e2e `second capture: suggest B…` fails on origin/main: `getByRole('button', { name: /Reference settings|Settings/i })` matches two buttons in dual-pano state (`data-reference-settings-gear` + alignment chrome Settings button).
- WebKit GPU canary (`@webkit-gpu`) expected to fail; green-with-warning by design.

## 5. Work plan

### T0 — Fix the heavy-test selector (small, isolated)
- Replace ambiguous `/Reference settings|Settings/i` with `[data-reference-settings-gear]` in `e2e/layout-and-workflow.spec.ts`. Validate `--grep "second capture: suggest B"` passes (~6 min bg). Commit alone.

### T1 — App chrome/menu vs startup separation (App.tsx part 2)
Remaining: header, stage navs, workspace switchboard, toast/dialog hosts, small components, menu/help effects, splash. Target: `src/components/app/AppHeader.tsx` + App.tsx as 250-400 line composition root. Keep all `data-*` hooks. Move source-string pins with code. Acceptance: sizes in target, zero behavior change, full battery.

### T2 — ShotsWorkspace orchestration extractions (3 commits, 2864 → ~900)
Existing thin hooks: `useShotCameraController` (56), `useShotRenderController` (74), `useShotStagingController` (46), `useVideoAuthoringController` (59).
1. Still capture → `useStillCaptureController.ts`. **Re-point `shotStillCapture.test.ts` markers to the new file.**
2. Camera move → `useCameraMoveController.ts`.
3. Preview/timeline → `useCameraMovePreviewController.ts` (or fold).
Keep `data-shots-*` and store calls identical. Move `productionPath.test.ts` pins with code. Acceptance: ShotsWorkspace ≤ ~900, full battery.

### T3 — Real Zustand slices (continuityStoreImpl.ts 1673 → slices)
Five slice creators exist (project/selection/history/workflow/session, 27-58 lines). Move mutations out of impl into matching creators. Preserve exact public API (`slices/types.ts` ContinuityStoreSlices, `keys.ts`). Read `storeSlices.test.ts` first. Order: selection → session → workflow → history → project. `projectWorkflow.test.ts` is the safety net.

### T4 — Storage & performance budget
`src/engine/budgets.ts` + README. Constraints: max triangles, project size, recovery storage, 4K memory, export time, camera-move combos. Read-only — no new blocking behavior.

### T5 — Workflow E2E tests (from README manual)
1. save → close → recover → export
2. import GLB → manipulate → capture → backup → reopen
3. multiple shots with clean-plate/both-people → package
4. camera move + object animation → preview → MP4 → package (Chromium-only)
5. exhaust storage quota → verify recovery messaging
New heavy tests → `ci-full.yml`, not PR smoke.

## 6. Per-commit checklist

1. `npm run lint` clean (strict).
2. `npm run build` clean.
3. `npm run test` — 642+ passing.
4. `PLAYWRIGHT_SKIP_BUILD=1 npx playwright test --project=desktop-chromium --grep "@smoke"` green (add `@responsive`/`@visual`/targeted `@heavy` as needed).
5. `git diff --stat` shows only intended files; no EOL noise; no snapshot files.
6. Commit message: short imperative subject + body. Push to `feature/code-cleanup-v3`.

## 7. Branch/PR conventions

- One slice per commit; PR at each green milestone.
- Never commit `package.json`/`package-lock.json` unless the task changes dependencies.
- Visual baselines are never regenerated in this branch.
