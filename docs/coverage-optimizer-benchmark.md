# Coverage optimizer imported-set benchmark

Run the browser benchmark against a real exported set while a production preview is available:

```powershell
$env:PANOREF_COVERAGE_BENCHMARK_MODEL='C:\path\to\production-set.glb'
$env:PANOREF_COVERAGE_BENCHMARK_URL='http://127.0.0.1:4173'
npm run benchmark:coverage-import
```

The harness removes starter primitives, imports the model in combined mode through ForeScene's real import UI, renders the graybox reference, runs the fixed-first coverage optimizer with production defaults, captures page errors and heap telemetry, and writes JSON plus a screenshot under `artifacts/coverage-import-benchmark/`.

## 2026-07-19 result

- Source: Blender 4.5 splash production scene (`blender-4.5-splash.glb`)
- Source size: 171,156,440 bytes
- Imported geometry: 191 mesh nodes combined into one object, 36,788 triangles
- Coverage workload: 164 candidates and 24,576 fine validation samples
- Import: 0.47 seconds with the source warm in the operating-system file cache
- Optimizer: 36.90 seconds
- Combined coverage: 63.2%
- Reachable upper bound: 69.4%
- Reachable efficiency: 91.0%
- Browser errors: none
- Test machine: AMD Ryzen 7 3700X, 31.9 GB RAM, Chrome 150.0.7871.127

This is a complex real production scene and exercises ForeScene's actual import, packed storage, extraction, floor-component filtering, worker transfer, BVH, search, and UI result path. The automated test suite separately runs both complete optimizer modes over a deterministic 101,250-triangle indexed fixture so a geometry-heavy regression is enforced without checking a large copyrighted model into the repository.
