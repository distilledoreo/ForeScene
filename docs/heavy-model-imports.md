# Heavy 3D model imports

ForeScene classifies model imports as **standard**, **heavy**, **extreme**, or **rejected** from estimated bytes rather than a fixed vertex count. Standard imports proceed normally. Heavy imports pause for an explicit “Import heavy scene” action. Extreme imports are desktop-only by default and additionally require typing `IMPORT`. “Allow heavy imports” is off by default.

The report shows source size, loaded vertices and triangles, mesh and instance counts, estimated packed/project size, estimated peak JavaScript heap, estimated GPU geometry, and the ten largest source meshes. These are conservative heuristics; browsers do not expose exact free RAM. A file can still be rejected when a typed array, 32-bit index, packed asset, project-storage, or device memory ceiling would be exceeded.

FBX and DCC vertex counts often differ because ForeScene reports loaded buffer vertices. Exporters may split vertices at hard edges, UV seams, material boundaries, or mirrored transforms; instances may also expand in ForeScene’s flattened graybox representation.

New imported geometry is stored as binary data in IndexedDB and referenced by a stable key in project JSON. Saving a project with model geometry creates a `.fsp` ZIP containing `project.json` and its binary mesh assets. Opening the package restores those assets for offline use. Legacy `.panoref-project` and transitional `.forescene-project` packages use the same layout and remain importable. Existing base64-backed JSON projects still open and are migrated to binary entries when next saved. A missing binary produces a visible placeholder with a recoverable error instead of silently disappearing.

ForeScene preserves triangle geometry, node names and paths, world placement, negative-scale winding, and the chosen separate/combined mode. It strips materials, textures, cameras, lights, animation, rigs, and morph targets. To reduce a scene before import, remove hidden/unneeded meshes, delete construction history, merge genuinely static pieces, replace repeated expanded objects with instancing, and export only the required set.

Large imports increase conversion time, RAM/GPU use, project size, save/load time, and browser-tab crash risk. Cancellation is safe before project commit; no partial scene objects are added.

## Developer reference

The centralized policy lives in `src/engine/modelImportBudget.ts`. Let `P` be output position bytes, `I` output index bytes, `UP/UI` unique loader-owned position/index bytes, and `N=P` estimated normal bytes.

- packed binary = `40 + P + I + N` (format v2 persists normals; legacy v1 computes them after decode)
- transformation buffer = `P`
- combined temporary = `P + I` in combined mode, otherwise zero
- legacy base64 overhead = `ceil(packed / 3) * 4`; zero for new binary assets
- estimated peak heap = `UP + UI + transformation + combined temporary + packed + base64`
- estimated GPU geometry = `P + I + N`
- project storage = `packed + 1024 + 256 * meshNodeCount`

The device safety budget is `min(20% * navigator.deviceMemory, 1536 MiB desktop / 384 MiB mobile)`. With no signal ForeScene assumes 4 GB desktop or 2 GB mobile. Standard is at most 35% of the safety budget, heavy at most 65%, and extreme at most 100%. Mobile extreme imports reject unless a developer override is supplied. Hard ceilings are 768 MiB per packed asset, 1 GiB estimated project asset storage, `0x7fffffff` bytes per typed array, `0xffffffff` addressable vertices, and the device safety budget.

Conversion uses an `AbortSignal`, stage callbacks, and event-loop yields between large mesh batches. Combined conversion calculates global bounds without `worldPositionsPerUnit`, then writes centered positions directly into the final combined arrays. Binary writes happen before the atomic store insertion and are removed if a write is aborted. Orphaned binary blobs are pruned safely when a project is saved, preserving undo/redo until then.

Known browser limits: `navigator.deviceMemory` is coarse and unavailable in some browsers; IndexedDB quotas vary; WebGL does not expose a reliable free-GPU-memory value; loaders themselves may temporarily retain decoded source buffers. ForeScene therefore deliberately estimates conservatively.
