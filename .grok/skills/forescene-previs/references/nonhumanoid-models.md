# Proxy-to-creature replacement

Use this process when any nonhumanoid final asset replaces an existing proxy. It applies to retained projects; do not reset the project to perform the replacement.

1. Inspect and record the proxy object ID and every shot that stages or animates it.
2. Import the real GLB and record the resolved real-object ID.
3. Copy the proxy’s base scene transform to the real model.
4. Copy every proxy shot override to the real model.
5. Set the proxy visibility to `false` and real-model visibility to `true` in each affected shot.
6. Copy timeline/keyframe transforms and visibility where applicable.
7. Rerender every affected shot and compare its before/after frames.
8. Write or update `artifacts/previs/refinement/nonhumanoid-replacements.json`.

```json
{
  "proxyId": "obj_creature_proxy",
  "replacementId": "obj_creature_final",
  "affectedShots": ["12", "13", "14"],
  "commandsApplied": 18,
  "rerenderedShots": ["12", "13", "14"],
  "beforeAfterReviews": [
    { "shotNumber": "12", "before": "reviews/12-before.png", "after": "reviews/12-after.png", "approved": true }
  ]
}
```

A replacement log with zero `commandsApplied` or zero `affectedShots` is a failure, not a successful refinement. A visible proxy cannot count as a final creature. The batch review must confirm the real creature is visible in every required shot.
