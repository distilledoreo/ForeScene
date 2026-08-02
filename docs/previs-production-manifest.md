# Previs Production Manifest

Versioned semantic input for autonomous graybox previs.

Grok Build makes **semantic** decisions (locations, cast, shot size, blocking).
ForeScene compiles those decisions into geometry and Agent API plans.

```
shotlist.md
  → PrevisProductionManifestV1
  → ForeScene deterministic compiler
  → Existing Agent API plans (preview / apply / undo)
  → Clay first-frame PNGs + contact sheet
```

## Schema

`version` must be `1`.

```ts
interface PrevisProductionManifestV1 {
  version: 1;
  project: {
    name: string;
    description?: string;
    aspectRatio: '16:9' | '9:16' | '1:1' | '2.39:1';
    frameRate?: number;
  };
  locations: PrevisLocationDefinition[];
  cast: PrevisCharacterDefinition[];
  props?: PrevisPropDefinition[];
  shots: PrevisShotDefinition[];
}
```

Cast entries may be built-in semantic mannequins or imported characters. An
imported character source is resolved relative to the manifest file, analyzed,
and imported through the existing Agent character-import path during the same
`agent:previs` cast phase. The normalized cast ID is then used by every shot,
so no second staging command or manual object-ID lookup is required.

```json
{
  "id": "joseph",
  "type": "imported_character",
  "source": "./characters/joseph.glb",
  "rigMode": "preserve-existing"
}
```

`name` is optional for imported entries and defaults to the cast ID. Supported
`rigMode` values are `preserve-existing`, `auto`, and `autorig`. `source` must
be a local GLB, embedded glTF, or FBX file. A missing source or failed rig
analysis stops the cast phase without advancing shot compilation; successful
imports are retained in `run-state.json` under `cast.<id>` for retry recovery.

Shots may include optional temporal authoring. It is compiled into the same
Agent timeline commands used by direct automation, so it participates in plan
preview, atomic apply, undo, and controlled invalidation of stale video assets:

```json
{
  "motion": {
    "durationSeconds": 4,
    "renderControlVideo": true,
    "keyframes": [
      { "timeSeconds": 0, "camera": { "position": [0, 2, 6], "target": [0, 1, 0] } },
      { "timeSeconds": 4, "camera": { "position": [2, 2, 4], "target": [0, 1, 0] },
        "staging": [{ "subject": "alex", "transform": { "position": [1, 0, 0] } }] }
    ]
  }
}
```

Motion requires at least two strictly increasing keyframes, with the final
keyframe time equal to `durationSeconds`. When `renderControlVideo` is `true`,
`agent:previs` performs a deterministic 1080p clay camera-move render after
the shot is compiled, attaches it to the shot, and saves the MP4 under the
run output's `shots/` directory. The render is skipped when that artifact is
already present in resumable run-state.

See `src/engine/previs/manifest.ts` for the full TypeScript contract.

## Location templates

Built-in templates (MVP):

| Template | Use |
|----------|-----|
| `empty_stage` | Neutral open stage |
| `interior_room` | Simple dialogue room |
| `corridor` | Narrow hall |
| `ruins` | Roman ruins courtyard |
| `armory` | Armory interior |
| `exterior_courtyard` | Open courtyard |
| `custom_blueprint` | Reserved — rejected in MVP |

Each location is placed in a separate zone origin: `[index * 100, 0, 0]`.
Templates generate named anchors (`center`, `entrance`, `exit`, …).

## Pose presets

Accepted semantic poses:

`standing-neutral`, `standing-alert`, `standing-defensive`, `walking`, `running`,
`kneeling`, `seated`, `reaching`, `holding-object`, `shield-ready`, `sword-ready`, `injured`

## Camera templates

`establishing`, `wide`, `full`, `medium`, `medium_close_up`, `close_up`,
`extreme_close_up`, `two_shot`, `over_the_shoulder`, `insert`, `profile`,
`low_angle`, `high_angle`, `overhead`

- `two_shot` requires ≥2 `camera.subjects`
- `over_the_shoulder` requires `camera.foregroundSubject`

Shot numbers from the manifest are preserved exactly (`shotNumber` / `productionShotId`).

## CLI

```bash
# Initialize / reset only
npm run agent:previs -- \
  --manifest examples/previs/minimal-dialogue.json \
  --url http://127.0.0.1:3000 \
  --write \
  --reset-project \
  --initialize-only \
  --output artifacts/previs

# Full orchestration
npm run agent:previs -- \
  --manifest examples/previs/music-video-graybox.json \
  --url https://forescene.app \
  --write \
  --reset-project \
  --output artifacts/previs
```

Safety:

- `--write` alone does **not** authorize project replacement
- `--reset-project` must be passed together with `--write`
- Manifest hash is stored in `run-state.json`; resume refuses a silently changed manifest
- Pass `--update-manifest` to accept a changed manifest and invalidate only affected shots (and dependents). Shot-only edits resume without `--reset-project`; location/cast/prop edits also need `--reset-project`
- `--profile` selects a persistent Playwright user-data directory
- Unless `--skip-package` is set, a failed package phase makes the run `ok: false`

Live Chromium coverage: `npm run test:e2e:previs` (tagged `@heavy`).

## Output layout

```
artifacts/previs/
├── manifest.normalized.json
├── run-state.json
├── validation.json
├── summary.json
├── contact-sheet.png
├── package.zip
├── logs/
└── shots/
    ├── 010.png
    └── …
```

## Examples

- `examples/previs/minimal-dialogue.json` — 1 location, 2 cast, 4 shots
- `examples/previs/music-video-graybox.json` — 2 locations, 3 cast, 8 shots
