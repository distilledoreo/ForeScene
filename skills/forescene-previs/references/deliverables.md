# Deliverables matrix and export planning

## Select a profile before rendering

Ask for the required output profile before rendering. If the request clearly requires AI control, multipass handoff, clean plates, character isolation, projected reference, or depth, state that `ai-control-full` is inferred. Do not silently render clay-only output.

| Profile | Use when | Required evidence |
| --- | --- | --- |
| `ai-control-full` | AI-video control or multipass handoff needs clean clay, projected, clean-plate, character-only, depth, reference frames, and camera-motion deliverables. | Export plan and package records show every applicable artifact kind as `produce`; visual reviews pass. |
| Custom constrained profile | The user explicitly narrows passes or the production does not require a listed pass. | Written requested-pass list, export-plan verification, and review records. |

## Built-in `ai-control-full` profile

Apply [ai-control-full-export-plan.json](../examples/ai-control-full-export-plan.json) through the Agent CLI:

```bash
npm run agent:apply -- \
  --plan skills/forescene-previs/examples/ai-control-full-export-plan.json \
  --write
```

It configures:

```json
{
  "peopleExportMode": "both",
  "characterPass": {
    "enabled": true,
    "includeStill": true,
    "includeMotion": true,
    "motionFormat": "both",
    "backgroundColor": "#00FF00",
    "includeAttachedProps": true
  },
  "includeViewport": true,
  "includeProjectedViewport": true,
  "includeProjectedCameraMoveReferenceFrames": true,
  "includeProjectedCameraMoveVideo": true,
  "includeCameraMoveVideo": true,
  "includeCameraMoveReferenceFrames": true,
  "depth": {
    "enabled": true,
    "includeViewportStill": true,
    "includeReferenceFrames": true,
    "includeCameraMoveVideo": true,
    "rangeMode": "auto",
    "invert": false
  }
}
```

`peopleExportMode: "both"` requires with-people and clean-plate variants. The character pass requires a still, green-screen MP4, and transparent PNG sequence when the shot has a renderable camera move; attached props stay with the character.

## Plan gate

After applying the profile and before rendering, run `npm run agent:plan-exports` for the selected shot IDs. Record the returned plan or a derived `artifacts/previs/preflight/deliverables-plan.json` containing its revision/time, selected shots, required kinds, omissions, and blocking decision.

For every selected shot, verify these artifact kinds as applicable to the shot:

| Requirement | Expected planned kinds |
| --- | --- |
| Clay / people variants | `clay-viewport` |
| Projected / people variants | `projected-viewport` |
| Depth / people variants | `depth-viewport` |
| Character-only still | `character-still` |
| Motion-required clay | `clay-camera-move`, `clay-reference-frames` |
| Motion-required projected | `projected-camera-move`, `projected-reference-frames` |
| Motion-required depth | `depth-camera-move`, `depth-reference-frames` |
| Character motion | `character-motion`, `character-sequence`, `character-metadata` |

The plan must report `disposition: "produce"` for each required kind. A static shot does not require camera-move artifacts, but the record must say why. Do not infer that a default setting produced a pass; inspect the actual plan.

## Blocking rules

- A required projected artifact omitted with `missing-projector` is a blocking failure. Repair or import a usable styled panorama/projector, rerun the plan, and confirm the artifact now produces.
- A required artifact omitted for `missing-camera-move`, missing panorama asset, missing character output, or any other cause is also a failed deliverable until the requirement is removed explicitly by the user.
- `validation.json`, an estimated file count, and an artifact filename cannot substitute for the planned kind, completed file, and passed visual review.

Only after this gate passes may the agent run `agent:package`; afterward verify the output files against the same planned artifact kinds.
