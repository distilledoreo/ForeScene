# Agent interface hardening — implementation plan

Status: **in progress** (approved 2026-08-27)

Scope note: the original proposal included an MCP server/adapter. Per the user's
instruction, **MCP is explicitly out of scope**. Everything else from the audit
is in scope. The optional long-lived `agent:serve` daemon is deferred (see
Phase 4) because its primary consumer was the MCP adapter; revisit separately.

Verified defects being fixed (from the audit):

- **D1 (envelope leak):** `agent:frame` strips `pngDataUrl` from stdout but the
  same base64 survives in `result.artifact.dataUrl` (`AgentArtifactInline`).
- **D2 (silent flag):** `agent:previs -- --no-auto-repair` parses the flag but
  the previs dispatch never forwards `autoRepair`/`maxRepairPasses` to
  `runPrevisCli`, so repair is always enabled (`autoRepair ?? true`), while the
  public descriptor advertises both flags.

## Phase 1 — verified bug fixes

- [x] D2: forward `autoRepair` + `maxRepairPasses` in the previs dispatch
      (`scripts/agent/cli.ts`).
- [x] D1: frame CLI result strips `artifact` (inline dataUrl) alongside
      `pngDataUrl`; adds `sha256`, `byteLength`, and resolved `shotNumber`.
      New pure helper `buildFrameCliResult` in `scripts/agent/frameResult.ts`.
- [x] Tests: helper unit test (known digest, no inline payload fields);
      `--no-auto-repair` parse test; dispatch-forwarding guard.

## Phase 2 — one selector, complete discovery, honest batches

### 2a. One shot selector, fail closed

- [x] New leaf module `src/engine/agent/shotNumberMatch.ts`
      (`normalizeShotNumber` + list matching); `matchShotsByNumber` delegates.
- [x] `resolveCliShotReferences` in `scripts/agent/cliShotSelection.ts`:
      exact id → exact shotNumber → padding-normalized; ambiguity lists
      candidates; canonical `{id, shotNumber}` output.
- [x] Wired into: `frame`, `video`, `shot-panorama` (replaces `/^\d+$/`
      heuristic), `world-depth`, `world-preview`/`world-mock` (Node-side),
      `render-passes`/`plan-exports` (`resolveShotIds`), `asset-contract`.
- [x] `verify`/`visual-preflight`: resolve what matches, pass unknowns through
      unchanged (preserves the documented engine-side fail contract).
- [x] `frame`/`video` results echo canonical `shotId` + `shotNumber`.
- [x] Tests: resolver unit tests (padding, ambiguity, unknown, dedupe).

### 2b. Complete, fail-closed command discovery

- [x] `COMMAND_DESCRIPTIONS` becomes an exhaustive
      `Record<AgentCliCommand, AgentCliCommandDescription>` (compile-time
      fail-closed); generic fallback deleted from `describeAgentCliCommand`.
- [x] Descriptors written for all previously-fallback commands: `open`,
      `cancel`, `operations`, `preview`, `apply`, `screenshot`, `verify`,
      `visual-preflight`, `asset-contract`, `world-preview`, `world-mock`,
      `world-depth`, `run`, `render-stills`, `render-passes`, `plan-exports`,
      `refine`, `analyze-character`, `import-character`, `import-model`,
      `import-panorama`, `shot-panorama`, `replace-proxy`, `help`.
- [x] Test: every `AGENT_CLI_COMMANDS` entry returns a real descriptor (no
      fallback marker).

### 2c. Honest aggregate results

- [x] Standalone `agent:contact-sheet` fails closed: per-frame existence +
      run-state render checks, per-shot report, sha256 per frame; new
      `--allow-partial` builds the sheet but keeps `ok: false` + `partial: true`.
- [x] `agent:render-stills` `ok` is a conjunction: any failed or unrendered
      compiled shot → `ok: false` with `failedShotNumbers`/`pendingShotNumbers`.
      Pure outcome helper extracted for tests.
- [x] Previs summary reports `repairsAttempted` and `repairsDisabled`
      (true iff `--no-auto-repair`), proving D2 end-to-end in the result.
- [x] Tests for the pure helpers (no browser needed).

## Phase 3 — transactions, prune safety, plan-op cinematic verbs

- [x] `expectedRevisionId` on apply: engine `applyAgentPlan(input, { expectedRevisionId })`
      + `browserApi.applyPlan` + CLI `--expected-revision <id>` on `apply`;
      mismatch/no-active-revision → `stale_revision`, no mutation.
- [x] Scaffold-only previs prune: final prune deletes intact-scaffold shots
      only; non-manifest user shots are retained and reported unless
      `--prune-non-manifest-shots` is passed. Pure `selectPrunableShots` helper
      (`scripts/agent/shotPrune.ts`) + zero-shot guard preserved.
      Flag threaded through previs + production dispatch.
- [x] Plan-op cinematic verb `shot.frameSubjects` (plan commands, not
      imperative CLI verbs): solver-expanded at plan-prepare time into a camera
      update so preview/diff/apply/undo all work unchanged. Documented in
      `agent:schema`/discovery.
- [ ] Follow-ups (documented, not in this pass): `object.snapToFloor`,
      `object.placeNearLandmark`, `object.orientToward` as plan ops using the
      same expansion pattern; camera-only `repairShot` verb.

## Phase 4 — deferred

- Long-lived `agent:serve` daemon (process reuse, single-flight writes, idle
  write demotion). Its main consumer was the MCP adapter, which is out of
  scope per instruction. Revisit as its own change after Phases 1-3 land.

## Validation checklist

- [x] `npx vitest run tests/agentCli.test.ts` (CLI/discovery/resolver/frame/prune)
- [x] `npx vitest run tests/agentTransaction.test.ts` (expectedRevisionId)
- [x] `npx vitest run tests/agentPlanCompiler.test.ts` (shot.frameSubjects)
- [x] `npm run lint:fast` at checkpoints; `npm run lint` before delivery
- [x] Docs updated (capability matrix, agent-playwright flags, agent-api plan
      ops, SKILL) + `npm run sync:agent-skills` + `npm run verify:agent-skills`

## Progress log

- 2026-08-27: Plan created.
- 2026-08-27: Phase 1 done — previs dispatch forwards autoRepair/maxRepairPasses
  (D2); frame CLI result strips artifact.dataUrl alongside pngDataUrl and adds
  sha256/byteLength/shotNumber (D1) via scripts/agent/frameResult.ts.
- 2026-08-27: Phase 2a done — shared shot-number matcher
  (src/engine/agent/shotNumberMatch.ts), resolveCliShotReferences wired into
  frame/video/shot-panorama/world-*/render-passes/plan-exports/asset-contract;
  verify/visual-preflight use pass-through resolution; canonical shotId +
  shotNumber echoed on render results.
- 2026-08-27: Phase 2b done — COMMAND_DESCRIPTIONS is an exhaustive Record
  (compile-time fail-closed); descriptors written for all 24 previously
  fallback commands; help shotSelection texts updated.
- 2026-08-27: Phase 2c done — contact-sheet fails closed with per-frame report
  + --allow-partial; render-stills ok is a conjunction with
  failed/pendingShotNumbers; previs summary reports repairsAttempted +
  repairsDisabled (scripts/agent/batchHonesty.ts).
- 2026-08-27: Phase 3 done — expectedRevisionId CAS on applyPlan (engine +
  browser API + CLI --expected-revision); scaffold-only previs prune with
  --prune-non-manifest-shots (scripts/agent/shotPrune.ts); shot.frameSubjects
  plan op expanding to shot.updateCamera via the frameSubjects solver.
- 2026-08-27: Production parity — ProductionRunResult now surfaces
  repairsAttempted/repairsDisabled from the previs summary.
- 2026-08-27: Docs updated (agent-api, agent-playwright, SKILL + synced skill
  copies via sync:agent-skills/verify:agent-skills). Live smoke: agent:schema
  lists shot.frameSubjects (35 ops); describe returns real descriptors for
  previously-fallback commands; help --json carries the resolver contract.
- 2026-08-27: Final validation — npm run lint clean (tsc --noEmit); 214 tests
  passing across 15 affected files (agent CLI/discovery, selector, frame
  envelope, batch honesty, prune, expectedRevisionId, shot.frameSubjects,
  plan validation/staging/timeline, API robustness, production run, previs).
  Note: scripts/benchmark/* and tests/benchmarkHarness.test.ts diffs in the
  working tree predate this change and are untouched here.
  Not run this pass (left to CI / pre-merge per AGENTS.md): full fast suite,
  browser WebGL suites, Playwright e2e (agent-cli/agent-ops smoke), build.
