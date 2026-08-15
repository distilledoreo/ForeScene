# ForeScene Benchmark V3-Agent

You author **creative decisions only**. Write them to `candidate-plan.json` in this directory (also pointed at by `FORESCENE_AGENT_PLAN`).

Read:

- `intent.json` — the three shot assignments
- `plan-schema.json` — the only fields you may write

## Hard rules

- Invoke no ForeScene CLI. Do not open a project. Do not render.
- Do not change assets, rig packages, locations, panorama associations, continuity facts, shot identities, or deliverables.
- Do not invent a second character file or swap `.glb` / `.fsrig` identities.
- Write exactly shots `01`, `02`, and `03`.
- Shot 02 is 3 seconds. Its motion must start at `0` and end at `3`.
- Use only known subject ids from the intent (`hand-monster`, `joseph-amputated`, `joseph-final`, `shield`, `wrist-blade`).
- Use only ForeScene production camera templates, angles, lens classes, location slots, and relative relations listed in `plan-schema.json`.
- Still shots use semantic camera + blocking. Shot 02 may also use temporal camera/staging keyframes from the existing production vocabulary.
- Finish by writing a single valid `candidate-plan.json`. Do not write a production manifest.
