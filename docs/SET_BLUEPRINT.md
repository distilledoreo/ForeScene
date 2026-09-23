# SetBlueprint

SetBlueprint is an AI-facing spatial blocking format used to generate ForeScene graybox sets. It is intentionally smaller than `LocationProject`: models emit blocking primitives; ForeScene compiles them into a native project with IDs, shots, and settings.

## Coordinate system

- Units: meters
- Y-up
- Positive Z is the default forward direction from the capture origin
- Version 2 uses the uniform object-center coordinates of `scene.createCentered`: `position` is the center of every primitive, including floors, walls, doorways, stairs, and people. Dimensions are `[X width, Y height, Z depth]`; rotations are Euler angles in degrees.
- For a ground floor with thickness `h` and top at Y=0, use center Y=`-h/2`. For a ground-level upright object of height `h`, use center Y=`h/2`. Add the story elevation for upper levels.
- Version 1 blueprints remain readable with their legacy placement rule: floor Y is the top surface, upright Y is the bottom, and other object positions are centers. The parser preserves the version so existing blueprints keep those coordinates.

## Supported primitives

`floor`, `wall`, `box`, `arch`, `doorway`, `column`, `stairs`, `tree_blob`, `terrain_mass`, `background_card`, `human_dummy`, `sun_marker`

`imported_model` is **not** legal in either version — an LLM cannot manufacture the corresponding mesh asset.

## Doorways and stairs

- Place a `doorway` so its volume overlaps a continuous `wall` with matching yaw. The scene relationship resolver cuts a bounded opening through that wall. Keep the wall continuous rather than manually segmenting it around the doorway.
- If several compatible walls overlap the doorway, set `hostWallKey` to the `key` of the intended wall. The key must resolve to a wall in the same blueprint. The compiler stores the resolved native wall ID; moving either object keeps the cut live.
- A standalone `arch` is visible geometry and does not cut a wall. Use a `doorway` for a semantic portal.
- A `stairs` object cuts the nearest eligible upper floor or slab within its clearance footprint. Set `clearanceAboveMeters` to adjust headroom; the default is 2.1 m. Walls and props are never removed by the stair clearance.
- Review reports unhosted or ambiguous doorways and stairs with no eligible upper layer as warnings. The current spatial authoring checks also report unsupported thresholds and stair obstructions as warnings, and unexplained substantial overlaps as informational notes. Spatial errors such as a floor with its height on the wrong axis must be corrected before applying. The Agent API preserves error, warning, and info severity.

## Limits

| Limit | Value |
| --- | --- |
| Objects | 1–250 |
| Landmarks | 0–100 |
| Position magnitude | ±500 m per axis |
| Dimensions | 0.01–1000 m |
| Extreme scale | warned below 0.05 or above 20 (not auto-corrected) |
| Stair clearance | 0.1–6 m when supplied |

## Schema (version 2)

```ts
interface SetBlueprint {
  schemaVersion: 2;
  name: string;
  description?: string;
  units: 'meters';
  panoOrigin?: [number, number, number];
  panoRotation?: [number, number, number];
  objects: SetBlueprintObject[];
  landmarks?: SetBlueprintLandmark[];
  assumptions?: string[];
}

interface SetBlueprintObject {
  key: string;
  name: string;
  type: 'floor' | 'wall' | 'box' | 'arch' | 'doorway' | 'column' | 'stairs' |
    'tree_blob' | 'terrain_mass' | 'background_card' | 'human_dummy' | 'sun_marker';
  position: [number, number, number]; // object center, including floors and upright objects
  dimensions: [number, number, number];
  rotation?: [number, number, number]; // degrees
  scale?: [number, number, number];
  hostWallKey?: string; // doorway only; key of a wall in this blueprint
  clearanceAboveMeters?: number; // stairs only; 0.1–6
  stagingRole?: 'set' | 'prop' | 'person';
  surface?: { style: 'default' | 'solid' | 'checkerboard'; color?: string; secondaryColor?: string };
}
```

Excluded from blueprint output (native project concerns only):

- Native ForeScene IDs and timestamps
- Shots and camera keyframes
- Panorama references and assets
- Workflow state and export settings
- Imported models / binary data
- Product or native schema versions

## Manual paste workflow

1. Open **Build → More → Generate set from description**.
2. Fill the Describe tab and **Copy prompt for external model**.
3. Paste the prompt into any frontier model.
4. Switch to **Paste blueprint JSON**, paste the result, **Validate and review**.
5. Review hosted doorway and stair-cut counts plus any spatial diagnostics. Correct errors before applying.
6. **Create generated project** — current work is snapshotted first under Project Safety & Recovery.

If a model returns Markdown-style escapes such as `\[0, 1.65, 0]` or `hall\_floor`, the importer auto-repairs common cases (`\[` → `[`, `\]` → `]`, `\_` → `_`), retries parse, and shows a warning. Unrepaired invalid escapes report the exact line/column instead of a generic “markdown fences” message.

## Provider configuration

| Mode | Behavior |
| --- | --- |
| Manual (default) | No network. Copy prompt / paste JSON. |
| HTTP | `VITE_SET_GENERATION_ENDPOINT` → POST; server holds credentials; response must be SetBlueprint JSON (or `{ "blueprint": … }`). |
| Validation repair | On failure, one retry sends diagnostics back to the endpoint; remaining errors are shown. |

Do not put a shared API key in the Vite application.

## Privacy

- Manual paste never leaves the browser except for whatever you paste into an external model yourself.
- HTTP generation sends only the prompt/request payload to your configured endpoint.
- Browser BYOK (user-supplied keys) is out of scope for the initial release; if added later, keys must stay in memory/session storage with a clear warning.

## Blueprint import vs native project import

| | SetBlueprint | Native project backup |
| --- | --- | --- |
| Entry | Build → Generate set | Header Open / Import |
| Contents | Spatial blocking only | Full `LocationProject` |
| Validation | `parseSetBlueprint` plus spatial authoring checks | `parseProject` / `readProjectFile` |
| Result | New project compiled from primitives | Opens the saved document as-is |
| Assets / panos | Always empty after compile | Preserved |

## Sample system prompt

The authoritative prompt lives in `src/engine/setBlueprintPrompt.ts` (`buildSetBlueprintSystemPrompt`). It is generated from the same primitive allowlist and limits as the validator so the two cannot quietly drift.

## Example blueprint

The following uses current center coordinates. The fixtures in `tests/fixtures/setBlueprints.ts` also cover legacy version 1 imports.

```json
{
  "schemaVersion": 2,
  "name": "Minimal Floor",
  "units": "meters",
  "objects": [
    {
      "key": "floor_1",
      "name": "Ground",
      "type": "floor",
      "position": [0, -0.04, 0],
      "dimensions": [8, 0.08, 6]
    }
  ]
}
```

## Out of scope

Merging into an existing set, conversational per-object regen, automatic architecture repair, custom mesh generation, image-to-set, multi-floor procedural buildings, AI-authored shots/panoramas, and persistent chat history.
