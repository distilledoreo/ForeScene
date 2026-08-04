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
      "id": "lead",
      "type": "imported_character",
      "source": "./characters/lead-actor.glb",
      "rigMode": "preserve-existing"
    }
  ],
  "shots": [
    {
      "id": "lead-medium",
      "shotNumber": "010",
      "name": "Lead medium",
      "description": "The lead holds a guarded stance.",
      "locationId": "room",
      "subjects": ["lead"],
      "camera": { "template": "medium", "subjects": ["lead"] }
    }
  ]
}
```

This is a **Greenfield-only** example because it creates the room and shot from
the manifest. Run it only when the current project is disposable or the user
explicitly asked to rebuild it. For a project that already has useful sets,
panoramas, shots, cameras, or continuity work, use the project-preserving
incremental import and staging workflow in
[existing-project-refinement.md](../references/existing-project-refinement.md)
instead; do not add `--reset-project`.

Run the authorized Greenfield operation:

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
the same output reuses successful `cast.<id>` mappings. Use
`--update-manifest --reset-project` after changing a source or cast definition
only while this explicitly authorized Greenfield project remains disposable;
otherwise use the incremental project-preserving workflow.

The standalone `agent:analyze-character` and `agent:import-character` commands
remain available for importing a character into an already-authored project
that is not driven by a production manifest.
