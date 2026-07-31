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

8. Inspect `artifacts/previs/validation.json`.
9. Revise only failed or warned shots in the manifest.
10. Re-run with `--update-manifest` (and **without** `--reset-project`) so unchanged shots stay complete.
11. Confirm every shot has a PNG under `artifacts/previs/shots/`.
12. Present the contact sheet and `summary.json`.

## Rules

- Use generic `human_dummy` cast and primitive props only.
- Use the closest supported location / camera / pose templates.
- Do not invent world coordinates — the ForeScene compiler owns geometry.
- Do not silently skip shots; unsupported shots must appear in validation with a reason.
- Quality target: coherent editable graybox first pass — not polished cinematic previs.

## References

- [production-manifest.md](references/production-manifest.md)
- [shot-templates.md](references/shot-templates.md)
- [pose-presets.md](references/pose-presets.md)
- [error-recovery.md](references/error-recovery.md)

## Examples

- [dialogue.json](examples/dialogue.json)
- [music-video.json](examples/music-video.json)
