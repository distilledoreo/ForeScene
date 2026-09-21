# Agent scripting layer

The scripting layer is ForeScene's high-bandwidth procedural automation path. It exists for work that is awkward to express as hundreds of hand-authored Agent Plan commands: repeated architecture, patterned blocking, bulk transforms, generated shot structures, and other algorithmic edits.

The script does **not** mutate the live project. ForeScene gives it a read-only serialized project snapshot and helper APIs. The script emits ordinary Agent Plan commands. ForeScene then runs the same plan preview, validation, fingerprint check, atomic transaction, persistence, recovery, history, and undo path used by `agent:apply`.

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
- `scene`: `list`, `find`, `findAll`, `require`, `create`, `update`, `delete`, `duplicate`.
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

Plan-local refs returned by `scene.create`, `scene.duplicate`, `shots.create`, and `landmarks.create` can be used by later commands in the same script.

## Boundaries

The VM context does not expose Node's `process`, `require`, filesystem APIs, network APIs, or dynamic string code generation. Source size is capped at 128 KiB, execution is time-bounded, and emitted command count is capped by the standard Agent Plan limit.

This is defense in depth for locally generated or otherwise trusted agent scripts. Node's VM is **not** treated as a hardened hostile-code or multi-tenant security boundary. Do not accept arbitrary third-party scripts and execute them as trusted automation.

The authoritative safety boundary remains the generated Agent Plan: unsupported operations, invalid values, stale project fingerprints, and invalid targets are rejected by ForeScene's existing plan compiler before any live mutation occurs.
