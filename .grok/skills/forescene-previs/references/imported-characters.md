# Imported characters

`PrevisProductionManifestV1.cast` currently accepts only `type: "human_dummy"`. Imported-rig characters are supported by the Agent API, but they are not yet direct manifest cast entries. Never claim that a supplied GLB or FBX is automatically bound to a manifest cast ID.

## Analyze and import

Analyze first:

```bash
npm run agent:analyze-character -- \
  --file path/to/actor.glb
```

Then import with explicit write access:

```bash
npm run agent:import-character -- \
  --file path/to/actor.glb \
  --rig-mode auto \
  --name "Actor Name" \
  --write
```

For heavy assets, provide the explicit consent token requested by the import budget:

```bash
--consent-token <explicit-token>
```

Rig modes:

- `auto`: preserve when skeleton, skinning, mapping, and confidence pass; otherwise use ForeScene’s autorig route.
- `preserve`: require an existing compatible rig.
- `autorig`: ignore the source rig and use ForeScene’s autorig route.

## Recommended autonomous workflow

Because project reset can delete previously imported characters:

1. Build/reset the production-manifest project first.
2. Complete initial dummy-cast previs.
3. Import custom rigged characters afterward.
4. Use them for selected manual or Agent-authored refinement shots.
5. Retain dummy objects as spatial stand-ins until replacement tooling exists.
6. Keep the manifest cast entries as `human_dummy` and document the imported object IDs separately.

Do not automatically hide every dummy and reproduce its transforms with imported characters across every shot. Without a supported cast-replacement operation, that workaround is fragile and can silently break continuity.

After import, inspect the created object, apply a semantic pose, render a test clay frame, and reload the project to confirm persistence. Character import participates in `waitForIdle` and blocks overlapping plan, reset, package, and video work until it completes or is cancelled.
