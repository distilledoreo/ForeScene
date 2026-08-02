# Imported-character workflow

Imported rigs are Agent-accessible, but they are not direct `PrevisProductionManifestV1.cast` entries. Keep the initial manifest dummy-only and use this workflow for a selected refinement character.

1. Run the dummy-cast previs and save its package:

   ```bash
   npm run agent:previs -- \
     --manifest .grok/skills/forescene-previs/examples/dialogue-motion.json \
     --url https://ForeScene.distilledlabs.org \
     --write \
     --reset-project \
     --output artifacts/imported-character-previs
   npm run agent:package -- --url https://ForeScene.distilledlabs.org --write --output artifacts/imported-character-previs/package.zip
   ```

2. Analyze a small Mixamo GLB:

   ```bash
   npm run agent:analyze-character -- \
     --url https://ForeScene.distilledlabs.org \
     --file path/to/mixamo-actor.glb
   ```

3. Import it with automatic rig selection:

   ```bash
   npm run agent:import-character -- \
     --url https://ForeScene.distilledlabs.org \
     --file path/to/mixamo-actor.glb \
     --rig-mode auto \
     --name "Mixamo Actor" \
     --write
   ```

   Add `--consent-token <explicit-token>` when the asset exceeds the device-aware import budget.

4. Run `agent:inspect` and identify the created object and its capabilities. Do not rewrite the manifest cast or claim automatic cast binding.
5. Identify the generated shot and imported object IDs from `agent:inspect`, then save this plan as `artifacts/imported-character-previs/pose-plan.json` after replacing the two placeholders:

   ```json
   {
     "version": 1,
     "planId": "pose-imported-character",
     "commands": [
       {
         "op": "shot.stageObject",
         "shot": { "id": "<shot-id>" },
         "object": { "id": "<imported-object-id>" },
         "posePreset": "standing-alert"
       }
     ]
   }
   ```

   Apply it with explicit write access:

   ```bash
   npm run agent:apply -- \
     --plan artifacts/imported-character-previs/pose-plan.json \
     --url https://ForeScene.distilledlabs.org \
     --write
   ```

6. Render a test clay frame:

   ```bash
   npm run agent:frame -- \
     --url https://ForeScene.distilledlabs.org \
     --shot <shot-id> \
     --output artifacts/imported-character-previs/import-test.png
   ```

7. Reload or re-open the project, inspect again, and verify that the imported character remains poseable.
8. Export the selected refinement package. Retain the dummy objects as spatial stand-ins for shots that still come from the production manifest.
