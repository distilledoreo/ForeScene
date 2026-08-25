---
name: forescene-previs
description: Operate a ForeScene project as rapid rough previs by default, or as production-integrity refinement/export when explicitly requested. Use for autonomous still or motion previs without editing ForeScene source.
---

# ForeScene Previs Skill

## When to use

Use this skill when an automation harness must drive a **hosted or local ForeScene app** from a screenplay, production brief, shot list, or approved project. It covers:

- Still-frame previs and graybox storyboards.
- Motion previs and camera-path visualization.
- Blocking, pose, and pose-continuity guidance.
- Imported-character setup when the user supplies character files.
- Project-preserving production-asset refinement and verified package delivery.

The output is an editable ForeScene project and an evidence-backed handoff package. ForeScene control videos communicate camera, timing, blocking, and silhouette intent; they are not final AI video and do not replace performance animation.

## Canonical CLI surface

The Agent CLI is the public automation surface. **Before authoring**, query capabilities. Do not inspect ForeScene source or call `window.foreScene` to discover whether an operation exists.

```bash
npm run agent:capabilities
```

Stdout is one JSON envelope. Read `result.capabilities`: if a capability is `true`, use the documented `npm run agent:*` command for that operation. See `docs/agent-capability-matrix.md`.

Every command writes one envelope to stdout (`ok`, `operation`, `operationId`, `durationMs`, `warnings`, `error`, `result`). Parse that object. Human progress and `[agent-op]` heartbeats are on stderr and are not the machine contract. Exit `0` success, `1` failure, `2` usage error.

If a long-running command hangs, cancel with `npm run agent:cancel -- --operation <id>` (or omit `--operation` for the latest active record). Do not kill Chromium.

## Benchmark mode

When `FORESCENE_BENCHMARK=1` or `FORESCENE_BENCHMARK_BRIEF` is set, the repository harness owns the experiment. The candidate owns previs only.

1. Read the JSON brief at `FORESCENE_BENCHMARK_BRIEF` first.
2. Honor `writeAuthorized`. If it is `false`, do not pass `--write`.
3. Honor `resetAuthorized`. If it is `false`, `--reset-project` and `resetProject` are prohibited.
4. Honor `repairBudget`: at most that many visual-repair passes after the first authoring pass. When the budget is exhausted, stop and report remaining failures.
5. Stay `cliOnly`. Do not create `run-benchmark.ts`, `open-package.ts`, or `render-stills.ts`. Do not call `window.foreScene`. Do not inspect ForeScene source when the capability map marks the operation as CLI-supported.
6. Use `FORESCENE_REPO_ROOT`, `FORESCENE_URL`, `FORESCENE_PROFILE`, and `FORESCENE_OUTPUT` from the environment (and the brief's `repoRoot` / `url` / `profileDir` / `outputDir` when present). The working directory may be outside the ForeScene checkout. Invoke documented commands as `npm --prefix "$FORESCENE_REPO_ROOT" run agent:<command>`. Write required stills and motion files under `FORESCENE_OUTPUT`.
7. If ForeScene times out (`character.import` or similar), stop and report an infrastructure failure. Do not edit the harness, the skill, or ForeScene source to make the run pass.

## Operating vs developing

**Operating ForeScene** (this skill): manipulate a live project through the Agent CLI and hosted app. Do **not** edit application source code.

**Developing ForeScene**: edit application source only when the user explicitly asks to change the app itself. This skill does not add Agent API capabilities; use the current documented API and commands.

## Agent primitives versus the optional refinement runner

The individual Agent API operations and CLI commands are ForeScene's reusable, first-class primitives. Use them independently whenever the task calls for ordinary project operation, simple asset replacement, normal shot correction, rendering, package planning, or export verification.

`agent:refine` is an optional advanced runner for high-risk, resumable modification of a valuable existing project. It is not required for ordinary ForeScene operation, simple asset replacement, normal shot corrections, rendering, or export, and it must not become a prerequisite for the existing-project workflow below.

The skill owns production interpretation, visual judgment, repair strategy, and the decision to continue or stop. ForeScene and the Agent API provide the operations, validation, preservation mechanisms, and export capabilities that the skill uses.

## Quality modes

Choose a quality mode before writing. **Rapid-previs is the default** for rough, communicative, editable frames used as spatial control references. Choose **production-integrity** only when the user requests final packages, client approvals, motion deliverables, or high-value approval evidence.

| Mode | Default use | Review standard | Batch size after canary |
| --- | --- | --- | --- |
| **rapid-previs** | Rough still previs and spatial control references | Objective checks plus human visual review; asset-limited but communicative frames may pass | 6–8 shots |
| **production-integrity** | Final packages, client approvals, motion deliverables, or high-value projects | Full preservation, artifact, diagnostic, and approval evidence | 3–5 shots |

## Rapid-previs workflow

Use this mode unless the user explicitly selects production-integrity. Keep the loop short and stop for human review:

```text
Inspect once
→ verify the unique working project
→ resolve bindings and capabilities once
→ run the three-part canary
→ author 6–8 shots
→ save and reopen once
→ render one frame per shot and one contact sheet
→ apply camera-only shot-size cleanup
→ human accepts or rejects
→ revise rejected shots only
```

### Rapid-previs preflight

Before the canary, inspect and cache one small capability map containing:

- Semantic entity bindings and character variants.
- `.fsrig` source/package availability and rig-first pose capability.
- Transform-only assets and embedded versus separately targetable features.
- Location and panorama routing.
- Missing assets and the exact working project identity.

Do not rediscover these facts per shot. A missing binding or transform-only limitation is an asset limitation to record once, not a reason to invent a duplicate entity.

### Mandatory three-part canary

Run exactly these practical visual checks before full authoring:

1. **Humanoid framing:** one close-up or full-body character frame aimed with `.fsrig` landmarks.
2. **Saved-rig posing:** one visibly non-neutral pose that is confirmed in the rendered frame and survives reopening.
3. **Multi-subject staging:** two subjects with deliberate foreground/background overlap.

The canary must expose panorama persistence, project recovery, imported-rig telemetry, anatomical bounds, saved-pose rendering, and transform-only creature limitations. A canary failure blocks only the capability-dependent work; unrelated transform-only shots may continue when their frames remain communicative.

### Rapid-previs authoring

1. Treat the original shot list, continuity rules, and human review as authoritative. AI-generated semantic notes are optional cached interpretation and remain advisory until verified against the live project. Do not create a contract compiler or deterministic contract executor for ordinary rapid-previs.
2. Use existing bindings and locations. Never create duplicate cast, creature, prop, or panorama entities when an existing binding resolves.
3. Stage the physical action or subject relationship before adjusting the camera. For interaction shots, establish contact/overlap first. For action or weapon-led shots, use action-first staging. For readable humanoid shots, use the validated landmark framing pattern.
4. Apply all selected batch mutations, save, and reopen once for the batch. Do not reopen per shot.
5. Render one canonical review frame per shot and one contact sheet. Do not package, export final deliverables, or begin motion authoring unless separately requested.
6. Quarantine a failed or blocked shot and continue unrelated shots in the batch. Do not run a broad blind repair loop.

### Rig-first pose and bounds

For imported humanoids, resolve in this order:

1. Evaluated `.fsrig` joints.
2. `.fsrig` markers and bind data.
3. Persisted asset anchors.
4. Rig-derived anatomical bounds.
5. Generic bounds fallback.

A persisted `humanPose` is not sufficient evidence. A posed render requires explicit telemetry with `poseApplied: true`. If pose application is unavailable, preserve a readable static/transform-only frame and classify it as asset-limited unless the shot intent is blocked.

### Framing authority

The original shot-list Framing field is authoritative:

- Extreme close-up: isolate the named detail.
- Close-up: head and shoulders; legs outside the frame.
- Medium close-up: head through upper chest.
- Medium: head through waist.
- Medium full: head through knees.
- Full or wide: include feet only when explicitly requested.
- Ambiguous humanoid framing: default to medium.

Aim humanoid cameras using rig-derived head, eyes, and chest landmarks. Never aim at the character root, complete assembly center, shield, or weapon. Use shield/sword bounds only as crop-safety checks.

### Rapid-previs validation and acceptance

Automatically validate exact project/shot identity, character variant, closed-world presence, location/panorama, pose application when required, missing assets, nonblank render, persistence after reopen, and gross cropping. Do not spend production time proving that a rough frame is aesthetically ideal.

Use these acceptance categories:

- **Accepted** — communicates the shot and passes objective checks.
- **Accepted, asset-limited** — communicates the shot but a supplied asset cannot provide a requested pose or feature.
- **Needs revision** — objective state is valid but the frame does not communicate the shot.
- **Blocked by capability** — the required asset, binding, pose, or render path is unavailable.

### Fast framing cleanup

After each rapid-previs batch:

1. Render all new frames.
2. Compare achieved framing with the original shot-size field.
3. Apply camera-only corrections to obviously over-wide or over-tight frames.
4. Regenerate the contact sheet.
5. Stop for human review.

Do not restage, rebind, re-rig, or perform autonomous creative repair during this cleanup pass. Revise only explicitly rejected shots afterward.

### Rapid-previs reporting

Retain only one capability/binding preflight, one batch persistence record, the frame directory, the contact sheet, and concise blockers or asset limitations. Write detailed per-shot diagnostics only when a failure needs diagnosis.

## Production-integrity workflow (opt-in)

For a manifest-backed production explicitly using production-integrity, prefer the gated `agent:production` entry
point over assembling an unattended sequence of
lower-level `agent:previs` steps. Do not call `window.foreScene` production APIs when `production.orchestrate` is `true`. The production workflow is:

1. Inspect the project and choose Greenfield, Existing-project refinement, or
   Export-only. Never reset a valuable project without explicit authorization.
2. Validate `project.workflow.production` bindings, prepared locations, exact
   shot presence contracts, panorama routing, required asset capabilities, and
   approved pose substitutions before compilation.
3. Create the recovery revision and run the deterministic capability-covering
   canary. A canary failure blocks full authoring; an override requires a
   written reason in the production report.
4. Produce project-wide primary still sheets and inspect them visually. Do not
   create the complete pass matrix or motion videos before primary still
   approval.
5. Record `approveStillLayout` against the verified revision, then clone that
   approved layout for motion with `createMotionWorkingRevision`. Motion work
   must not mutate the approved still revision.
6. Use event-aware review samples and content-addressed reruns. A cache hit is
   valid only when camera, effective staging/pose, panorama, relevant assets,
   renderer/profile inputs, and location revision all match.
7. Run motion review and final export only after the still gate. Command
   success, artifact existence, and a linked panorama are not visual approval.

Drive the production lifecycle with `npm run agent:production`. Preserve the run ID from the CLI envelope, plus gate state, recovery revision, approved-layout revision, cache keys, artifacts, and blocking diagnostics in the handoff record. Do not inspect ForeScene source to resume a gated run when the CLI capability is true.

## Operating mode is a required first decision

Before any write, inspect the live project and select one quality mode and one operating mode. Record both choices in the preservation preflight or run record. Use `rapid-previs` by default unless the user explicitly requests production-integrity evidence.

| Mode | Use only when | Reset policy |
| --- | --- | --- |
| **Greenfield** | No useful ForeScene project exists, the user explicitly requests a rebuild, or all existing geometry, panoramas, shots, and staging are disposable. | `agent:previs --reset-project` is allowed only with explicit write authorization. |
| **Existing-project refinement** | The project has useful geometry, projected textures or panoramas, shot cameras, blocking, or continuity work. This is the default whenever useful work already exists. | Never reset by default. Inspect and preserve the project; import/replace assets incrementally, repair small shot batches, and rerender only affected shots. |
| **Export-only** | The project is visually approved and the task is only to apply an export profile, render passes, package, and verify delivery. | Do not modify scene, shots, cameras, staging, or timelines. |

**Hard rule:** if the inspected project contains any shots or panoramas and the user has not explicitly asked for reconstruction, `--reset-project` and `resetProject` are prohibited. A changed manifest, a request for new cast/props, or a desire for cleaner clay output is not reconstruction authorization. Use [existing-project-refinement.md](references/existing-project-refinement.md) instead.

## Preservation preflight

For existing-project refinement, complete the required preflight **before any write**:

1. Run `npm run agent:inspect -- --document` and retain the returned project document IDs.
2. Write `artifacts/previs/preflight/project-preservation.json` with the project identity, counts, preservation choices, planned replacements, and every retained ID.
3. Confirm `resetAuthorized` is `false`; only a user’s explicit reconstruction request can make it `true`.
4. Preview every mutation plan before applying it. Preserve the original shot, panorama, retained environment-object, camera, and timeline IDs.
5. After all work, write and pass the final preservation check before claiming delivery.

The full schema, capture method, and final comparison are in [existing-project-refinement.md](references/existing-project-refinement.md).

## Structural previs versus production-asset refinement

Keep these stages distinct:

| Stage | Responsible for | Existing-project rule |
| --- | --- | --- |
| **A — structural previs** | locations, shot list, basic cameras, broad blocking, proxy objects, and coarse motion | Skip it unless the user identifies a structural problem. |
| **B — production-asset refinement** | saved-rig character variants, per-shot variant mapping, real nonhumanoid models, proxy replacement, pose/framing repair, and affected-output rerendering | Run incrementally against the preserved project. |

Do not rebuild Stage A just to perform Stage B. Use the standalone `agent:analyze-character` and `agent:import-character` flow for imported assets in a retained project, then stage them in selected existing shots. For proxy replacements, follow [nonhumanoid-models.md](references/nonhumanoid-models.md).

## Shot-intent classification

Before rendering, assign every affected shot exactly one intent class:

| Class | Use when | Deliverable |
| --- | --- | --- |
| `still` | Composition or continuity is the purpose, with no material camera or subject movement. | One clean control frame. |
| `motion-required` | A dolly, pan, crane, orbit, meaningful crossing, blocking change, entrance, exit, reveal, transformation, or materially different final frame carries the intent. | Start, midpoint, endpoint samples and a control video. |
| `motion-optional` | Minor drift would help, but one frame communicates the shot adequately. | Still by default; add a video only when it adds useful temporal information. |
| `unsupported-performance` | Facial acting, lip sync, hand contact, precise prop interaction, complex locomotion, physics, cloth, or collisions drive the shot. | Coarse motion previs labeled as timing/blocking guidance, not final performance animation. |

Retain the classification in the working notes or review records. Do not silently skip shots.

## Greenfield workflow

Use this only after selecting **Greenfield**:

1. Read the complete screenplay or shot list; extract locations, cast, props, continuity constraints, and exact shot numbering.
2. Create and validate the `PrevisProductionManifestV1` using supported templates. Add `shots[].motion` with valid `durationSeconds`, ordered `keyframes`, and `renderControlVideo: true` only where temporal communication is necessary; follow [motion-authoring.md](references/motion-authoring.md).
3. Run the authorized initial orchestration:

```bash
npm run agent:previs -- \
  --manifest path/to/manifest.json \
  --url https://ForeScene.distilledlabs.org \
  --write \
  --reset-project \
  --output artifacts/previs
```

For a normal prepared production, use the gated production runner instead:

```bash
npm run agent:production -- \
  --manifest path/to/manifest.json \
  --url https://ForeScene.distilledlabs.org \
  --write \
  --mode rapid-review \
  --output artifacts/production
```

Do not interpret this command’s successful start or returned artifacts as
approval. Stop at each blocking gate and retain the canary and still-layout
review records.

4. In rapid-previs mode, work in 6–8-shot batches after the three-part canary. In production-integrity mode, work in gated 3–5-shot batches, not as one unattended run. Inspect each batch before continuing.
5. Configure and verify the output profile before package rendering, then validate every requested artifact and review record.

## Existing-project refinement workflow

Use this for any live project with valuable work:

1. Complete the preservation preflight; retain the original document snapshot and all required IDs.
2. Determine the affected shots and whether the request is Stage B asset refinement or export-only. Do not create replacement locations/shots for work that already exists.
3. Import one saved-rig character variant or real nonhumanoid model at a time. Use a read-only analysis first and an explicit write only for the import.
4. Map the imported asset to the affected existing shot IDs. Apply staging, camera, or timeline repairs through small Agent plans; preview the plan before applying it.
5. Replace each nonhumanoid proxy using [nonhumanoid-models.md](references/nonhumanoid-models.md), retaining a nonzero refinement log and before/after review evidence.
6. Process 6–8 shots at a time in rapid-previs mode, or 3–5 shots at a time in production-integrity mode, under [batch-review.md](references/batch-review.md). In rapid-previs mode, quarantine a failed shot instead of blocking unrelated work; in production-integrity mode, a failed shot blocks the next batch.
7. Rerender only affected outputs, verify their timestamps/revision against the latest scene change, then run the final preservation check.

Never add `--reset-project` to this workflow without the user’s explicit reconstruction authorization and a new preflight that records `resetAuthorized: true`.

For a resumable manifest-backed shot-only correction, use `--update-manifest` without `--reset-project`; it invalidates the affected output while retaining the project.

## Operating versus development escalation

Normal operation must not edit ForeScene source. When a reproducible runtime blocker appears:

1. Stop production authoring and preserve the current project/recovery state.
2. Capture a minimal reproduction, exact project/shot identity, and objective diagnostics.
3. Report the blocker and ask for explicit authorization to switch into app-development mode.

Do not casually drift from producing frames into modifying ForeScene. A source fix may be valuable, but it is a separate authorized task.

## Export profiles and package planning

Before any render, ask for the required output profile or infer it from the request and state the inference. **Never silently default to clay-only.** Use the built-in recommended `ai-control-full` profile when the task requires AI-control, multipass, clean-plate, character-only, projected, or depth deliverables. Its exact Agent plan is [ai-control-full-export-plan.json](examples/ai-control-full-export-plan.json).

1. Apply the profile through `agent:apply -- --plan <path> --write`.
2. Call `npm run agent:plan-exports` afterward.
3. Confirm every required artifact kind is planned with `disposition: "produce"`; required projected artifacts omitted with `missing-projector` are a blocking failure, not a warning to ignore.
4. For a motion-required shot, verify the clay/projected/depth camera-move and reference-frame artifacts expected by the selected profile. For a still, explicitly record that motion artifacts are not required.
5. Only then run `agent:package` and verify the resulting files.

See [deliverables.md](references/deliverables.md) for the output matrix, expected artifact kinds, and the blocking projection rule.

## Batch review and visual acceptance

Use the selected quality mode. Rapid-previs uses **6–8 shots** after the canary, one save/reopen per batch, one frame per shot, one contact sheet, and human review. Production-integrity uses **3–5 shots**, complete evidence, and a gated approval record. A successful command or `validation.json` does not authorize approval. Use [batch-review.md](references/batch-review.md).

Visual QA is authoritative: compare the final frame with the shot description, make sure the intended subjects/framing/scene elements/replacement assets are present, and open or sample every MP4. Empty rooms, irrelevant fragments, and proxies standing in for final assets fail automatically. If visual evidence conflicts with `validation.json`, mark the shot failed. Full criteria: [visual-acceptance.md](references/visual-acceptance.md).

## Command inventory

These commands are available in the ForeScene checkout:

```bash
npm run agent:capabilities
npm run agent:inspect
npm run agent:open
npm run agent:save
npm run agent:cancel
npm run agent:operations
npm run agent:analyze-character
npm run agent:import-character
npm run agent:import-model
npm run agent:import-panorama
npm run agent:shot-panorama
npm run agent:replace-proxy
npm run agent:render-passes
npm run agent:plan-exports
npm run agent:verify-package
npm run agent:preview
npm run agent:apply
npm run agent:screenshot
npm run agent:frame
npm run agent:video
npm run agent:verify
npm run agent:visual-preflight
npm run agent:asset-contract
npm run agent:run
npm run agent:previs
npm run agent:production
npm run agent:render-stills
npm run agent:contact-sheet
npm run agent:package
```

Use `agent:frame` for clean clay, projected, or depth samples (`--mode clay|projected|depth`) and `agent:video` for a direct shot render with the same mode flag. Both accept exactly one `--shot` (or a single `--shots` value) and reject extra ids before the browser opens. `agent:shot-panorama -- --shot <id-or-number> --pano <id|null> --write` links or durably unlinks a shot panorama. `agent:open -- --file <package.fsp> --write` loads an existing project; `agent:save -- --output <package.fsp> --write` writes a verified backup. `agent:cancel -- --operation <id>` stops a long-running CLI process without killing Chromium. Heavy commands emit `[agent-op]` heartbeats on stderr every 5 seconds. `agent:inspect -- --document` returns the full project document for preservation IDs. `agent:verify` and `agent:visual-preflight` accept optional `--shot`/`--shots`: omitted selection validates every shot (or skips the visual gate on an empty project); an explicit selection that matches nothing fails, and unmatched ids appear in the JSON result. `agent:asset-contract` accepts one optional `--shot` (API `shotId`); omit the flag for the whole project. `agent:previs` is a Greenfield manifest orchestration command; it is not the default replacement path for an existing project.

The commands above remain independently available primitives.

Optional advanced runner (not a primitive):

```bash
npm run agent:refine
```

Use this only for high-risk, resumable modification of a valuable existing project; do not route an ordinary existing-project workflow through it by default.

## Artifact layout and evidence

```text
artifacts/previs/
├── preflight/
│   ├── project-preservation.json
│   └── project-preservation-final.json
├── reviews/
│   └── batch-01.json
├── refinement/
│   └── nonhumanoid-replacements.json
├── shots/
│   ├── 010.png
│   ├── 010.composition.json
│   └── 010.mp4
├── contact-sheet.png
├── contact-sheet.html
├── review/
│   ├── location-*.png
│   ├── motion-triptych-*.png (when motion samples are supplied)
│   └── continuity-*.png
├── package.zip
├── validation.json
├── summary.json
└── run-state.json
```

`shots/*.png` must come from the canonical renderer via `agent:frame` (clay by default; `--mode projected` or `--mode depth` when required), not a UI screenshot. `debug/*-ui.png` is for human debugging only. A contact sheet is required for readable review but cannot replace opening suspicious individual frames.

The production review planner supports a master sequence sheet,
location-grouped sheets, motion triptychs, and adjacent-shot continuity strips.
The runner emits motion triptychs when event-aware motion samples are supplied;
otherwise it emits the available still-based sheets under `review/`.
Use `logs/production-review-artifacts.json` to read each tile's shot identity,
sample time, presence/panorama/composition diagnostics, review status, and cache
state. Treat these sheets as compact evidence for review; route any repair
proposal through a previewed, verified mutation and record the resulting review
decision separately.

For every motion shot, render and inspect `t = 0`, `t = duration / 2`, and `t = duration`; open or sample the MP4 itself. Confirm the MP4 exists, is nonempty, matches the shot/pass identity, and is newer than the relevant scene change.

## Agent CLI primitives

Useful documented CLI commands when inspecting a live session:

- `npm run agent:capabilities` — boolean map; if `true`, do not inspect source for that operation.
- `npm run agent:inspect -- --document` — read-only project snapshot for preservation IDs.
- `npm run agent:open -- --file <package.fsp> --write` / `npm run agent:save -- --output <package.fsp> --write`.
- `npm run agent:plan-exports` — package plan that must be checked before rendering.
- `npm run agent:frame -- --shot <id> --mode clay --output <png>` — clean PNG and pixel stats.
- `npm run agent:verify` — idle/busy plus visual and health gates; not proof that a frame is visually ready.
- `npm run agent:cancel` / `npm run agent:operations` — stop or list CLI operations without killing Chromium.
- `npm run agent:world-preview -- --shots <ids> --output <request.json>` — emit backend-neutral semantic/camera priors without invoking external inference.
- `npm run agent:world-mock -- --shots <ids> --output <result.json>` — exercise the generative-world contract deterministically; mock output is schema evidence only.
- `npm run agent:world-depth -- --shot <id> --time <seconds> --resolution <WIDTHxHEIGHT> --output <depth.npy>` — render a clean-plate, top-left row-major NumPy float32 camera-Z prior in metres; zero means no geometry.

Wait for idle before starting another package, graybox, character-import, or video operation. Never overlap Agent writes. Parse stdout envelopes; do not scrape stderr for success.

## Rules

- Cast entries may use `type: "human_dummy"` or `type: "imported_character"`. Imported entries declare a local `source` and `rigMode` (for example `preserve-existing`); `agent:previs` resolves the source, analyzes it, imports it, and records the live object under `cast.<id>` before compiling shots. See [imported-characters.md](references/imported-characters.md).
- Use the closest supported location, camera, and pose templates. Do not invent coordinates before compilation; derive conservative relative changes from the inspected project.
- Let ForeScene repair numeric distance, headroom, recentering, OTS shoulder side, and related geometry only after the creative selection is correct. Numeric validation never overrides a visual failure.
- Never use `debug/*-ui.png` as production-frame evidence.
- Derive final claims from verified artifact and review records only. See [error-recovery.md](references/error-recovery.md) for the required honest summary.

## References

- [rapid-previs.md](references/rapid-previs.md)
- [production-integrity.md](references/production-integrity.md)
- [existing-project-refinement.md](references/existing-project-refinement.md)
- [deliverables.md](references/deliverables.md)
- [batch-review.md](references/batch-review.md)
- [visual-acceptance.md](references/visual-acceptance.md)
- [nonhumanoid-models.md](references/nonhumanoid-models.md)
- [production-manifest.md](references/production-manifest.md)
- [motion-authoring.md](references/motion-authoring.md)
- [shot-templates.md](references/shot-templates.md)
- [pose-presets.md](references/pose-presets.md)
- [imported-characters.md](references/imported-characters.md)
- [error-recovery.md](references/error-recovery.md)

## Examples

- [ai-control-full-export-plan.json](examples/ai-control-full-export-plan.json)
- [dialogue-motion.json](examples/dialogue-motion.json)
- [imported-character-workflow.md](examples/imported-character-workflow.md)
- [dialogue.json](examples/dialogue.json)
