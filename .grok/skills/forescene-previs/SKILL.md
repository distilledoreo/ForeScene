---
name: forescene-previs
description: Turn a screenplay or shot list into an editable ForeScene previs project with clean clay frames, optional motion-control videos, composition validation, and production handoff packages. Use for autonomous still or motion previs without editing ForeScene source.
---

# ForeScene Previs Skill

## When to use

Use this skill when the user wants Grok Build to drive the **hosted ForeScene app** from a screenplay, production brief, or shot list. It covers:

- Still-frame previs and graybox storyboards.
- Motion previs and camera-path visualization.
- Blocking, pose, and pose-continuity guidance.
- Control-video generation for meaningful temporal changes.
- Imported-character setup when the user supplies character files.

The output is an editable ForeScene graybox project and a validated still-and-motion handoff package. ForeScene control videos communicate camera, timing, blocking, and silhouette intent; they are not final AI video and do not replace performance animation.

## Operating vs developing

**Operating ForeScene** (this skill): manipulate a live project through the Agent CLI and hosted app. Do **not** edit application source code.

**Developing ForeScene**: edit application source only when the user explicitly asks to change the app itself. Imported-character manifest binding is supported by the production manifest workflow described below.

## Shot-intent classification

Before creating the manifest, assign every shot exactly one intent class:

| Class | Use when | Deliverable |
| --- | --- | --- |
| `still` | Composition or continuity is the purpose, with no material camera or subject movement. | One clean control frame. |
| `motion-required` | A dolly, pan, crane, orbit, meaningful crossing, blocking change, entrance, exit, reveal, transformation, or materially different final frame carries the intent. | Start, midpoint, endpoint samples and a control video. |
| `motion-optional` | Minor drift would help, but one frame communicates the shot adequately. | Still by default; add a video only when it adds useful temporal information. |
| `unsupported-performance` | Facial acting, lip sync, hand contact, precise prop interaction, complex locomotion, physics, cloth, or collisions drive the shot. | Coarse motion previs labeled as timing/blocking guidance, not final performance animation. |

Do not generate videos indiscriminately. Use `renderControlVideo: true` only for shots whose temporal information is useful. Every shot must retain its classification in the working notes or run summary even though the manifest itself only carries the resulting still/motion choice.

## Primary workflow

1. Read the complete screenplay or shot list.
2. Extract locations, cast, props, continuity constraints, and exact shot numbering.
3. Classify every shot as `still`, `motion-required`, `motion-optional`, or `unsupported-performance`.
4. Create the base `PrevisProductionManifestV1` using supported semantic templates.
5. Add `shots[].motion` only where temporal communication is necessary; its `durationSeconds` and `keyframes` must follow [motion-authoring.md](references/motion-authoring.md).
6. Validate the manifest before changing the hosted project.
7. Run initial orchestration:

```bash
npm run agent:previs -- \
  --manifest path/to/manifest.json \
  --url https://ForeScene.distilledlabs.org \
  --write \
  --reset-project \
  --output artifacts/previs
```

8. Inspect `validation.json`, composition telemetry, clean still frames, and requested MP4s.
9. Let ForeScene repair numeric framing problems. Change the manifest only when creative intent is wrong.
10. Re-run changed shots with `--update-manifest` and without `--reset-project` for shot-only edits.
11. Verify still and motion deliverables, including the three temporal samples for every motion shot.
12. Export the package and present the contact sheet, videos, validation, and summary.

For location, cast, or prop changes, use `--update-manifest --reset-project` so the scene rebuilds without duplicate creates. Do not reset merely to repair a shot.

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

Use `agent:frame` for clean clay samples and `agent:video` for a direct shot render. `agent:previs` is the normal end-to-end manifest workflow.

## Artifact layout and validation

```text
artifacts/previs/
├── shots/
│   ├── 010.png                 # Clean clay render, not a UI screenshot
│   ├── 010.composition.json    # Screen-space composition telemetry
│   ├── 010.mp4                 # Required when shots[...].motion.renderControlVideo is true
│   └── ...
├── debug/
│   ├── 010-ui.png              # Optional full-app debugging screenshot
│   └── ...
├── contact-sheet.png
├── contact-sheet.html
├── package.zip
├── validation.json
├── summary.json
└── run-state.json
```

For every motion shot, verify all of the following:

- The MP4 exists when `renderControlVideo` is true and is associated with the correct shot.
- Its duration approximately matches `durationSeconds`.
- Start and final framing/blocking match intent; movement is continuous rather than jumping.
- Required subjects remain visible where expected.
- A changed motion manifest does not leave a stale MP4 in place.

### Review three temporal samples

A motion shot is not complete until its start, midpoint, endpoint, and video artifact have been checked. Render the samples from the clean renderer:

```bash
npm run agent:frame -- \
  --shot <shot-id> \
  --time <seconds> \
  --output <path>
```

Inspect `t = 0`, `t = duration / 2`, and `t = duration`. Do not approve a motion shot from the MP4 filename alone.

Still frames remain:

```text
artifacts/previs/shots/010.png
artifacts/previs/shots/010.composition.json
```

`shots/*.png` must come from the canonical clean clay renderer (`window.foreScene.renderShotFrame`), not a UI screenshot. `debug/*-ui.png` is for human debugging only. Prefer `validation.json` and composition telemetry for geometric judgment, then use the contact sheet for story readability.

## How to judge frames

Trust deterministic metrics for framing:

- `framing_too_loose` / `framing_too_tight`
- `headroom_excessive` / `head_clipped`
- `unwanted_subject_dominant`
- `ots_foreground_*` / `ots_primary_obstructed`
- `subject_occluded` / `wall_dominant`
- `frame_blank` / `render_not_ready`

Change the manifest only when the template, subject selection, location, blocking, or motion intent is wrong. Let ForeScene repair distance, headroom, recentering, OTS shoulder side, and other numeric framing problems. Do not use motion to repair a poorly selected camera template.

## Agent browser APIs

Useful when inspecting a live session:

- `window.foreScene.renderShotFrame({ shotId, timeSeconds, pass: 'clay' })` — clean clay PNG data URL and pixel stats.
- `window.foreScene.waitForViewportReady({ workspace: 'shots', shotId })` — stable visual readiness, not just idle.
- `window.foreScene.waitForIdle()` — busy flags only; not proof that the viewport is visually ready.

Wait for idle before starting another package, graybox, character-import, or video operation. Never overlap Agent writes.

## Rules

- Cast entries may use `type: "human_dummy"` or `type: "imported_character"`. Imported entries declare a local `source` and `rigMode` (for example `preserve-existing`); `agent:previs` resolves the source, analyzes it, imports it, and records the live object under `cast.<id>` before compiling shots. See [imported-characters.md](references/imported-characters.md) for the schema and recovery rules.
- Use the closest supported location, camera, and pose templates.
- Do not invent coordinates before compilation. Let ForeScene compile the initial shot, inspect the compiled project or sample timeline, derive world-space motion from existing camera and subject transforms, and then apply conservative relative changes.
- Do not silently skip shots. Unsupported performance should still receive coarse timing/blocking guidance and a clear limitation label.
- Quality target: coherent editable graybox previs, not polished cinematic previs or final AI video.
- A human should identify wide two-shot, medium, OTS, and close-up from the frames without reading labels.
- Never use `debug/*-ui.png` as production-frame evidence.

## References

- [production-manifest.md](references/production-manifest.md)
- [motion-authoring.md](references/motion-authoring.md)
- [shot-templates.md](references/shot-templates.md)
- [pose-presets.md](references/pose-presets.md)
- [imported-characters.md](references/imported-characters.md)
- [error-recovery.md](references/error-recovery.md)

## Examples

- [dialogue-motion.json](examples/dialogue-motion.json)
- [imported-character-workflow.md](examples/imported-character-workflow.md)
- [dialogue.json](examples/dialogue.json)
- [music-video.json](examples/music-video.json)
