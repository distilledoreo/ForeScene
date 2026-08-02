---
name: forescene-previs
description: Operate a ForeScene project as greenfield previs, project-preserving asset refinement, or verified export-only delivery. Use for autonomous still or motion previs without editing ForeScene source.
---

# ForeScene Previs Skill

## When to use

Use this skill when the user wants Grok Build to drive the **hosted ForeScene app** from a screenplay, production brief, shot list, or approved project. It covers:

- Still-frame previs and graybox storyboards.
- Motion previs and camera-path visualization.
- Blocking, pose, and pose-continuity guidance.
- Imported-character setup when the user supplies character files.
- Project-preserving production-asset refinement and verified package delivery.

The output is an editable ForeScene project and an evidence-backed handoff package. ForeScene control videos communicate camera, timing, blocking, and silhouette intent; they are not final AI video and do not replace performance animation.

## Operating vs developing

**Operating ForeScene** (this skill): manipulate a live project through the Agent CLI and hosted app. Do **not** edit application source code.

**Developing ForeScene**: edit application source only when the user explicitly asks to change the app itself. This skill does not add Agent API capabilities; use the current documented API and commands.

## Operating mode is a required first decision

Before any write, inspect the live project and select one operating mode. Record the choice in the preservation preflight or export record.

| Mode | Use only when | Reset policy |
| --- | --- | --- |
| **Greenfield** | No useful ForeScene project exists, the user explicitly requests a rebuild, or all existing geometry, panoramas, shots, and staging are disposable. | `agent:previs --reset-project` is allowed only with explicit write authorization. |
| **Existing-project refinement** | The project has useful geometry, projected textures or panoramas, shot cameras, blocking, or continuity work. This is the default whenever useful work already exists. | Never reset by default. Inspect and preserve the project; import/replace assets incrementally, repair small shot batches, and rerender only affected shots. |
| **Export-only** | The project is visually approved and the task is only to apply an export profile, render passes, package, and verify delivery. | Do not modify scene, shots, cameras, staging, or timelines. |

**Hard rule:** if the inspected project contains any shots or panoramas and the user has not explicitly asked for reconstruction, `--reset-project` and `resetProject` are prohibited. A changed manifest, a request for new cast/props, or a desire for cleaner clay output is not reconstruction authorization. Use [existing-project-refinement.md](references/existing-project-refinement.md) instead.

## Preservation preflight

For existing-project refinement, complete the required preflight **before any write**:

1. Run `npm run agent:inspect` and read `window.foreScene.getProjectDocument()` in the connected session.
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

4. Work in gated 3–5-shot batches, not as one unattended run. Inspect and repair each batch before continuing.
5. Configure and verify the output profile before package rendering, then validate every requested artifact and review record.

## Existing-project refinement workflow

Use this for any live project with valuable work:

1. Complete the preservation preflight; retain the original document snapshot and all required IDs.
2. Determine the affected shots and whether the request is Stage B asset refinement or export-only. Do not create replacement locations/shots for work that already exists.
3. Import one saved-rig character variant or real nonhumanoid model at a time. Use a read-only analysis first and an explicit write only for the import.
4. Map the imported asset to the affected existing shot IDs. Apply staging, camera, or timeline repairs through small Agent plans; preview the plan before applying it.
5. Replace each nonhumanoid proxy using [nonhumanoid-models.md](references/nonhumanoid-models.md), retaining a nonzero refinement log and before/after review evidence.
6. Process 3–5 shots at a time under [batch-review.md](references/batch-review.md). A failed shot blocks the next batch.
7. Rerender only affected outputs, verify their timestamps/revision against the latest scene change, then run the final preservation check.

Never add `--reset-project` to this workflow without the user’s explicit reconstruction authorization and a new preflight that records `resetAuthorized: true`.

For a resumable manifest-backed shot-only correction, use `--update-manifest` without `--reset-project`; it invalidates the affected output while retaining the project.

## Export profiles and package planning

Before any render, ask for the required output profile or infer it from the request and state the inference. **Never silently default to clay-only.** Use the built-in recommended `ai-control-full` profile when the task requires AI-control, multipass, clean-plate, character-only, projected, or depth deliverables. Its exact Agent plan is [ai-control-full-export-plan.json](examples/ai-control-full-export-plan.json).

1. Apply the profile through `agent:apply -- --plan <path> --write`.
2. Call `window.foreScene.createExportPlan()` afterward.
3. Confirm every required artifact kind is planned with `disposition: "produce"`; required projected artifacts omitted with `missing-projector` are a blocking failure, not a warning to ignore.
4. For a motion-required shot, verify the clay/projected/depth camera-move and reference-frame artifacts expected by the selected profile. For a still, explicitly record that motion artifacts are not required.
5. Only then run `agent:package` and verify the resulting files.

See [deliverables.md](references/deliverables.md) for the output matrix, expected artifact kinds, and the blocking projection rule.

## Batch review and visual acceptance

Use a default batch size of **3–5 shots**. Render review frames, inspect every frame, write a batch review, repair failures, and only then continue. A successful command or `validation.json` does not authorize the next batch. Use [batch-review.md](references/batch-review.md).

Visual QA is authoritative: compare the final frame with the shot description, make sure the intended subjects/framing/scene elements/replacement assets are present, and open or sample every MP4. Empty rooms, irrelevant fragments, and proxies standing in for final assets fail automatically. If visual evidence conflicts with `validation.json`, mark the shot failed. Full criteria: [visual-acceptance.md](references/visual-acceptance.md).

## Command inventory

These commands are available in the ForeScene checkout:

```bash
npm run agent:inspect
npm run agent:analyze-character
npm run agent:import-character
npm run agent:preview
npm run agent:apply
npm run agent:screenshot
npm run agent:frame
npm run agent:video
npm run agent:verify
npm run agent:run
npm run agent:previs
npm run agent:render-stills
npm run agent:contact-sheet
npm run agent:package
```

Use `agent:frame` for clean clay samples and `agent:video` for a direct shot render. `agent:previs` is a Greenfield manifest orchestration command; it is not the default replacement path for an existing project.

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
├── package.zip
├── validation.json
├── summary.json
└── run-state.json
```

`shots/*.png` must come from the canonical clean clay renderer (`window.foreScene.renderShotFrame`), not a UI screenshot. `debug/*-ui.png` is for human debugging only. A contact sheet is required for readable review but cannot replace opening suspicious individual frames.

For every motion shot, render and inspect `t = 0`, `t = duration / 2`, and `t = duration`; open or sample the MP4 itself. Confirm the MP4 exists, is nonempty, matches the shot/pass identity, and is newer than the relevant scene change.

## Agent browser APIs

Useful when inspecting a live session:

- `window.foreScene.getProjectDocument()` — read-only full project snapshot for preservation IDs.
- `window.foreScene.createExportPlan({ shotIds? })` — package plan that must be checked before rendering.
- `window.foreScene.renderShotFrame({ shotId, timeSeconds, pass: 'clay' })` — clean clay PNG data URL and pixel stats.
- `window.foreScene.waitForViewportReady({ workspace: 'shots', shotId })` — stable visual readiness, not just idle.
- `window.foreScene.waitForIdle()` — busy flags only; not proof that the viewport is visually ready.

Wait for idle before starting another package, graybox, character-import, or video operation. Never overlap Agent writes.

## Rules

- Cast entries may use `type: "human_dummy"` or `type: "imported_character"`. Imported entries declare a local `source` and `rigMode` (for example `preserve-existing`); `agent:previs` resolves the source, analyzes it, imports it, and records the live object under `cast.<id>` before compiling shots. See [imported-characters.md](references/imported-characters.md).
- Use the closest supported location, camera, and pose templates. Do not invent coordinates before compilation; derive conservative relative changes from the inspected project.
- Let ForeScene repair numeric distance, headroom, recentering, OTS shoulder side, and related geometry only after the creative selection is correct. Numeric validation never overrides a visual failure.
- Never use `debug/*-ui.png` as production-frame evidence.
- Derive final claims from verified artifact and review records only. See [error-recovery.md](references/error-recovery.md) for the required honest summary.

## References

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
