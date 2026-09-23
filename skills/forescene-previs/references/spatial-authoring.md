# Spatial authoring through CLI or MCP

Use this reference for new sets, substantial geometry changes, repeated layouts, or debugging scale, support, openings, and occlusion. Repository documentation paths below are relative to the ForeScene checkout, including when this skill is loaded from a generated harness adapter.

## Choose the surface

- **CLI:** local `.fsp` open/save, model/character imports, timeline edits, canonical frame/video files, and exports. Discover current commands with `agent:capabilities` and their flags with `agent:describe`. Use an isolated profile and retain project/revision identity.
- **MCP:** the project open in a paired browser tab. Read `agent_reference` before substantial construction. `scene_query` gives compact selections; `scene_inspect` explains transforms, world bounds, support and intersections. `scene_validate` and `scene_capture` can inspect the hypothetical result of a supplied `plan` before applying it.

The surfaces share the Agent Plan model, not live browser state. Do not switch a production into an unrelated paired tab, assume CLI has MCP-only command names, or copy credentials between sessions. If MCP is unavailable, use a functioning CLI session without blocking on optional connector setup. Do not claim an unavailable validation/capture was performed.

Read `docs/remote-mcp-netlify.md` for setup and current limitations. Remote sessions are single-flight, expire, require the paired tab to remain open, and separately gate editing. MCP `shot_render` returns browser-local artifact handles rather than a downloaded image; metadata alone is not visual review. Use a supported local capture/export path to obtain evidence.

## Stateful scripts

Read `docs/agent-scripting.md` for helpers and examples. `agent:script` without `--write` compiles/previews; MCP `project_script` also only previews. The script uses a transactional shadow project: typed `scene`, `shots`, and `landmarks` mutations are immediately queryable by later statements, while the real project remains unchanged. The generated plan still goes through validation, revision/fingerprint checks, atomic apply, persistence, and undo.

Prefer scripts over hundreds of manually repeated commands. Use `scene.createMany/updateMany/duplicateMany`, arrays, spatial helpers, and `architecture` where they fit. A reused template still needs shot-specific action, pose, visibility, camera, and timing; generic shot cloning is not story coverage.

`plan.command(...)` can emit supported raw operations, but arbitrary raw commands are not reflected back into the shadow state. Do not read later shadow measurements as though those commands had executed. Scripts have no filesystem/network/process access and have bounded source, execution time, and expanded-operation budgets. External preparation may produce inputs, but live mutations still use the supported interface.

## Coordinates and geometry

ForeScene is Y-up, in meters. Positions are `[x,y,z]`, dimensions are `[X width,Y height,Z depth]`, and Euler rotations are **degrees**.

- Prefer `scene.createCentered` when position must mean geometric center.
- Legacy `scene.create` is primitive-dependent: floor Y is the top surface, upright primitives use bottom/floor contact, and ordinary boxes use center placement.
- Stored transforms and shot/keyframe overrides are not automatically foot positions. Check actual transformed bounds and floor contact.
- Current rendering auto-plants imported models tagged `person` or `prop` onto the world floor. That can override a held or bench-supported prop's authored elevation. For an elevated import, use the supported `stagingRole: "set"` exemption, retain its actual story role in the production mapping, and verify the render and contact. Do not compensate with invented transform offsets or count the semantic role as automatically validated.
- Preserve imported model-local pivots separately from scene-instance positions. A duplicated instance may receive a placement offset; its world transform is not the asset-local bounds offset. Set explicit duplicate transforms when exact co-location is intended, then verify the posed/rendered result.
- Use `architecture.level/slab/wall/opening/room` for story elevations and segmented openings. Lay out the intended geography yourself; helpers handle geometry bookkeeping rather than choosing the set design.
- Use stateful `bounds`, `distance`, `intersects`, `nearest`, `placeOn`, `align`, and `lookAt` instead of guessing transformed extents. Bounds are AABBs: intersection findings still need interpretation for intended contact.

## Review loop

With MCP, inspect existing geometry, compile a script, validate the proposed plan, and capture its top/isometric views before applying. Fix unexpected support, story-axis, opening, stair-clearance, and intersection errors. `project_apply` rejects newly introduced spatial errors unless an explicit `allowSpatialErrors` override is supplied; reserve that for explained intentional geometry, not unexplained failures.

With CLI, inspect the working project, preview the plan, inspect its diagnostics/diff, and apply only within the authorized working copy. Treat ignored-field warnings as unapplied requirements: current `object.update` accepts `color`, but does not accept `surfaceStyle`; setting color alone does not switch a default clay object to solid. Preserved source-model materials remain an available route for authored color. Verify resulting geometry and canonical shot renders using available supported operations. Do not invent a CLI counterpart for a tool exposed only by MCP.

Shot and keyframe overrides may omit values equal to their inherited defaults. Resolve effective state as base object → shot override → keyframe override. When changing a base value such as visibility, explicitly restage the intended value in affected shots/keyframes; a previously omitted `true` does not protect a shot after its base becomes `false`. Author base/shot staging before the timeline or keyframe overrides. In current observed timeline replacement, a keyframe `visible: false` matching the base object can be omitted even when the shot override is `true`. For a newly authored animated object, keep base and shot visibility defaults consistent, put its visibility changes in the keyframes, and verify the resolved on→off transition in a fresh inspect and render. Command order alone is not evidence that a visibility transition survived normalization. Check both intended appearances and unintended visibility in neighboring shots.

After substantial changes, check actual shot framing, essential contact, occlusion and action in rendered evidence. Numeric spatial validation cannot approve storytelling. Save/reopen at a coherent checkpoint; fix shared causes once and rerender affected shots. Continue through the authorized scope unless a real blocker or requested review checkpoint requires user input.

If a new CLI session recovers an older revision after a reported successful apply, stop downstream rendering, retain the diagnostic evidence, and restore from the last verified versioned checkpoint through supported open/plan operations. Verify the intended fields after the next session opens before replacing the checkpoint; a success envelope alone does not prove persistent state.
