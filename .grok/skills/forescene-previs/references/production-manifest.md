# Production manifest (skill reference)

See also `docs/previs-production-manifest.md` and `src/engine/previs/manifest.ts`.

Required top-level fields:

- `version: 1`
- `project.name`, `project.aspectRatio`
- `locations[]` with `id`, `name`, `template`
- `cast[]` with `id`, `name`, `type: "human_dummy"`
- `shots[]` with exact `shotNumber`, `name`, `description`, `locationId`, `subjects`, `camera`

Optional: `props[]`, per-shot `blocking`, `requirements`.

Location templates: `empty_stage`, `interior_room`, `corridor`, `ruins`, `armory`, `exterior_courtyard`.

Do not use `custom_blueprint` in the MVP.
