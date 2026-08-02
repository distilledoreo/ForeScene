# Production manifest

See also `docs/previs-production-manifest.md` and `src/engine/previs/manifest.ts` in the ForeScene checkout.

Required top-level fields:

- `version: 1`
- `project.name`, `project.aspectRatio`
- `locations[]` with `id`, `name`, `template`
- `cast[]` with `id`, `name`, and `type: "human_dummy"`
- `shots[]` with exact `shotNumber`, `name`, `description`, `locationId`, `subjects`, and `camera`

Optional top-level fields are `project.description`, `project.frameRate`, and `props[]`. Optional shot fields are `blocking`, `requirements`, and `motion`.

## Current cast boundary

`PrevisProductionManifestV1.cast` currently accepts only `type: "human_dummy"`. Imported-rig characters are accessible through the Agent API, but they are not direct manifest cast entries. Follow [imported-characters.md](imported-characters.md) for the accurate two-stage workflow.

## Supported enum values

Location templates: `empty_stage`, `interior_room`, `corridor`, `ruins`, `armory`, `exterior_courtyard`, `custom_blueprint`.

Camera templates: `establishing`, `wide`, `full`, `medium`, `medium_close_up`, `close_up`, `extreme_close_up`, `two_shot`, `over_the_shoulder`, `insert`, `profile`, `low_angle`, `high_angle`, `overhead`.

Camera angles: `front`, `three_quarter`, `profile`, `rear`.

Lens classes: `wide`, `normal`, `long`.

Location slots: `center`, `left`, `right`, `foreground`, `background`, `entrance`, `exit`.

Relative relations: `left_of`, `right_of`, `in_front_of`, `behind`, `beside`, `across_from`, `near`, `far_from`, `between`, `just_inside`, `just_outside`.

Do not use `custom_blueprint` unless the current product path explicitly supports it for the run; primitive-template locations are the safer default.

## Optional shot motion

Use `shots[].motion` for temporal intent:

```json
{
  "motion": {
    "durationSeconds": 4,
    "renderControlVideo": true,
    "keyframes": [
      {
        "timeSeconds": 0,
        "camera": {
          "position": [0, 2, 6],
          "target": [0, 1, 0]
        }
      },
      {
        "timeSeconds": 4,
        "camera": {
          "position": [2, 2, 4],
          "target": [0, 1, 0]
        },
        "staging": [
          {
            "subject": "alex",
            "transform": { "position": [1, 0, 0] },
            "posePreset": "walking"
          }
        ]
      }
    ]
  }
}
```

Motion supports `durationSeconds`, optional `renderControlVideo`, and `keyframes`. A keyframe may contain camera `position`, `target`, and `fovDegrees`, plus `staging` entries with `subject`, `visible`, `transform.position`, `transform.rotation`, `transform.scale`, and `posePreset`.

Keyframe constraints:

- At least two keyframes.
- `timeSeconds` values strictly increase.
- The first keyframe should normally start at `0`.
- The final keyframe time must equal `durationSeconds`.
- Use as few keyframes as necessary and keep movement semantically meaningful.
- `renderControlVideo: true` is for temporal information, not every shot.

See [motion-authoring.md](motion-authoring.md) for coordinate derivation and temporal review.
