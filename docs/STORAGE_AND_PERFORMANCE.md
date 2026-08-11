# Storage and Performance Expectations

This document records **honest** capacity guidance for ForeScene.  
Every number is classified as one of:

| Label | Meaning |
| --- | --- |
| **Measured baseline** | Observed on documented hardware/fixtures. Not a guaranteed floor or ceiling. |
| **Recommended operating limit** | Expected to provide a practical experience. Not hard-enforced by the app. |
| **Hard-enforced limit** | The application actively blocks or constrains this value. |

Do not treat estimates as guaranteed capacity. Browser RAM, GPU, and storage quotas vary widely.

Canonical machine-readable index: `src/engine/budgets.ts` (re-exports live constants where enforcement exists).

---

## Geometry and model import

| Topic | Figure | Classification |
| --- | --- | --- |
| Recommended set triangle count | ~250,000 triangles for comfortable Build + fly camera | Recommended operating limit |
| Model import rejection | Byte-derived safety budget (not a fixed triangle count). See `modelImportBudget.ts` and `docs/heavy-model-imports.md` | Hard-enforced limit |
| Packed asset ceiling | 768 MiB packed geometry per import analysis | Hard-enforced limit |
| Project asset storage estimate ceiling | 1 GiB estimated per import analysis | Hard-enforced limit |
| Source file ceiling | 1 GiB | Hard-enforced limit |
| Device import heap budget | min(20% of `navigator.deviceMemory`, 1536 MiB desktop / 384 MiB mobile) | Hard-enforced limit |

Import tiers (standard / heavy / extreme / reject) are heuristics over estimated peak heap relative to that device budget.

---

## Project storage and recovery

| Topic | Figure | Classification |
| --- | --- | --- |
| Recommended project storage size | ~200 MiB total local project footprint for snappy save/load | Recommended operating limit |
| Autosave revision retention | 8 newest autosaves kept | Hard-enforced limit |
| Recovery snapshot retention | 10 newest snapshots kept | Hard-enforced limit |
| Build undo depth | 50 steps | Hard-enforced limit |
| Backup ZIP practical size | ~500 MiB for smooth browser download/share | Recommended operating limit |

Projects store binary assets in IndexedDB and JSON metadata in local revisions. Opening a project backup ZIP restores both.

---

## Renders and camera moves

| Topic | Figure | Classification |
| --- | --- | --- |
| Expected still export (clay 1080p) | ~2 s on a mid-range laptop for modest scenes | Measured baseline |
| Expected still export (projected 1080p) | ~5 s under the same conditions | Measured baseline |
| Expected 4K camera-move encode pressure | ~1.5 GiB order-of-magnitude peak JS/GPU pressure | Measured baseline |
| Camera-move duration | 0.5–30 s (UI chrome often 1–20 s) | Hard-enforced limit |
| Default camera-move duration | 5 s | Hard-enforced limit (default) |
| Frame rate | Profile-driven: Fast Control 24 fps; Standard/High Quality 30 fps | Hard-enforced limit (per profile) |
| 720p Fast Control | 1280×720 @ 24, H.264 High Level 3.1, fast encoder preferred | Hard-enforced limit (profile) |
| 1080p preset | 1920×1080 @ 30, H.264 High Level 4.0 | Hard-enforced limit |
| 4K preset | 3840×2160 @ 30, H.264 High Level 5.1 | Hard-enforced limit |
| Fingerprinted MP4 cache | Exact-match reuse across package exports (memory + IndexedDB) | Measured baseline |

Encode availability depends on WebCodecs / browser support. When Render MP4 is unavailable, Quick Preview may still be offered.

---

## Browser quota and GPU

| Topic | Figure | Classification |
| --- | --- | --- |
| IndexedDB / storage quota | Varies by browser, device, and origin eviction policy | Measured baseline |
| Decoded project-asset working set | 256 MiB or 256 entries for evictable in-memory Blob/object-URL payloads; the active project is pinned | Hard-enforced limit (evictable working set) |
| Agent artifact registry | 64 artifacts or 512 MiB, least-recently-used entries reclaimed first | Hard-enforced limit |
| Failed saves | Surfaced as errors; the app must not report a successful save when persistence failed | Hard-enforced limit (behavior) |
| WebGL context | One context per `SceneViewport`; released on unmount | Measured baseline |
| Free GPU memory | Not reliably queryable; budgets use conservative heap estimates | Measured baseline |

---

## Supported browser targets

| Target | Role | Classification |
| --- | --- | --- |
| Chromium desktop (Chrome / Edge) | Primary production path including MP4 render | Recommended operating limit |
| WebKit desktop | Required smoke CI; GPU path is a non-blocking canary | Recommended operating limit |
| Mobile browsers | Supported for lighter projects; extreme imports reject by default | Recommended operating limit |

---

## Related docs

- `docs/heavy-model-imports.md` — import tier details and formulas  
- `docs/project-safety-recovery-checklist.md` — recovery workflows  
- `docs/coverage-optimizer-benchmark.md` — coverage engine measurements  

---

## Change policy

This phase is **documentation and measurement only**. Do not add new hard-blocking product behavior solely from this doc without a separate approved change.
