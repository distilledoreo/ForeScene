# ForeScene

**ForeScene** is a local-first, browser-only previsualization and continuity workspace for AI-assisted video production. Block out a graybox set, stage and pose characters in it, capture 360° reference panoramas, design still and motion shots against real camera truth, and export production-ready handoff packages for external AI generation and compositing tools.

Everything runs in the browser tab. There is no backend, no account system, and no shared API key: projects, assets, and revisions live on your machine.

ForeScene is a **handoff tool**. It produces control frames, camera truth, and packages for downstream tools — it is not the archive for final generated stills and video.

## What ForeScene does

**Build and import.** Block out sets from graybox primitives (floors, walls, boxes, arches, doorways, columns, stairs, trees, terrain, backdrops, people, sun markers) in a full-bleed sandbox with multi-select, clipboard, transform gizmos, snapping, and a free walk camera. Bring in existing geometry through GLB/glTF, FBX, OBJ, STL, PLY, or `.panoscene` bundles; imports are geometry-only and budget-checked against device memory. You can also generate a starting set from a written description via the SetBlueprint format.

**Character staging and rigging.** Drop in the built-in Person primitive (a bundled CC0 mannequin) or import your own character as GLB/embedded glTF. Imported characters go through a two-step autorig wizard — **Joints**, where you place markers over orthographic front and side views with mirroring and undo/redo, then **Pose & Fix**, which labels the mesh into six body regions, generates region-constrained skin weights, and lets you validate against diagnostic test poses and repaint regions with brush or lasso tools. Wizard drafts autosave locally. Posing happens in Build with separate **Move Character** and **Pose Character** modes: 20 editable joints with per-axis rotation limits, 18 pose presets, mirror pose, per-joint reset, and in-viewport joint handles. Poses persist in the project and can be overridden per shot and per camera keyframe.

**Reference management.** Render a 4096×2048 equirectangular graybox 360 from the pano origin, then import a styled canonical panorama and align it with yaw offset and graybox-fade compare controls. You can approve the graybox itself as the reference while iterating without a final styled pano. Multiple capture origins are supported, and the coverage optimizer analyzes floor-aware candidate positions to suggest where a second origin should go. Projected Style samples the aligned panorama onto scene geometry in world space for styled viewport and export renders.

**Still and motion shot design.** Shots use iPhone-style camera chrome: full-bleed viewfinder, **Still** / **Video** modes, one center shutter, and a thumbnail that opens the shot library. Still capture saves the current pose without freezing the viewfinder. Video uses sequential capture — capture a pose, fly, capture the next — then exposes a timeline with per-segment easing, path preview, and optional MP4 render of the graybox camera move. Fly Camera keeps a broad safety volume around the set.

**Continuity tools.** Named 3D landmarks act as shared anchors across prompts and packages. Shot-to-shot continuity compare and a sequence storyboard (reorder, duration, animatic playback, copy staging) live under Shot settings, and persisted workflow checkpoints track reference approval, accepted framing, and package export across the whole production path.

**Export and compositing passes.** Shot packages carry clay control frames as the geometric authority, plus optional projected-style renders, linear camera-depth passes, cubemap faces, panorama references, camera metadata, and prompts. People output can be **with people**, **clean plate**, or **both** — variant files are suffixed rather than overwritten. A separate character pass isolates staged characters for compositing as stills, green-screen MP4, transparent PNG sequence, or both motion formats.

**Local-first project safety.** Projects autosave to verified local revisions and take recovery snapshots before destructive changes, so there is no manual save-on-a-timer. Imported mesh geometry is stored as binary in IndexedDB and referenced by stable key, keeping project documents smaller than base64 embedding. Recovery keeps a bounded number of autosaves and snapshots, missing binaries surface a recoverable placeholder instead of vanishing, and failed saves report errors rather than reporting false success.

## Supported interchange formats

| Purpose | ForeScene | Also accepted (import) |
| --- | --- | --- |
| Project backup | `<project_name>_forescene.forescene-project` | `.panoref-project`, `.zip`, `.json` |
| Character rig | `.fsrig` — `forescene-poseable-rig` v2 | `.panorig` — `panoref-poseable-rig` v1 |
| Scene bundle | `.panoscene` containing `forescene-scene.json` | `.panoscene` containing `panoref-scene.json` |
| Geometry import | `.glb`, embedded `.gltf` | `.fbx`, `.obj`, `.stl`, `.ply` |
| Poseable character | `.glb`, embedded `.gltf` | — |
| Reference panorama | 2:1 equirectangular image | — |
| Shot handoff | ZIP per shot (see [Shot Package Format](#shot-package-format)) | — |

## Legacy compatibility

The rebrand from PanoRef / Continuity Stage to ForeScene is user-facing. On-disk and in-browser identifiers that would break existing local data are deliberately unchanged.

- The npm package is `forescene`. The GitHub repository may still be `distilledoreo/PanoRef`; renaming it is a separate cutover step and has not happened yet.
- Local preferences moved to `forescene-app-mode`, `forescene-splash-seen`, and `forescene-theme`, migrating from the `panoref-*` keys on first run. The studio app mode was previously stored as `continuity` and migrates to `studio`.
- Older `.panoref-project` backups and `.panorig` rigs stay importable indefinitely, as do `.panoscene` bundles whose manifest is still named `panoref-scene.json`.
- IndexedDB database names (`panoref-model-assets`, `panoref-project-assets`, `panoref-project-revisions`, `panoref-autorig-drafts`), the `panoref-idb:` asset URI scheme, and the `application/vnd.panoref.graybox-mesh` packed-mesh type are persisted values kept verbatim so existing local data keeps opening. They are legacy names, not deprecated formats.
- "Continuity" remains the domain term for compare, landmarks, and handoff packages — it is no longer a product name.

## Run Locally

Prerequisite: Node.js 22 or newer.

```bash
npm install
npm run dev
```

The dev server starts at `http://localhost:3000`. If that port is already occupied, Vite prints the next available local URL; use the URL shown in the terminal for browser verification.

## Workflow

After the intro splash, pick a mode: **Open ForeScene studio** (full pipeline) or **Just view a 360 pano** (import, look around, **Download current view**). Switch anytime from the brand menu. The choice is stored in `localStorage` as `forescene-app-mode`.

In studio mode, the top stage rail tracks progress across Build → Reference → Shots → Export. It guides without locking you in — every workspace remains available at any time.

Open an existing project with the folder button in the top-right header, or use the compact brand menu for New Project, Open/Import Project Backup, Export Project Backup, Package Export, and Project Safety & Recovery. Project import accepts ForeScene project backups (and legacy PanoRef ones) and reports a clear error if the selected file is not a supported schema.

Persisted workflow checkpoints are saved in project JSON under `workflow`:

- `grayboxApprovedForReferenceAt`
- `shotFramingAcceptedAtByShotId`
- `finalPackageExportedAtByShotId`
- `aiBriefSentAtByShotId` (legacy; no longer required by the production path)

Open **Help & Documentation** from the brand menu for the searchable quick start, workspace guides, current screenshots, keyboard reference, project-file notes, and troubleshooting.

1. **Build:** shape the graybox set in the full-bleed sandbox. The bottom object tray stays compact around its tools on desktop and becomes a horizontally scrollable strip on phones; it shows the primary primitives (with hotkey badges), while the compact **More** tool opens select/origin/snap, extra primitives, and a shortcut cheatsheet. The viewport starts centered on the graybox set with the familiar orbit/select controls. Use the top-left **Free camera** toggle only when you need to walk around: drag to look, use `W/A/S/D` to move, `Space`/`Shift` to move vertically, and double-tap W to sprint; `Esc` exits, while selected-object edit controls stay out of the way until you turn Free camera off. On a phone, use the on-screen pad and Up/Dn controls to move. Use the adjacent **Visibility distance** control to adjust both how far the Build viewport draws and where its fog/shroud begins to obscure the set (`40m–500m`); this affects the Build viewport only, not shot or export cameras. **Render 360 Reference** captures a 4096×2048 graybox 360 when blocking and pano origin look right. After a graybox exists, **Download Graybox 360** becomes the primary action (native 2:1 equirectangular PNG); use **Re-render after scene changes** only when the set or origin changed. Selected objects support solid colors or a 1m×1m face-aligned checkerboard surface in Precision. In Select mode, the selected object shows an in-canvas transform gizmo with teal/red/blue move arrows plus rotate and scale controls in the floating object card; drag arrows for axis moves or drag the object body for floor-plane moves. Character staging also lives here: import a poseable character, run the rig wizard, and switch a selected character between **Move Character** and **Pose Character**. Camera frustums and passive 3D landmark markers stay hidden by default — use the small eye toggle in the top-right to show scene guides when needed. Pano origin placement (`O`) still reveals the origin marker while guides are hidden.
2. **Reference:** import a styled canonical pano or approve the graybox when iterating without a final AI pano yet. When alignment is needed, yaw and graybox-fade sliders appear on the viewer chrome; full alignment controls stay in the precision drawer.
3. **Shots:** iPhone-style camera chrome — full-bleed viewfinder, **Still / Video** modes, one center **shutter**, and a bottom-left thumbnail that opens the shot library. **Still:** shutter **Capture** saves the current pose (and creates another shot on the next capture) without freezing the viewfinder. **Video (sequential capture):** Capture start → fly → Capture next pose → after two or more poses, **Finish capture** (or keep capturing). The timeline appears after a third pose or **Edit timeline**. When finished, primary action is **Next shot**; Preview plays the path, and optional **Render MP4** encodes a Resolve-safe clip. Undo restores keyframes and capture state together. Shot-to-shot **continuity compare** and a **sequence storyboard** (reorder, duration, animatic, copy staging) live under Shot settings. Companion clay/projected stills store for the gallery and ZIP package. Fly Camera keeps a broad safety volume around the set.
4. **Export:** multi-select shots and download continuity ZIP handoff packages with **Export Selected Shots**. Packages carry clay control frames, optional depth and projected passes, people and character-pass variants, pano/cubemap references, camera metadata, and prompts for external tools. You do **not** need to import AI results back into ForeScene. Package include/exclude toggles stay in **Export Settings**.

## Generate set from description

Open **Build > More > Generate set from description**. This creates a graybox set from a spatial description via the **SetBlueprint** format — an AI-facing subset of the native project document.

Manual workflow (default, local-first):

1. Describe the set (optional width/depth, detail level, constraints).
2. **Copy prompt for external model** and paste it into any frontier model.
3. Switch to **Paste blueprint JSON**, paste the model output, then **Validate and review**.
4. **Create generated project** — the current project is saved as a recovery point first.

Optional direct generation: set `VITE_SET_GENERATION_ENDPOINT` to a same-origin or absolute URL. The endpoint receives the system/user prompts and must return SetBlueprint JSON (not a native LocationProject). API keys stay server-side. Failed validation retries once with the error list, then surfaces remaining errors.

See [docs/SET_BLUEPRINT.md](docs/SET_BLUEPRINT.md) for schema, limits, coordinate conventions, and the difference between blueprint import and native project import.

## 3D Model and Scene Import

Open **Build > More > Import 3D model or scene**. Import is local-only and geometry-only: source materials, textures, cameras, lights, rigs, animation, and morphs are omitted. Exact triangles are retained; the importer does not automatically decimate or otherwise simplify geometry. World-space placement is preserved with hierarchy flattened.

To bring in a character you intend to pose, use **Import poseable character** instead — that path keeps the source mesh intact for rigging rather than flattening it into graybox geometry.

Recommended exports:

- Blender: File → Export → glTF 2.0 (.glb) – include the entire scene, apply transforms if you want final world space.
- Maya: File → Export All → FBX – include all visible objects.
- Unreal: File → Export All → export selected level/actors as GLB.

Direct import formats are:

- GLB and embedded glTF 2.0 (preferred)
- FBX, OBJ, STL, PLY
- .panoscene bundles (.panoscene, .panoscene.zip)

Import modes:

- **Keep objects separate (default)**: One Mesh = one object, one InstancedMesh = one object containing all instances, no per-instance objects. Hierarchy is not recreated – world transforms are baked. Each object gets position = center of its world bounds, rotation [0,0,0], scale [1,1,1]. Move one chair without moving others.
- **Combine into one object**: All nodes world-transformed into one asset and one object.

The import report shows one summary card per source file; the individual imported nodes remain available in Layers. Imported object names preserve source node names, including meaningful numeric suffixes such as `Wall_01`; only exact duplicates receive `(2)`, `(3)`, and so on. If a recognized mesh has malformed or non-triangle geometry, that source file is rejected with the mesh name instead of silently omitting the geometry.

Preserved: world-space positions/rotations/scales baked, exact triangles, instance counts aggregated. Not preserved: editable parent-child hierarchy, pivot points, materials, textures, cameras, lights, animation, rigs, deformers, morphs.

Native DCC files like `.blend`, `.ma`, `.mb`, `.uproject`, `.umap`, `.uasset` are not supported for direct import. If selected, ForeScene shows a useful error guiding you to export GLB/FBX. The importer never executes native scene logic.

Loaders are fetched from the existing Three.js dependency only after a user chooses that format. Each imported object is converted once to a compact graybox mesh stored with the project. Large imports may increase project size – external references are not supported in this slice. OBJ, STL, and PLY have no reliable unit metadata; 1 source unit is treated as 1 meter. External `.gltf` `.bin` sidecars and compressed Draco/Meshopt glTF are not supported; export uncompressed GLB.

Pipeline handoffs can instead provide a `.panoscene` ZIP with this shape:

```text
scene.panoscene
  forescene-scene.json
  geometry/scene.glb
```

Example `forescene-scene.json`:

```json
{
  "schemaVersion": 1,
  "entry": "geometry/scene.glb",
  "geometryOnly": true,
  "source": {
    "application": "blender",
    "file": "scene.blend",
    "version": "4.x"
  }
}
```

Bundles whose manifest is still named `panoref-scene.json` are accepted unchanged.

Imports above the encoded mesh or source-file safety limits stop with a clear error and leave the source unchanged. Heavy imports report their triangle count; no hidden simplification is performed. See [docs/heavy-model-imports.md](docs/heavy-model-imports.md) for the classification thresholds and budget math.

## Character Rigging and Posing

Open **Build > More > Import poseable character** and choose a `.glb` or embedded `.gltf`. External `.bin` sidecars are rejected. At import you set the canonical orientation — front axis, up axis, ground level, approximate height (0.5–3.5 m) — and a rest-pose hint (A-pose or T-pose). Unlike ordinary model import, this path keeps materials and textures and stores the unmodified source bytes, so re-rigging never degrades the mesh. Any existing skinning or animation in the source is ignored in favor of ForeScene's own bind.

If you already have a saved rig for that mesh, attach a `.fsrig` (or legacy `.panorig`) during import. When the topology hash and vertex count match, the rig is applied and the wizard is skipped.

Otherwise the two-step **Rig character** wizard opens:

1. **Joints** — drag markers onto joints over orthographic Front and Side previews. Mirror all markers, reset to suggested placement, center depth, and undo/redo are available.
2. **Pose & Fix** — the mesh is auto-labeled into six regions (head, torso, left/right arm, left/right leg) and region-constrained skin weights are generated. Check the result against diagnostic test poses (neutral, arms raised, elbows bent, sitting, walking, crouching), then correct region assignments with brush or lasso painting directly on the posed preview. Deformation validation flags problem areas and can auto-repair them.

In-progress markers and region edits autosave, so closing the wizard does not lose work. **Apply rig** writes the skin weights and hydrates the live character.

Posing a selected character uses the **Pose Character** mode: pick from 18 presets, select any of 20 editable joints from the panel or by clicking its viewport handle, and adjust X/Y/Z rotation within anatomical limits. Mirror pose, reset joint, and reset pose are one click. Built-in mannequins and autorigged imports share the same semantic joint set, so presets and mirroring behave identically across both.

**Save rig** writes a finished rig to a `.fsrig` ZIP for reuse on the same mesh:

```text
hero-rig.fsrig
  manifest.json
  skin.bin
  region.bin
```

`manifest.json` carries `format` (`forescene-poseable-rig`), `version` (`2`), `exportedAt`, the detached rig definition, an optional `topologyHash` and `characterName`, and the names of the binary payloads. `skin.bin` and `region.bin` are present only when those payloads exist. Legacy `panoref-poseable-rig` v1 packages import as-is.

## Storage and performance (summary)

ForeScene is a local-first browser app. Capacity depends on your device, browser tab limits, and project complexity. Full figures (each labeled **Measured baseline**, **Recommended operating limit**, or **Hard-enforced limit**) live in [`docs/STORAGE_AND_PERFORMANCE.md`](docs/STORAGE_AND_PERFORMANCE.md) and `src/engine/budgets.ts`.

In short:

- Prefer graybox sets around a few hundred thousand triangles for comfortable editing (recommended, not enforced).
- Large model imports are classified and may require confirmation or be rejected using device memory heuristics (hard-enforced).
- Projects autosave verified revisions; recovery keeps a bounded number of autosaves/snapshots (hard-enforced prune).
- Camera-move duration and 1080p/4K@30 presets are clamped/enforced; 4K encode is memory-heavy (measured guidance).
- Chromium desktop is the primary target for full MP4 render; browser storage quotas vary—failed saves surface errors without false success.

## Build Shortcuts

Primitive stamps use game-inventory style number slots: `1` Floor, `2` Wall, `3` Box, `4` Arch, `5` Doorway, `6` Column, `7` Stairs, `8` Tree, `9` Terrain, and `0` Person. Backdrop, Sun, Arch, Terrain, and Person are also reachable from the tray's **More** tool when they are not part of the primary visible strip.

Build supports ordered multi-selection: click replaces the selection, `Shift`-click or `Ctrl`/`Cmd`-click toggles objects, and the Layers list supports `Shift` range selection. `Ctrl`/`Cmd+A` selects all visible unlocked objects, `Ctrl`/`Cmd+Shift+A` or `Esc` clears selection, and group move/rotate/scale uses the shared selection bounds.

Clipboard actions are `Ctrl`/`Cmd+C`, `X`, and `V`; `Ctrl`/`Cmd+Shift+V` pastes in place and ordinary paste cascades copies visibly. Imported-model clipboard payloads include their packed mesh assets; incomplete or malformed asset references are rejected instead of creating missing-mesh placeholders. `D` or `Ctrl`/`Cmd+D` duplicates. Arrow keys nudge on world X/Z, `Page Up` / `Page Down` nudge vertically, `Shift` makes nudges coarse, and `Alt` makes them fine. `F` frames the selection, `Home` frames the scene, `F2` renames one object, `Alt+H` shows all, and `?` opens the full reference.

Existing Build actions remain: `V` or `Esc` for Select, `O` for Origin, `G` for Snap, `R` / `Shift+R` for rotate right/left, `[` / `]` for scale down/up, `T` / `E` / `S` for gizmo mode, `L` for lock, `H` for hide/show, `I` for Precision, and `Delete` / `Backspace` for delete. Shortcuts are ignored while typing in editable fields so native text cut/copy/paste remains available. When **Free camera** is active, `W/A/S/D`, `Space`, and `Shift` belong to camera movement (double-tap W sprints) instead of Build editing.

## Project Format

Saved projects use ordered schema migrations (current schema `1.0`, product version `0.1.0`). Older `0.1` / `0.2` files migrate on load.

Projects **autosave** to verified local revisions with recovery snapshots before destructive changes. Use the brand menu for New Project, Import/Export Project Backup, Package Export, and Project Safety & Recovery. Rename the project from the brand menu name field. Exporting a backup downloads `<project_name>_forescene.forescene-project`, a ZIP containing `project.json` plus the binary mesh assets it references.

Top-level fields include:

- `scene`: primitive graybox objects, imported meshes, staged characters, and the pano origin.
- `panoRefs`: graybox, canonical, or external equirectangular references.
- Graybox 360 panos use standard equirectangular image orientation: up/sky at the top, down/floor at the bottom.
- Pano reference `rotation[1]` stores the calibrated yaw offset in degrees. A value of `0` means image center (`u=0.5`) faces world `+Z`; positive values rotate that image center toward world `+X`.
- `landmarks`: named continuity anchors used in prompts and packages.
- `shots`: camera truth, status, linked pano, selected landmarks, per-shot object overrides, prompt overrides, and export settings.
- `assets`: imported/rendered images, poseable-rig payloads, and texture-free model meshes. Model geometry is referenced by `panoref-idb:` key into IndexedDB; older base64 data URLs still load and migrate to binary on next save.
- `settings`: project-wide settings including `settings.projectedStyle`.
- `workflow`: persisted production-path checkpoints for reference approval, landed framing, and package export.

Character poses are stored per object as `humanPose` (semantic joint rotations, separate from the object transform) and can be overridden per shot and per camera keyframe.

Legacy project files may still contain ignored `projectionStamp` fields on scene objects or `includeContinuityControlView` in shot export settings. Those values are dropped on load.

## Shot Package Format

An exported shot ZIP uses this shape. Only the files a shot actually produces are written, and `manifest.json` lists exactly those paths:

```text
shot_001/
  inputs/
    viewport_clay.png
    viewport_projected.png
    viewport_depth.png
    viewport_clay_motion.mp4
    viewport_projected_motion.mp4
    viewport_depth_motion.mp4
    cubemap/
      px.png
      nx.png
      py.png
      ny.png
      pz.png
      nz.png
      cubemap_stitched.png
    camera_move/
      clay_start.png
      clay_mid.png
      clay_end.png
      projected_start.png
      projected_mid.png
      projected_end.png
      depth_start.png
      depth_mid.png
      depth_end.png
    characters/
      viewport_clay_characters.png
      viewport_clay_characters_motion.mp4
      viewport_clay_characters_sequence/
        frame_000001.png
        sequence.json
    pano_crop.png
    global_reference.png
    global_graybox.png
  outputs/
    ai_result_frame.png
  metadata/
    shot.json
    camera.json
    camera_keyframes.json
    camera_move_reference_frames.json
    depth.json
    character_pass.json
    landmarks.json
    location.json
  prompts/
    image_gen_prompt.txt
    video_gen_prompt.txt
    negative_prompt.txt
  manifest.json
```

`inputs/viewport_clay.png` is the primary camera-locked AI control image. It renders the shot camera view from the graybox scene, including any staged and posed characters. Helper-only build objects such as the sun marker are omitted from this render and from `inputs/global_graybox.png`.

`inputs/viewport_projected.png` is the projected-style companion still, written when a styled panorama is available. `inputs/viewport_depth.png` is a linear camera-depth pass using the shot's shared near/far range.

`inputs/viewport_clay_motion.mp4` is included only after a shot camera move has been exported. It records the graybox scene through all authored camera keyframes as a 16:9 MP4, using browser MP4 recording support when available. `metadata/camera_keyframes.json` stores the captured keyframes, timing, and segment easing when keyframes exist. Projected and depth motion clips follow the same rules.

`inputs/cubemap/` is included whenever a full styled/linked pano is exported (`includeFullPano`). Face PNGs (`px`…`nz`) and `cubemap_stitched.png` provide an undistorted environment reference alongside the equirectangular `global_reference.png`.

`inputs/camera_move/` is included when camera keyframes exist and camera-move reference frames are enabled. Start/mid/end frames are sampled from the shot move in whichever appearances are enabled (`clay_`, `projected_`, `depth_`). `metadata/camera_move_reference_frames.json` records the sampled frame times and cameras; `metadata/depth.json` records the depth range.

`inputs/characters/` is the optional character pass: staged characters rendered in isolation over the configured background color for compositing. It can contain a still, a green-screen MP4, and/or a transparent PNG sequence (`frame_000001.png` upward with a `sequence.json` timing sidecar), in clay and — when projected export is on — projected appearances. `metadata/character_pass.json` describes the pass.

`inputs/global_reference.png` is included only when a canonical/global reference pano exists. It provides visual identity, lighting, material, and palette authority.

`inputs/global_graybox.png` is included only when a graybox pano exists. It provides full-location spatial context.

`inputs/pano_crop.png` is included only when the selected shot has a linked pano and crop settings. It is supporting local context from the linked pano origin and may not match the shot perspective when the shot camera is away from that pano origin.

`outputs/ai_result_frame.png` is included only when an older project already has an AI result asset attached (optional; not part of the normal handoff path).

**People variants.** With the default `with_people` mode, render paths are unsuffixed. Choosing `clean_plate` writes `_clean_plate` variants with staged people hidden; choosing `both` writes `_with_people` and `_clean_plate` side by side (for example `viewport_clay_with_people.png` and `viewport_clay_clean_plate.png`).

## Verification

Prefer targeted checks while iterating; run the pre-merge set once the change is stable (see `AGENTS.md`).

```bash
# Inner loop (example)
npx vitest run tests/<relevant>.test.ts
npm run lint:fast

# Pre-merge
npm run lint
npm run test          # fast unit suite (no Chromium)
npm run test:browser  # only when renderer / projection / WebGL changed
npm run build
npm run test:e2e:smoke
npm run goal:smoke
```

Runtime verification should also launch the app, render a graybox 360 pano with **Render 360 Reference**, import a canonical pano, approve reference alignment, land a shot, confirm the filmstrip/Export thumbnails use real available media, export selected shot packages without importing any AI result, and exercise at least one warning state such as exporting before a shot exists.

For project import specifically, verify the top-right folder button opens a saved ForeScene project file, shows a project-opened status, updates the project name in the brand menu, and shows an error status for invalid JSON or unsupported schema files. Also confirm a legacy `.panoref-project` backup still opens.

For character rigging specifically, verify importing a `.glb` character opens the rig wizard, that markers can be placed and mirrored in the Joints step, that Pose & Fix generates skin weights and responds to diagnostic test poses, that applying the rig makes the character poseable in Build, and that an exported `.fsrig` reapplies to the same mesh on a fresh import.

For camera-move MP4 export, verify a shot can capture Start and End keyframes from landed views, export a playable MP4 when the browser reports MP4 support, preview the saved clip in Shots, and include `inputs/viewport_clay_motion.mp4`, `inputs/camera_move/clay_start.png`, `inputs/cubemap/pz.png`, `inputs/cubemap/cubemap_stitched.png`, `metadata/camera_keyframes.json`, and `metadata/camera_move_reference_frames.json` in the final ZIP manifest (no `cubemap_visible` paths). In an unsupported browser or after a render error, verify a clear message appears immediately above the shutter rather than only in Camera Settings.

For the Build sandbox specifically, verify pressing `3` to stamp multiple Boxes, using `Esc` or `V` to return to Select, pressing `0` to stamp Person, confirming Backdrop and Sun are click-only, dragging the selected object in Select mode, dragging the visible transform gizmo arrows for axis moves, using the rotate/scale controls in the selected-object card, toggling grid snap with `G`, entering Origin mode with `O` and using translate/rotate gizmos (T/E) on the amber capture origin (confirm the multi-origin warning when a styled reference pano is already loaded), confirming camera frustums stay hidden until the scene-guides eye toggle is enabled, using selected-piece shortcuts, confirming shortcuts do not fire while editing a name field, and checking that orbit center and click targets stay visually aligned with the cursor on high-DPI displays.

For Fly Camera specifically, verify sustained movement can travel beyond walls and floors without leaving a reasonable set-adjacent volume; the expected horizontal limit is 10m past the farthest visible non-helper object.

## Limitations

- MVP is local-first; there is no backend, account system, or shared AI API key in the Vite app. Optional set generation uses a configurable HTTP endpoint (`VITE_SET_GENERATION_ENDPOINT`) with credentials kept server-side, or a manual paste workflow with any external model.
- Set geometry editing is primitive-level only. There is no vertex editing, UV editing, or shader graph. Character rigging and posing **are** supported (autorig wizard, semantic joint posing, per-shot and per-keyframe pose overrides), but there is no general animation timeline for arbitrary objects and no user-facing IK solver — joints are posed by rotation, not by dragging end effectors.
- Character rigging targets upright humanoid meshes. Quadrupeds, mechanical rigs, facial rigs, and cloth or hair simulation are out of scope.
- Native `.blend`, `.ma`, `.mb`, and Unreal asset bytes require a GLB/FBX bridge or `.panoscene` handoff; the browser does not parse those proprietary formats directly.
- Imported mesh geometry is stored as binary in IndexedDB, but images and other assets still live in the project document, so large projects can become heavy and slow to back up.
- Shot packages keep `viewport_clay.png` as the authoritative geometric control frame. By default, packages also include `inputs/viewport_projected.png`, `inputs/viewport_projected_motion.mp4`, and `inputs/camera_move/projected_*.png` when a styled panorama is available (soft-skipped if not). Clay and projected are dual outputs — the Clay/Projected appearance toggle only changes the live viewfinder, not which files are produced.
- Projected Style samples the aligned equirectangular panorama in world space onto existing graybox/imported meshes. It does not create geometry, reconstruct occluded surfaces, or bake UVs; quality is best near the pano origin and degrades with large translations (stretching / duplicated imagery around occlusions).
- Projected Style's **Coverage optimizer** uses deterministic area-weighted surface samples, geometric face normals, a double-sided segment BVH, viewing angle, and approximate texel density to estimate usable projection coverage. Imported upward surfaces are grouped into connected components so small prop, shelf, and tabletop surfaces are excluded from camera-floor candidates while substantial multilevel floors remain eligible. For multi-room sets or geometrically ambiguous roofs/platforms, enable **Analysis region** and enter world-space X/Y/Z bounds (or **Use selection bounds** after selecting the room's objects in Build); camera candidates and scored surfaces are both limited to that volume, and candidate spacing / separation scale to the region diagonal. Expand Y to full room height so walls count. **Keep current + find second** preserves the selected primary panorama origin and maximizes the second origin's marginal union coverage. **Optimize both origins together** evaluates candidate pairs from the start, so complementary second-tier origins are not discarded by a greedy first choice. See [the imported-set benchmark](docs/coverage-optimizer-benchmark.md) for the repeatable production-scene check.
- Coverage search uses compact indexed typed arrays transferred into a Web Worker, with a 4,096-sample/256-candidate coarse pass, a shared 24,576-sample reporting bank, retained pair seeds, and four iterative levels of floor-aware local pattern refinement. Candidate positions are inferred from upward-facing floor surfaces and rejected using actual triangle clearance; unrestricted scene-bounds placement is not used. Results report A/B-only coverage, overlap, combined coverage, the reachable upper bound, reachable efficiency, and estimated remaining surface. Suggested origins are a capture plan: move the capture origin, then either Download Projected 360 from Build (styled pano projected onto geometry from that vantage — useful for second-pano inpainting) or Render clay 360 and style from scratch, and import the finished result. Existing panorama origins are never rewritten because their pixels remain tied to the original capture position.
- Projection quality depends on pano alignment. If the canonical pano is yaw-shifted relative to the graybox pano, use the opacity compare view and set the reference yaw offset before exporting shot packages. Projector knobs (opacity, exposure, lighting contribution, fallback, source pano) live under Reference → Precision as `settings.projectedStyle`.
- Final/generated AI images and videos live outside ForeScene; the in-app MP4 export is a graybox camera-motion control clip, not final AI video generation.
