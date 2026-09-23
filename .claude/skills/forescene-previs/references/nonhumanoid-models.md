# Proxy-to-replacement-object workflow

Use this process when any nonhumanoid final asset replaces an existing proxy. It applies to retained projects; do not reset the project to perform the replacement.

1. Inspect and record the proxy object ID and every shot that stages or animates it.
2. Import the supplied model with the source-preserving default and record all returned object/source-asset IDs. Use `--mode separate` or `combined` to match the intended selection granularity.
3. Copy the proxy’s base scene transform to the real model.
4. Copy every proxy shot override to the real model.
5. Set the proxy visibility to `false` and real-model visibility to `true` in each affected shot.
6. Copy timeline/keyframe transforms and visibility where applicable.
7. Rerender every affected shot and compare its before/after frames.
8. Write or update `artifacts/previs/refinement/nonhumanoid-replacements.json`.

```json
{
  "proxyId": "obj_proxy",
  "replacementId": "obj_replacement",
  "affectedShots": ["12", "13", "14"],
  "commandsApplied": 18,
  "rerenderedShots": ["12", "13", "14"],
  "beforeAfterReviews": [
    { "shotNumber": "12", "before": "reviews/12-before.png", "after": "reviews/12-after.png", "approved": true }
  ]
}
```

A replacement log with zero `commandsApplied` or zero `affectedShots` is a failure, not a successful refinement. A visible proxy cannot count as the final replacement asset. The batch review must confirm the replacement asset is visible in every required shot.

## Current import contract

`agent:import-model` preserves source bytes, hierarchy, supported materials/textures, skins, morphs, and animation data by default. It does not create texture-free graybox geometry unless `--preservation graybox` is explicitly selected. Separate selections reference one shared source asset. Supply companions using repeatable `--resource <path>` or a self-contained asset; missing resources are errors, not permission to silently strip textures or fetch arbitrary external files.

```bash
npm run agent:import-model -- --file assets/creature.glb --preservation preserve --mode combined --profile ./working-profile --write
```

Source clips and cameras being preserved does not imply a new animation/camera editing interface. Humanoid semantic posing still uses the dedicated character importer; a normal source-model import is not proof of `.fsrig` pose support. Appearance overrides can be reversed without changing source bytes; do not invent a `source` mode for `agent:frame`, whose documented modes remain clay/projected/depth.

Read `docs/source-preserving-import.md` in the ForeScene checkout for format support and limits. Verify source-node bindings, appearance, and portable save/reopen when the replacement depends on them. Existing heavy/extreme import consent and safety limits still apply.
