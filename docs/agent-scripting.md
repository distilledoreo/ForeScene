# Agent scripting layer

The scripting layer is ForeScene's high-bandwidth procedural automation path. It exists for work that is awkward to express as hundreds of hand-authored Agent Plan commands: repeated architecture, patterned blocking, bulk transforms, generated shot structures, and other algorithmic edits.

The script does **not** mutate the live project. It runs against an isolated **transactional shadow project**. Helper mutations update that shadow immediately, so later statements in the same script can query, measure, align, and branch on the state they just created. At the end, the script emits ordinary Agent Plan commands. ForeScene then runs the same plan preview, validation, fingerprint check, atomic transaction, persistence, recovery, history, and undo path used by `agent:apply`.

## CLI

Preview a script without changing the project:

```bash
npm run agent:script -- \
  --file scripts/examples/colonnade.js \
  --profile ./tmp/forescene-profile \
  --output artifacts/colonnade.plan.json
```

Apply the exact compiled plan:

```bash
npm run agent:script -- \
  --file scripts/examples/colonnade.js \
  --profile ./tmp/forescene-profile \
  --output artifacts/colonnade.plan.json \
  --write
```

Optional flags:

- `--expected-revision <id>` adds the same compare-and-swap revision gate used by `agent:apply`.
- `--script-timeout <ms>` changes the execution budget. It is capped at 5000 ms.
- `--output <path>` writes the compiled Agent Plan for review/replay.

## Script environment

Available globals:

- `project`: deeply frozen read-only project snapshot.
- `scene`: stateful query/mutation helpers plus spatial and bulk operations.
  - Query: `list`, `find`, `findAll`, `require`.
  - Mutation: `create`, `createCentered`, `createMany`, `update`, `updateMany`, `delete`, `duplicate`, `duplicateMany`.
  - Spatial: `bounds`, `distance`, `intersects`, `nearest`, `placeOn`, `align`, `lookAt`, `distribute`.
  - Procedural arrays: `linearArray`, `radialArray`.
- `architecture`: semantic, non-template helpers for spatial construction.
  - `level({ id?, name, elevation, height })` declares a story coordinate frame.
  - `slab({ level, width, depth, thickness?, center?, role? })` creates a correctly oriented floor/ceiling slab.
  - `opening({ kind, offset, width, height, sillHeight? })` declares a bounded door/window opening.
  - `wall({ level, from:[x,z], to:[x,z], openings? })` creates one continuous wall plus overlapping opening objects. The shared relationship resolver cuts the wall non-destructively; agents do not calculate wall segments around openings.
  - `room({ level, boundary:[[x,z],...], openingsByEdge? })` builds an arbitrary polygon wall loop; it does not choose a room shape for the agent.
  - `placeOnLevel(object, level, { x?, z?, gap? })` grounds content on a declared story.
- `shots`: `list`, `find`, `findAll`, `require`, `create`, `rename`, `describe`, `camera`, `frameSubjects`, `stage`, `clearStaging`, `delete`.
- `landmarks`: `list`, `find`, `findAll`, `require`, `create`, `update`, `link`, `delete`.
- `target`: helpers for explicit `id`, plan-local `ref`, `shotNumber`, or query targets.
- `workspace.open(...)`.
- `plan.description(...)` and `plan.command(...)` for direct access to any existing Agent Plan operation.

Normal JavaScript control flow is available: loops, functions, arrays, objects, Math, conditionals, and local variables.

Example:

```js
plan.description('12-column radial layout');

const radius = 8;
const count = 12;

for (let i = 0; i < count; i += 1) {
  const angle = (i / count) * Math.PI * 2;
  scene.create('column', {
    name: `Column ${i + 1}`,
    position: [Math.sin(angle) * radius, 0, Math.cos(angle) * radius],
    rotation: [0, angle, 0],
    dimensions: [0.7, 5, 0.7],
  });
}

workspace.open('build');
```

An existing object can be queried and duplicated procedurally:

```js
const chair = scene.require({ name: 'Chair', match: 'exact' });

for (let i = 0; i < 20; i += 1) {
  scene.duplicate(chair, {
    updates: {
      name: `Chair ${i + 1}`,
      transform: {
        position: [i * 0.8, 0, 0],
      },
    },
  });
}
```

Plan-local refs returned by `scene.create`, `scene.duplicate`, `shots.create`, and `landmarks.create` can be used by later commands in the same script. Newly created and edited entities are also immediately visible through `project`, `scene.list()`, `scene.find()`, and spatial helpers.

### Stateful shadow example

```js
const table = scene.create('box', {
  name: 'Table',
  position: [0, 0.5, 0],
  dimensions: [2.2, 1, 1.1],
});

const lamp = scene.create('box', {
  name: 'Lamp',
  position: [0, 0, 0],
  dimensions: [0.3, 0.6, 0.3],
});

scene.placeOn(lamp, table, { gap: 0.02 });

const liveLamp = scene.require({ name: 'Lamp' });
const gap = scene.distance(liveLamp, table);
if (gap > 0.021) throw new Error('Lamp placement drifted');
```

The live project is still unchanged during this script; only the shadow document changed.

### Coordinate and placement contract

ForeScene is **Y-up** and uses meters:

- position: `[x, y, z]`
- dimensions: `[width along X, height along Y, depth along Z]`
- rotation: Euler `[x, y, z]` in **degrees**

For new agent-authored geometry, prefer `scene.createCentered(...)` when you want the supplied position to always mean the object's center. Raw `scene.create(...)` retains legacy primitive-specific placement semantics: floors treat Y as the requested top surface, upright primitives treat Y as bottom/floor contact, and ordinary boxes use center placement.

For substantial architecture, prefer `architecture.level/slab/wall/opening/room` so story elevations and relationships are deterministic.

### Semantic cutters and relationships

- **Doorway:** a doorway is visible portal/frame geometry plus a bounded wall cutter. Place it so the doorway volume overlaps one compatible wall. ForeScene derives the opening non-destructively. Ambiguous multi-wall overlaps are reported instead of guessed.
- **Stairs:** stairs define a bounded clearance volume above the upper run. Eligible horizontal floor/slab/ceiling geometry inside that volume is cut automatically. ForeScene does **not** erase walls, props, or arbitrary geometry in the stair clearance; those overlaps are reported for review.
- **Intersections:** substantial overlaps are classified by whether a host/cutter relationship, shared assembly, support contact, or normal wall junction explains them. Unexplained substantial overlaps are surfaced for investigation rather than blindly rejected.
- Cutter effects follow the live transforms, so moving a doorway/stair or its host updates the effective geometry without destructive mesh edits.

### Spatial helpers

`scene.bounds(object)` returns a world-space AABB with `min`, `max`, `size`, and `center`. Bounds account for object dimensions, scale, and Euler rotation.

`scene.distance(a, b)` returns the separation between world AABBs (zero when touching/intersecting). `scene.intersects(a, b)` tests AABB overlap. `scene.nearest(query, position)` finds the matching object closest to a point.

`scene.placeOn(object, surface, { gap })` moves an object so its lower world bound rests on the surface's upper bound. `scene.align(...)` aligns min/center/max bounds on one axis. `scene.lookAt(...)` solves yaw toward the target. `scene.distribute(...)` performs deterministic center spacing.

### Bulk operations

Bulk helpers compile to three bounded Agent Plan operations: `object.createMany`, `object.updateMany`, and `object.duplicateMany`. One top-level plan command can therefore represent hundreds of deterministic object edits while the validator still enforces an expanded-operation budget.

```js
const column = scene.create('column', {
  position: [0, 0, 0],
  dimensions: [0.6, 4, 0.6],
});

scene.radialArray(column, {
  count: 120,
  radius: 14,
  center: [0, 2, 0],
  faceCenter: true,
  namePrefix: 'Perimeter Column',
});
```

A plan may contain at most 200 top-level commands, each bulk operation may contain at most 500 items, and the fully expanded plan may contain at most 2,000 object operations.

## Boundaries

The VM context does not expose Node's `process`, `require`, filesystem APIs, network APIs, or dynamic string code generation. Source size is capped at 128 KiB, execution is time-bounded, and emitted command count is capped by the standard Agent Plan limit.

This is defense in depth for locally generated or otherwise trusted agent scripts. Node's VM is **not** treated as a hardened hostile-code or multi-tenant security boundary. Do not accept arbitrary third-party scripts and execute them as trusted automation.

The authoritative safety boundary remains the generated Agent Plan: unsupported operations, invalid values, stale project fingerprints, invalid targets, bulk-size violations, and expanded-operation budget violations are rejected by ForeScene's existing plan compiler before any live mutation occurs.

`plan.command(...)` remains an advanced escape hatch. It is emitted into the final plan, but arbitrary raw commands are not interpreted back into the shadow model. Use the typed `scene`, `shots`, and `landmarks` helpers when later script statements need to observe the mutation.


## Semantic cutter relationships

ForeScene resolves certain overlaps into non-destructive relationships before rendering, inspection, validation, coverage analysis, and export-oriented rendering:

- **Doorway → wall:** a doorway overlapping exactly one compatible wall automatically becomes a hosted portal and cuts only the bounded doorway volume through that wall. Do not split a continuous wall just to manufacture a door gap. If multiple compatible walls overlap the doorway, ForeScene reports ambiguity instead of guessing.
- **Stairs → upper floor/slab:** stairs carry a bounded clearance volume above the top landing. The nearest eligible horizontal floor/slab layer intersecting that clearance is cut automatically within the stair footprint. Walls and unrelated geometry are never silently deleted.
- **Other intersections:** validation classifies known host/cutter relationships, same assemblies, supports, and ordinary wall junctions as explained. Substantial remaining overlaps are surfaced for investigation rather than blanket-rejected.

These cuts are derived from authored primitives; moving or deleting the doorway/stairs immediately moves or removes the effective opening without baking destructive mesh edits.

## Recommended spatial-authoring loop

For substantial scene construction, the remote MCP surface is designed for this loop:

1. Read `agent_reference`.
2. Inspect existing geometry with `scene_inspect`.
3. Build with `project_script`, preferring semantic architecture helpers where relevant.
4. Run `scene_validate`.
5. Inspect `scene_capture({ view: "top" })` and `scene_capture({ view: "isometric" })`.
6. Correct issues and repeat validation/capture.
7. Call `project_apply` only after the preview is spatially coherent.

This workflow constrains bookkeeping and physical consistency, not creative layout decisions.
