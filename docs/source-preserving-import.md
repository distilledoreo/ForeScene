# Source-preserving imports

## Contract

The default import is non-destructive. `ProjectAsset.metadata.modelEncoding = "source"` selects the source loader; assets without this discriminator retain the legacy packed-graybox path. Existing projects need no destructive migration.

A self-contained file is stored byte-for-byte. A model with selected companion files is stored as one deterministic ZIP containing unmodified originals. An existing `.panoscene` bundle is retained unchanged. One source asset is referenced by every separate selection; portable `.fsp` packaging includes that binary once and checks its integrity when reopened.

`metadata.sourceModel` records the format/container, source SHA-256, entry path, bounds, stable child-index node paths, material/texture inventory, animation names, and required extensions. Child-index paths avoid ambiguous duplicate names and do not depend on Three.js runtime UUIDs. glTF material primitives are grouped under their authored node rather than split into unrelated ForeScene objects.

`SceneObject.sourceModelNodePath` selects one authored object; its absence selects the entire default scene. The runtime retains necessary ancestors and skeleton dependencies. Selection transforms use a ForeScene center-pivot wrapper while leaving original local transforms and source pivots intact. Source hierarchy is retained, not exposed as a general-purpose hierarchy editor.

## Appearance and lifecycle

`surfaceStyle: "source"` retains authored materials. Default clay, solid color, checkerboard, and panorama projection are runtime overrides. Returning to source restores the original materials. Source lights are disabled by default and can be enabled on complete-scene imports; ForeScene cameras remain authoritative.

Decoded templates share geometry, material, and texture resources. Scene instances have independent transforms, skeletons, and instance attributes. Reference-counted leases prevent disposing a live viewport's assets when an export or another scene closes. Idle templates are evicted. Immutable source bytes stay in the existing durable model store.

Interactive views subscribe to source readiness and show explicit loading/missing placeholders. Raster/depth export entrypoints await source hydration and validate saved node bindings. Invalid source dependencies fail instead of silently exporting a gray fallback. Projection coordinates and occlusion support instancing, morphs, and skins. Coverage analysis derives deformed/instanced geometry snapshots without modifying the source.

## Supported inputs and boundaries

- GLB/glTF 2.0: standard Three.js materials, textures, vertex colors, hierarchy, skins, morph targets and supported instancing. Draco, Meshopt and KTX2 use bundled decoders when needed. KTX2 needs a WebGL-capable browser.
- FBX: unchanged original bytes; Three.js interpretation of meshes, materials, bones and clips. Not a Maya/Arnold shader interpreter.
- OBJ with MTL and selected textures; STL; mesh/point PLY. Source formats cannot preserve information they never contained.
- `.panoscene` archives with current or legacy manifests, including external resources in their original folder structure.

No automatic fetching of external resources. Supply companion files together, or use a self-contained GLB/archive. Ambiguous filenames, missing resources, unsafe archive paths, unsupported required glTF extensions, and corrupted binaries are errors. Optional unsupported extension data remains in the source and is reported.

The default source scene is displayed; other scenes remain in the source. Animation clips, cameras, and metadata are retained, not given new timeline/camera editing interfaces. Humanoid semantic posing continues through the dedicated poseable-character importer. Native DCC project files and material graphs still require an export. Actual image appearance depends on ForeScene's lighting and supported renderer features.

Memory estimates include decoded textures, source storage, geometry, and scene instances. Existing heavy/extreme consent and hard safety limits remain. There is no hidden texture stripping, geometry simplification, or unlimited-VRAM guarantee.

## Verification

Focused unit coverage: exact source bytes; UVs/materials/morphs; multi-material grouping; independent transforms and bones; preserved instancing; source-light opt-in; non-destructive overrides; shared-resource disposal; fresh-runtime `.fsp` round trips; companion archives; missing/unsupported/corrupt input; node validation; explicit legacy import; projection coverage; reuse of all selections; rollback on persistence failure; CLI flags.

`tests/browser/sourceModelRender.test.ts` verifies textured pixels, identical pixels after a fresh-runtime portable reopen, material override cleanup, viewport and metric-depth exports, instanced/skinned projection and occlusion compilation, and explicit rejection of missing images.

`e2e/source-preserving-import.spec.ts` exercises manual import and appearance controls, verified reload recovery, fresh-context portable reopen, and Agent API companion-file/reuse parity.

Run:

```sh
npm run lint
npm run build
npx vitest run --config vitest.fast.config.ts tests/sourceModelImport.test.ts tests/sourceModelService.test.ts tests/modelImport.test.ts tests/agentCli.test.ts
npx vitest run --config vitest.browser.config.ts tests/browser/sourceModelRender.test.ts
npx playwright test e2e/source-preserving-import.spec.ts --project=desktop-chromium --workers=1
```

These commands require a browser with WebGL support for the last two gates. A blocked or unavailable browser is a validation limitation, not a passing test.
