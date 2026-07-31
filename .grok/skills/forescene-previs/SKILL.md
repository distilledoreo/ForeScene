---
name: forescene-previs
description: Turn a shot list into a graybox ForeScene project with clay first frames via the hosted app and agent:previs CLI. Use when the user asks for autonomous previs, shot-list-to-first-frames, or graybox storyboard generation without editing ForeScene source.
---

# ForeScene Previs Skill

## When to use

The user wants Grok Build to drive the **hosted ForeScene app** from a shot list:

> Use the ForeScene previs skill. Start a new graybox project from this shot list…

## Operating vs developing

**Operating ForeScene** (this skill): manipulate a live project through Agent CLI.
Do **not** edit application source code.

Use:

- `npm run agent:inspect`
- `npm run agent:previs`
- `npm run agent:preview`
- `npm run agent:apply`
- `npm run agent:render-stills`
- `npm run agent:contact-sheet`
- `npm run agent:package`

**Developing ForeScene**: only when the user asks to change the app itself.

## Workflow

1. Read the complete shot list.
2. Extract named locations, cast, and simple props.
3. Preserve exact shot numbering and descriptions.
4. Convert every shot into `PrevisShotDefinition` using only supported templates.
5. Write a `PrevisProductionManifestV1` JSON file.
6. Validate by running `agent:previs` (invalid manifests print actionable diagnostics).
7. Run full orchestration:

```bash
npm run agent:previs -- \
  --manifest path/to/manifest.json \
  --url https://forescene.app \
  --write \
  --reset-project \
  --output artifacts/previs
```

8. Inspect outputs (see **How to judge frames** below).
9. Revise only failed or warned shots in the manifest when the **shot intent** is wrong.
10. Re-run with `--update-manifest` (and **without** `--reset-project`) so unchanged shots stay complete.
11. Confirm every shot has a **clean** PNG under `artifacts/previs/shots/`.
12. Present the contact sheet and `summary.json`.

## Artifact layout

```
artifacts/previs/
├── shots/
│   ├── 010.png                 # Clean clay render (NOT a UI screenshot)
│   ├── 010.composition.json    # Screen-space composition telemetry
│   └── ...
├── debug/
│   ├── 010-ui.png              # Optional full-app UI screenshot
│   └── ...
├── contact-sheet.png
├── contact-sheet.html
├── package.zip
├── validation.json
├── summary.json
└── run-state.json
```

- **`shots/*.png`** must come from the canonical clean clay renderer (`window.foreScene.renderShotFrame` → same path as package `inputs/viewport_clay.png`).
- **`debug/*-ui.png`** is for human debugging only. Never treat it as a production frame.
- **`shots/*.composition.json`** is the authoritative geometric read of what the camera sees.

## How to judge frames

### Prefer in this order

1. **`validation.json`** — structured issues with codes, expected bands, and measured values.
2. **`shots/*.composition.json`** — projected bounds, body landmarks, occlusion, blockers.
3. **`contact-sheet.png`** — storytelling / overall readability.
4. Never approve a shot merely because a PNG exists.

### Trust deterministic metrics for framing

- `framing_too_loose` / `framing_too_tight` — crop wrong for template
- `headroom_excessive` / `head_clipped`
- `unwanted_subject_dominant`
- `ots_foreground_*` / `ots_primary_obstructed`
- `subject_occluded` / `wall_dominant`
- `frame_blank` / `render_not_ready`

### Use the contact sheet for storytelling

- Emotional order, variety, and whether the sequence “reads”
- Not for pixel-perfect framing math

### When to change the manifest

Change the **manifest** only when shot intent is wrong (wrong template, wrong subjects, wrong location, wrong blocking).

Allow ForeScene’s **repair system** to handle numerical camera adjustments (distance, headroom, OTS shoulder side). Do not hand-author world-space camera coordinates.

### Never

- Approve a shot only because `shots/0XX.png` exists
- Use `debug/*-ui.png` as evidence of framing quality
- Invent world coordinates for cameras or characters

## Agent browser APIs (read)

Useful when inspecting a live session:

- `window.foreScene.renderShotFrame({ shotId, pass: 'clay' })` — clean clay PNG data URL + pixel stats
- `window.foreScene.waitForViewportReady({ workspace: 'shots', shotId })` — stable readiness (not just idle)
- `window.foreScene.waitForIdle()` — busy flags only; **not** proof the viewport is visually ready

## Rules

- Use generic `human_dummy` cast and primitive props only.
- Use the closest supported location / camera / pose templates.
- Do not invent world coordinates — the ForeScene compiler owns geometry.
- Do not silently skip shots; unsupported shots must appear in validation with a reason.
- Quality target: coherent editable graybox first pass — not polished cinematic previs.
- A human should identify wide two-shot, medium, OTS, and close-up from the frames without reading labels.

## References

- [production-manifest.md](references/production-manifest.md)
- [shot-templates.md](references/shot-templates.md)
- [pose-presets.md](references/pose-presets.md)
- [error-recovery.md](references/error-recovery.md)

## Examples

- [dialogue.json](examples/dialogue.json)
- [music-video.json](examples/music-video.json)
