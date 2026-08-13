# ForeScene Agent capability matrix

The **CLI is the canonical public automation surface**. Agents operating ForeScene
should use documented `npm run agent:*` commands. Do not inspect ForeScene source
or call `window.foreScene` for an operation this matrix marks as CLI-supported.

Query the live catalog without opening a browser:

```bash
npm run agent:capabilities
```

Stdout is a stable JSON envelope. `result.capabilities` is the compact boolean map:

```json
{
  "project.open": true,
  "project.save": true,
  "character.importSavedRig": true,
  "render.frame.projected": true,
  "render.video.projected": true
}
```

If a capability is `true`, use the documented command. Do not inspect its
implementation.

## Matrix

| Capability | Id | UI | Agent API | CLI | Skill documented | Stable |
| --- | --- | --- | --- | --- | --- | --- |
| Discover CLI capabilities | `agent.capabilities` | ❌ | ✅ | ✅ | ✅ | ✅ |
| Inspect project | `project.inspect` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Open .fsp / project package | `project.open` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Save / export project backup | `project.save` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cancel a running CLI operation | `operation.cancel` | ❌ | ✅ | ✅ | ✅ | ✅ |
| List CLI operations | `operation.list` | ❌ | ✅ | ✅ | ✅ | ✅ |
| Preview mutation plan | `project.previewPlan` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Apply plan | `project.applyPlan` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Analyze character | `character.analyze` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Import GLB character | `character.import` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Import .fsrig saved rig | `character.importSavedRig` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Import GLB / scene model | `model.import` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Import styled panorama | `panorama.import` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Replace proxy with imported model | `proxy.replace` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render clay frame | `render.frame.clay` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render projected frame | `render.frame.projected` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render depth frame | `render.frame.depth` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render clay video | `render.video.clay` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render projected video | `render.video.projected` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render depth video | `render.video.depth` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render review pass matrix | `render.passes` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Render stills batch | `render.stills` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Build contact sheet | `render.contactSheet` | ✅ | ❌ | ✅ | ✅ | ✅ |
| Capture UI screenshot | `screenshot.viewport` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Plan export deliverables | `export.plan` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Export package | `export.package` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Verify export package | `export.verifyPackage` | ❌ | ✅ | ✅ | ✅ | ✅ |
| Visual preflight | `verify.visualPreflight` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Asset pose contract | `verify.assetContract` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Verify project health | `verify.project` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Greenfield previs orchestration | `previs.orchestrate` | ❌ | ✅ | ✅ | ✅ | ✅ |
| Gated production runner | `production.orchestrate` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Preview + apply + screenshot | `pipeline.run` | ❌ | ✅ | ✅ | ✅ | ✅ |
| Optional existing-project refinement runner | `refine.existingProject` | ❌ | ✅ | ✅ | ✅ | ✅ |

## Rendering abstraction

Clay, projected, and depth are modes of one frame/video command:

```bash
npm run agent:frame -- --shot 01 --mode clay --output artifacts/01.clay.png
npm run agent:frame -- --shot 01 --mode projected --output artifacts/01.projected.png
npm run agent:frame -- --shot 01 --mode depth --output artifacts/01.depth.png
npm run agent:video -- --shot 03 --mode projected --write --output artifacts/03.mp4
```

`--appearance` remains a supported alias of `--mode` for render commands.

## Project open and save

```bash
npm run agent:open -- --file path/to/project.fsp --write
npm run agent:save -- --output artifacts/project.fsp --write
```

Open and save require `--write` or `--persist-write` because they replace or
export the live project through the protected Agent API.

## JSON contract

Every CLI command writes one JSON object to stdout:

| Field | Meaning |
| --- | --- |
| `ok` | Explicit success or failure |
| `operation` | Stable capability / operation name |
| `durationMs` | Wall time for this invocation |
| `projectId` / `revisionId` | Affected project identity when known |
| `affectedObjectIds` / `affectedShotIds` | Affected entities when known |
| `warnings` | Non-fatal diagnostics |
| `error` | `{ code, message }` on failure |
| `result` | Command-specific payload |

Exit codes: `0` success, `1` operation failure, `2` usage / argument error.

Human progress remains on stderr and is not part of the machine contract.
