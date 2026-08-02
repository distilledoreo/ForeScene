# Imported characters

`PrevisProductionManifestV1.cast` accepts both semantic mannequins and imported
characters. An imported entry is resolved as part of the same `agent:previs`
cast phase:

```json
{
  "id": "joseph",
  "type": "imported_character",
  "source": "./characters/joseph.glb",
  "rigMode": "preserve-existing"
}
```

`source` is resolved relative to the manifest file and must be a local GLB,
embedded glTF, or FBX. `name` is optional and defaults to the cast ID.
Supported modes are `preserve-existing`, `auto`, `autorig`, and `saved-rig`.
After import, the live object ID is persisted as `cast.joseph` in
`run-state.json`, and shot compilation uses that mapping directly.

### Matching saved rigs

Use `saved-rig` to import a model and its matching `.fsrig` or legacy `.panorig`
package as one cast entry:

```json
{
  "id": "joseph",
  "type": "imported_character",
  "source": "./characters/joseph.glb",
  "rigMode": "saved-rig",
  "rigPackage": "./characters/joseph.fsrig"
}
```

Both paths are explicit and relative to the manifest. The source and package
are hashed together with the import options. `agent:previs` runs a read-only
compatibility preflight before reset, checking package integrity, skin/bind
data, topology, vertex count, and preserved source skeleton where available.
Any mismatch fails the cast phase before reset and writes the diagnostics to
`logs/saved-rig-preflight.json`. A successful import records the source/package
hashes, `appliedSavedRig`, and `topologyVerified` in `logs/scene-cast.json` and
`run-state.json`.

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

For a new production, declare imported characters directly in the manifest:

1. Put the local character files at the paths declared by `cast[].source`.
2. Run `agent:previs` with the manifest and write/reset authorization.
3. Inspect the cast log and shot outputs.

If an imported source or saved-rig pair fails, the cast phase stops before shot
compilation. A retry reuses successful `cast.<id>` mappings only when the
recorded import fingerprint still matches. Change either file or the rig mode
with `--update-manifest --reset-project` when the existing scene must be rebuilt.

For older projects that still use a separate import command, project reset can
delete previously imported characters:

1. Build/reset the production-manifest project first.
2. Complete initial dummy-cast previs.
3. Import custom rigged characters afterward.
4. Use them for selected manual or Agent-authored refinement shots.
5. Retain dummy objects as spatial stand-ins until replacement tooling exists.

Do not mix the legacy separate-import flow with a manifest entry for the same
cast ID in one run; the manifest cast mapping is the source of truth.

After import, inspect the created object, apply a semantic pose, render a test clay frame, and reload the project to confirm persistence. Character import participates in `waitForIdle` and blocks overlapping plan, reset, package, and video work until it completes or is cancelled.
