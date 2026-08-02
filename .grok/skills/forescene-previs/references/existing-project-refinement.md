# Existing-project refinement and preservation

## Non-destructive default

Select `existing-project-refinement` whenever inspection finds useful geometry, panoramas, shots, cameras, blocking, timelines, or continuity work. The presence of **any** existing shot or panorama prohibits `--reset-project` and `resetProject` unless the user explicitly requests reconstruction. Treat "make it cleaner," "replace the characters," and "update the manifest" as refinement requests, not reset authorization.

## Required preservation preflight

Before any write, run `npm run agent:inspect -- --url <url>` and capture the full read-only document from `window.foreScene.getProjectDocument()`. Write `artifacts/previs/preflight/project-preservation.json`; it is a required review artifact, not an optional note.

```json
{
  "operatingMode": "existing-project-refinement",
  "projectId": "project_123",
  "projectName": "Existing project",
  "preserve": {
    "sceneGeometry": true,
    "panoramas": true,
    "shots": true,
    "cameras": true,
    "existingTimeline": true
  },
  "counts": {
    "objects": 24,
    "panoramas": 2,
    "shots": 8
  },
  "resetAuthorized": false,
  "plannedReplacements": [
    "placeholder cast model",
    "replacement-object proxy",
    "environment stand-in"
  ],
  "preservedIds": {
    "shots": ["shot_001", "shot_002"],
    "panoramas": ["pano_001", "pano_002"],
    "retainedEnvironmentObjects": ["obj_set_wall", "obj_set_door"],
    "cameras": ["shot_001:camera", "shot_002:camera"],
    "timelineEntries": ["shot_001:keyframe_01", "shot_002:keyframe_01"]
  }
}
```

Populate the `preservedIds` arrays from the original document, not from guessed names. Record every original shot ID, panorama ID, retained environment-object ID, camera identity, and timeline/keyframe entry. A camera or timeline entry can be represented by a stable composite identifier only when the source document has no separate ID; include its shot ID and original index/keyframe ID so the final check is unambiguous.

`resetAuthorized` may be `true` only when the user explicitly directs reconstruction and the preflight records that direction. It is not authorization to reset an existing project merely because the agent wants a greenfield manifest path.

## Refinement loop

1. Retain the full original document snapshot beside the preflight (or in the run record) so transforms, camera data, staging, and timeline state can be compared.
2. Identify the smallest affected shot set. Do not recompile all shots to replace one asset.
3. Analyze/import an asset incrementally, preview the staging plan, then apply it with explicit write access.
4. Work in 3–5-shot batches; render and visually review every affected shot before moving on.
5. Rerender only outputs affected by the changed object, camera, staging, or timeline.

## Final preservation check

After the last write, read a fresh `getProjectDocument()` snapshot and write `artifacts/previs/preflight/project-preservation-final.json`. It must compare original IDs with final IDs and list any missing or substituted values.

```json
{
  "projectId": "project_123",
  "passed": true,
  "checks": {
    "projectIdUnchanged": true,
    "shotsRetained": true,
    "panoramasRetained": true,
    "environmentObjectsRetained": true,
    "camerasRetained": true,
    "timelineEntriesRetained": true
  },
  "missingIds": [],
  "substitutedIds": [],
  "finalCounts": { "objects": 27, "panoramas": 2, "shots": 8 }
}
```

The check fails if the project ID changes, any required original ID is missing, a camera/timeline entry was silently replaced, or the preflight cannot establish identity. Do not claim preservation, refinement completion, or production completion until this record passes.
