# Imported-character workflow

Declare imported rigs in the production manifest so the cast and shots resolve
in one operation:

```json
{
  "version": 1,
  "project": { "name": "Imported dialogue", "aspectRatio": "16:9" },
  "locations": [
    { "id": "room", "name": "Room", "template": "interior_room" }
  ],
  "cast": [
    {
      "id": "joseph",
      "type": "imported_character",
      "source": "./characters/joseph.glb",
      "rigMode": "preserve-existing"
    }
  ],
  "shots": [
    {
      "id": "joseph-medium",
      "shotNumber": "010",
      "name": "Joseph medium",
      "description": "Joseph holds a guarded stance.",
      "locationId": "room",
      "subjects": ["joseph"],
      "camera": { "template": "medium", "subjects": ["joseph"] }
    }
  ]
}
```

Run the normal production operation:

```bash
npm run agent:previs -- \
  --manifest path/to/imported-dialogue.json \
  --url https://ForeScene.distilledlabs.org \
  --write \
  --reset-project \
  --output artifacts/imported-character-previs
```

`agent:previs` stages each declared file through the browser, analyzes it,
imports it using the requested rig mode, and records the resolved object under
`cast.<id>` in `run-state.json` before compiling shots. Imported `name` defaults
to the cast ID. Inspect `logs/scene-cast.json` for per-character analysis and
import results.

If one source fails, the cast phase stops before shot compilation. Re-running
the same output reuses successful `cast.<id>` mappings; use
`--update-manifest --reset-project` after changing a source or cast definition.

The standalone `agent:analyze-character` and `agent:import-character` commands
remain available for importing a character into an already-authored project
that is not driven by a production manifest.
