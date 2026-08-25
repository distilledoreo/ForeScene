# Generative-world boundary

ForeScene owns the persistent semantic world, action continuity, and cinematography. A generative-world backend may synthesize environment appearance, mesh, or 3D Gaussian assets, but it must not silently rewrite entity identity, authored blocking, shot timing, or cameras.

## Public contract

The browser API and canonical Agent CLI expose three read-only operations:

```bash
npm run agent:world-preview -- --profile <profile> --shots 01,02 --output request.json
npm run agent:world-mock -- --profile <profile> --shots 01,02 --output mock-result.json
npm run agent:world-depth -- --profile <profile> --shot 02 --time 1.5 --resolution 3840x2160 --output depth/02-001.npy
```

`world-preview` emits:

- ForeScene's persisted production bindings, locations, shot contracts, and action contracts;
- one clean-plate image and raw-depth requirement per review/camera-keyframe sample;
- OpenCV camera-to-world matrices with x right, y down, z forward;
- pixel-space intrinsics derived from the authored vertical FOV and output resolution;
- the HY-World 2 camera-prior JSON shape (`num_cameras`, `extrinsics`, and `intrinsics`);
- exact trajectory timing for moving shots.

`world-depth` emits NumPy v1.0 `<f4`, C-order `[height, width]` linear camera-Z meters. Rows use top-left image origin and zero denotes no geometry. The clean plate hides every non-location object or multipart group that has a production semantic binding, including non-human creatures that the legacy people-only clean-plate filter cannot classify.

`world-mock` deterministically accepts the request and returns mock mesh/3DGS URIs. It verifies adapter plumbing and schema compatibility only; it never claims model inference.

## HY-World 2 compatibility decision

The integration targets WorldMirror's prior-injection boundary. The official WorldMirror documentation accepts per-camera OpenCV camera-to-world extrinsics, pixel intrinsics, and filename-matched depth priors in float32 NumPy, EXR, or 16-bit PNG form. ForeScene now materializes the camera and float32 NumPy depth sides of that boundary.

Primary references:

- [Tencent Hunyuan HY-World 2.0 repository](https://github.com/Tencent-Hunyuan/HY-World-2.0)
- [HY-World 2.0 documentation](https://github.com/Tencent-Hunyuan/HY-World-2.0/blob/main/DOCUMENTATION.md)
- [World generation README](https://github.com/Tencent-Hunyuan/HY-World-2.0/blob/main/hyworld2/worldgen/README.md)
- [HY-World 2.0 paper](https://arxiv.org/abs/2604.14268)

The reference world-generation stack is not a ForeScene runtime dependency. Its documented environment uses modern CUDA-era acceleration and recommends multiple GPUs, whereas ForeScene must remain browser-only and usable on modest hardware.

## External hardware experiment

When suitable external hardware is available, run this bounded experiment rather than changing ForeScene's authority model.

Inputs:

1. A saved `.fsp` opened in a fresh Agent profile.
2. `world-preview` JSON for a three-shot sequence containing at least one moving camera.
3. A same-resolution clean-plate PNG and `world-depth` NumPy file for every request view.
4. The emitted HY-World 2 camera-prior JSON.
5. An explicit backend/version/commit record and exact inference configuration.

Procedure:

1. Validate that view counts, filenames, camera IDs, intrinsics, extrinsics, image sizes, and depth shapes match exactly.
2. Run WorldMirror with the ForeScene camera and depth priors on external hardware.
3. Preserve logs, configuration, timings, model revisions, generated mesh/3DGS/point-cloud outputs, and hashes.
4. Import or inspect the generated representation without altering ForeScene semantic bindings or shot cameras.
5. Re-render the original camera samples and compare projection alignment against the source clean plates and depth priors.

Success criteria:

- every requested view is accepted without camera/depth schema repair;
- output coordinate conversion is explicit and round-trips into right-handed Y-up meters;
- camera reprojection is geometrically aligned at every keyframe, including the moving shot;
- no actor, creature, or dynamic prop is baked into environment geometry;
- ForeScene entity bindings, actions, shot timing, and cameras remain byte-for-byte unchanged;
- backend failures leave the `.fsp` and its semantic configuration untouched;
- all external claims are labeled with actual backend/model/hardware evidence, never inferred from the mock.

Until that experiment is run, external HY-World inference remains **unproven**. The adapter schema, camera priors, clean-plate semantics, metric-depth export, artifact transfer, and deterministic mock execution are locally proven.
