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

`version` must be `1` or `2`. Version 2 adds first-class `assets` and allows
an empty `cast` when those assets supply the subjects.

```ts
interface PrevisProductionManifestV1 {
  version: 1 | 2;
  project: {
    name: string;
    description?: string;
    aspectRatio: '16:9' | '9:16' | '1:1' | '2.39:1';
    frameRate?: number;
    operatingMode?: 'greenfield' | 'existing-project-refinement';
  };
  locations: PrevisLocationDefinition[];
  cast: PrevisCharacterDefinition[];
  props?: PrevisPropDefinition[];
  assets?: PrevisAssetDefinition[];
  shots: PrevisShotDefinition[];
}
```

`semanticRole` (`subject` | `prop` | `character`) is not an implementation
type. A nonhumanoid GLB with `type: "imported_model"` and
`semanticRole: "subject"` stays an ordinary imported model. Preflight checks
source existence and hash, and rejects a missing rig only for assets declared
as characters. During `agent:previs`, required ordinary model assets are
imported, recorded under their manifest IDs in resumable run state, and staged
as shot subjects or props without entering the character-analysis or rigging
path. The project binding is also persisted when the connected ForeScene build
supports version-2 asset IDs. In `existing-project-refinement` mode, locations
are resolved from `<location-id>_*` landmarks and existing set objects; missing
location bindings fail closed before scene mutation. Benchmark prepare
writes this generated manifest so the candidate does not translate schemas.

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
`rigMode` values are `preserve-existing`, `auto`, `autorig`, and `saved-rig`.
`source` must be a local GLB, embedded glTF, or FBX file. A missing source or
failed rig analysis stops the cast phase without advancing shot compilation;
successful imports are retained in `run-state.json` under `cast.<id>` for retry
recovery.

Use `saved-rig` when the source model and its matching ForeScene rig package
must be imported as one cast entry:

```json
{
  "id": "joseph",
  "type": "imported_character",
  "source": "./characters/joseph.glb",
  "rigMode": "saved-rig",
  "rigPackage": "./characters/joseph.fsrig",
  "height": 1.8
}
```

`rigPackage` is required only for `saved-rig` and must be an explicit local
`.fsrig` or legacy `.panorig` path relative to the manifest. The package and
source are preflighted read-only before an authorized project reset; topology,
vertex-count, skin/bind, and preserved-skeleton mismatches stop the run before
reset or shot compilation. The package is then applied through the same shared
import path used by the Build tray, with package assets cleaned up on failure.
Changing either file or the import options changes the cast fingerprint. Resume
reuses a cast mapping only when that fingerprint still matches; otherwise run
with `--update-manifest --reset-project` to rebuild the cast-dependent scene.
Heavy or extreme character imports are refused unless the run explicitly opts
in with `--allow-heavy-character-imports`; the flag supplies the same non-empty
consent token used by the direct Agent import API.

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

Prepared production projects may persist typed bindings and shot contracts under
`workflow.production` (project schema `1.2`). A contract can bind an entity to
an object or complete object group, require pose/deformation capabilities, and
record an exact dynamic-presence set before compilation. Use the browser Agent
API to inspect and validate these gates:

```ts
window.foreScene.inspectEntityCapability({ entityId: 'lead' });
window.foreScene.validateProductionCapabilities({ manifest });
window.foreScene.resolveProductionPose({
  entityId: 'lead',
  requestedPose: 'running',
  shotId: 'shot-001',
});
```

Native presets resolve as `exact`. Semantic fallbacks such as `running` → a
single walking-contact pose are reported as `approximate` and require review;
they are not treated as production-approved substitutions until an explicit
`approvePoseSubstitution` record is persisted. A rig marked `requiresRerigging`
or missing required joints blocks pose-dependent shots, while static geometry
may still satisfy a static-only contract.

Environment contracts route a shot to a prepared location panorama. The
location must name `defaultPanoId` or `panoIds`; the compiler emits an
executable `shot.setPanorama` command and verification compares the resulting
shot link against the expected ID:

```ts
window.foreScene.inspectShotEnvironmentContract({ shotId: 'shot-001' });
window.foreScene.verifyShotPanorama({ shotId: 'shot-001' });
```

When `requireProjection` is enabled, projected approval uses a WebGL coverage
debug pass. `inspectProjectionHealth` reports projected-material count,
panorama coverage, fallback ratio, and whether an occlusion map was available;
a linked panorama ID by itself is not a projection-health result.

```ts
await window.foreScene.inspectProjectionHealth({
  shotId: 'shot-001',
  timeSeconds: 0,
});
```

## Reference-driven composition

An external storyboard or layout review may be reduced to normalized screen-space
facts without putting image understanding in ForeScene. The contract can name
subject and prop bounds, head/face points, screen regions, expected coverage,
horizon/floor lines, and intentional foreground/background overlap:

```ts
await window.foreScene.setShotCompositionConstraints({
  shotId: 'shot-001',
  contract: {
    referenceImageAssetId: 'storyboard-001',
    subjects: [{
      entityId: 'lead',
      expectedBounds: { x: 0.32, y: 0.18, width: 0.28, height: 0.68 },
      headPoint: [0.46, 0.2],
      screenRegion: 'center',
    }],
    cropTolerance: 0.05,
  },
});
window.foreScene.inspectShotCompositionError({ shotId: 'shot-001' });
window.foreScene.verifyShotCompositionConstraints({ shotId: 'shot-001' });
await window.foreScene.solveShotToCompositionConstraints({ shotId: 'shot-001' });
```

The deterministic solver may adjust only camera position, target, and FOV. It
does not swap entities, alter poses or continuity state, change location, or
replace assets. A saved composition contract is a hard first-frame gate, so a
generic framing percentage is not enough when the approved reference places a
subject elsewhere. Failed solves are not committed; inspect and repair the
contract or the prepared asset before proceeding.

## Verified mutations

Mutations whose semantic result matters use a recovery checkpoint plus a
postcondition check. The proxy-replacement adapter is available through:

```ts
await window.foreScene.applyVerifiedProxyReplacement({
  proxyObjectId: 'proxy-lead',
  replacementObjectId: 'lead-import',
  requestedShotIds: ['shot-001'],
  intendedShotIds: ['shot-001', 'shot-002'],
  initializeVisibility: true,
});
```

The result includes the preview, atomic apply result, verification report, and
rollback report. A failed replacement is restored automatically to the
checkpoint, including unaffected shot state; `restoreRefinementCheckpoint`
remains available for an explicit operator rollback. Refinement batches also
automatically restore their batch checkpoint after a blocking verification or
review failure, leaving the batch pending for retry.

## Production gates and canary

Production orchestration is a gated state machine. Input, bindings, and asset
capabilities are validated before a recovery revision and a small canary are
authored. The canary uses a deterministic greedy set-cover over location,
panorama, imported-character, pose, multipart, prop, visibility, camera-motion,
and reference-composition capabilities. It emits only clay-with-subjects,
characters-only, clean-plate, and (when required) projected-with-subjects
review outputs.

```ts
const planned = window.foreScene.planProductionCanary({ manifest });
const canary = window.foreScene.runProductionCanary({
  runId: planned.runId!,
  results: observedCanaryResults,
});
await window.foreScene.approveProductionCanary({ runId: planned.runId! });
window.foreScene.inspectProductionGates({ runId: planned.runId });
```

The full still sequence remains locked until canary presence, capability,
panorama, composition, unrelated-state, and output checks pass. A failed
canary can only be overridden with a non-empty reason, which is retained in the
gate report. Command success and artifact existence do not constitute visual
approval.

Still approval is a separate gate. After the full still sequence has passed
verification, approval records the exact project fingerprint and reviewed
shot/artifact IDs on a verified revision:

```ts
await window.foreScene.approveStillLayout({
  runId: planned.runId!,
  approvedShotIds: ['shot-001', 'shot-002'],
  reviewArtifactIds: ['master-sheet'],
  reviewRecord: 'Primary still layout approved for motion blocking.',
});
const motion = await window.foreScene.createMotionWorkingRevision({
  runId: planned.runId!,
});
```

Motion work is cloned into a separate persisted revision and never loads over
the approved still revision. If the approved project fingerprint or an
approved shot's camera, staging, pose, visibility, or panorama changes, the
motion branch is rejected as stale.

## Cached review and adaptive sampling

Review frames are keyed by renderer version, profile, effective camera and
staging at the sample time, linked panorama/style settings, relevant asset
content hashes, and prepared-location revision. The run-state stores that key;
an existing PNG is reused only when the current project produces the same key.
Changing an unrelated dynamic object therefore does not invalidate every shot,
while changing a camera, pose, panorama, or relevant location object does.

```ts
window.foreScene.planReviewSamples({
  shotId: 'shot-001',
  strategy: 'event-aware',
  maxSamples: 3,
});
```

Static shots plan one sample. Linear camera moves plan start/end; direction
changes and visibility/pose events are preferred within the configured bound.
Motion review remains sample-based until still approval; it does not imply a
video or complete pass matrix.

Browser callers can inspect and invalidate the persisted cache without changing
the project:

```ts
window.foreScene.inspectRenderCache();
window.foreScene.explainRenderCacheHit({ fingerprint });
window.foreScene.invalidateRenderDependencies({ dependencyIds: ['object:obj-1'] });
```

## Project-wide review artifacts

The production review planner groups the same canonical frames into compact,
readable artifacts:

- a master sequence sheet;
- one sheet per prepared location;
- motion triptychs using event-aware samples when motion frames are supplied; and
- adjacent-shot continuity strips.

Every tile carries the shot number/name, sample time, location, camera recipe,
presence and panorama status, composition error when measured, review status,
diagnostic badges, and cache-hit state. These are review evidence, not approval
records. External visual feedback is normalized into repair intents and must be
applied through previewed, verified mutations.

The CLI writes the master sheet at `contact-sheet.png` and the grouped sheets
under `review/`; `logs/production-review-artifacts.json` is the machine-readable
index. No sheet or artifact-existence check is itself a visual approval.

The same pure planner is available to browser callers when frames already live
in the Agent artifact registry:

```ts
window.foreScene.planProductionReviewArtifacts({ frames });
```

## Browser-owned production runs

The browser Agent API persists lifecycle state independently of the Node CLI,
including the current gate, completed shot IDs, cache keys, artifact handles,
blocking diagnostics, and explicit overrides. A restart can inspect the same
run and resume only after the outstanding approval gate is satisfied:

```ts
const run = await window.foreScene.runProduction({ manifest });
window.foreScene.subscribeProductionRun(run.runId, (state) => console.log(state.currentGate, state.status));
window.foreScene.getProductionRun(run.runId);
await window.foreScene.resumeProductionRun(run.runId);
```

`pauseProductionRun`, `resumeProductionRun`, and `cancelProductionRun` are
stateful lifecycle operations. Cancellation preserves completed verified
artifacts; it does not roll back the project unless a blocking mutation gate
requires rollback.

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

Add `--allow-heavy-character-imports` when the manifest intentionally includes
a character above the standard memory tier.

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
