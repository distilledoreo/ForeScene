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
