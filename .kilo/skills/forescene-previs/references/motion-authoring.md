# Motion authoring

`PrevisShotDefinition.motion` is the native temporal authoring path in `PrevisProductionManifestV1`. It is for camera, timing, blocking, visibility, transforms, and coarse pose intent. It is not a final animation system.

## Shape

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

Supported fields are:

- `durationSeconds`: positive shot duration.
- `renderControlVideo`: optional boolean that requests `artifacts/previs/shots/<shot-number>.mp4` during orchestration. The filename uses the manifest shot number, not the manifest shot ID.
- `keyframes`: at least two entries with strictly increasing `timeSeconds`.
- `camera`: optional `position`, `target`, and `fovDegrees`.
- `staging`: optional subject overrides for `visible`, `transform.position`, `transform.rotation`, `transform.scale`, and `posePreset`.

## Authoring rules

- Start normally at `timeSeconds: 0`.
- End exactly at `durationSeconds`.
- Use as few keyframes as necessary.
- Keep movement semantically meaningful and continuous.
- Choose and validate the camera template before authoring movement.
- Use `renderControlVideo: true` only when temporal information is important.
- Do not approximate nuanced acting with excessive pose keyframes.
- Treat `walking` and `running` as silhouette/state guidance, not complete locomotion.

## Coordinates

The existing compiler owns initial geometry and framing. Do not invent coordinates before compilation. Use this sequence:

1. Let ForeScene compile the initial shot from semantic location, blocking, and camera templates.
2. Inspect the compiled project or sample the shot timeline.
3. Derive motion coordinates from the existing camera and subject transforms.
4. Apply relative, conservative changes.
5. Re-render and inspect temporal samples before adding more keyframes.

This permits the world-space camera and transform values the motion API exposes without asking the agent to invent an entire coordinate system up front.

## Review

For each motion shot, render and inspect `t = 0`, `t = duration / 2`, and `t = duration` with `agent:frame`. Check framing, continuity, subject visibility, blocking, and whether the MP4 duration approximately matches the manifest. A control video is timing/blocking guidance for unsupported performance shots, not evidence of finished acting.
