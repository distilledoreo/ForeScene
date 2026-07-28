# SetBlueprint

SetBlueprint is an AI-facing spatial blocking format used to generate Continuity Stage graybox sets. It is intentionally smaller than `LocationProject`: models emit blocking primitives; PanoRef compiles them into a native project with IDs, shots, and settings.

## Coordinate system

- Units: meters
- Y-up
- Positive Z is the default forward direction from the capture origin
- Object positions in the blueprint are ground-plane friendly (`Y ≈ 0`); the compiler seats geometry:
  - Floors: top surface at `Y = 0`
  - Upright walls, columns, doors, arches, stairs, people, trees, backdrops: bottom on the floor
  - Other types (box props, sun markers, terrain): use the provided center position

## Supported primitives

`floor`, `wall`, `box`, `arch`, `doorway`, `column`, `stairs`, `tree_blob`, `terrain_mass`, `background_card`, `human_dummy`, `sun_marker`

`imported_model` is **not** legal in v1 — an LLM cannot manufacture the corresponding mesh asset.

## Limits

| Limit | Value |
| --- | --- |
| Objects | 1–250 |
| Landmarks | 0–100 |
| Position magnitude | ±500 m per axis |
| Dimensions | 0.01–1000 m |
| Extreme scale | warned below 0.05 or above 20 (not auto-corrected) |

## Schema (version 1)

```ts
interface SetBlueprint {
  schemaVersion: 1;
  name: string;
  description?: string;
  units: 'meters';
  panoOrigin?: [number, number, number];
  panoRotation?: [number, number, number];
  objects: SetBlueprintObject[];
  landmarks?: SetBlueprintLandmark[];
  assumptions?: string[];
}
```

Excluded from blueprint output (native project concerns only):

- Native PanoRef IDs and timestamps
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
5. **Create generated project** — current work is snapshotted first under Project Safety & Recovery.

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
| Validation | `parseSetBlueprint` | `parseProject` / `readProjectFile` |
| Result | New project compiled from primitives | Opens the saved document as-is |
| Assets / panos | Always empty after compile | Preserved |

## Sample system prompt

The authoritative prompt lives in `src/engine/setBlueprintPrompt.ts` (`buildSetBlueprintSystemPrompt`). It is generated from the same primitive allowlist and limits as the validator so the two cannot quietly drift.

## Example blueprint

See `tests/fixtures/setBlueprints.ts` (`trainStationBlueprint`, `complexSetBlueprint`, `minimalSetBlueprint`).

```json
{
  "schemaVersion": 1,
  "name": "Minimal Floor",
  "units": "meters",
  "objects": [
    {
      "key": "floor_1",
      "name": "Ground",
      "type": "floor",
      "position": [0, 0, 0],
      "dimensions": [8, 0.08, 6]
    }
  ]
}
```

## Out of scope for v1

Merging into an existing set, conversational per-object regen, automatic architecture repair, custom mesh generation, image-to-set, multi-floor procedural buildings, AI-authored shots/panoramas, and persistent chat history.
