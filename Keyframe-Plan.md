# Revised Plan: Sequential-Capture Keyframe UI

## Core Mental Model

Sequential capture is the primary workflow.

The user captures camera poses in the order they want them played:

**Capture next → Capture next → Capture next → Finish capture**

The most recently captured pose is always treated as the provisional End. Capturing another pose converts the previous End into an intermediate keyframe and makes the new pose the End.

Out-of-order insertion remains available through the timeline as a secondary precision workflow.

---

## Primary Workflow

### First capture

The first captured pose becomes:

* Start
* Time: `0s`

The interface continues to show:

**Capture next**

### Second capture

The second pose becomes the provisional End at the selected move duration.

The interface now shows:

* **Capture next**
* **Finish capture**

### Third and subsequent captures

Each additional capture:

1. Converts the existing End into an intermediate keyframe.
2. Captures the current camera pose as the new End.
3. Updates keyframe timing according to the current timing mode.

This can continue indefinitely until the user selects **Finish capture**.

### Finish capture

Finishing does not lock the animation.

It only:

* Ends sequential-capture mode.
* Stops the shutter from adding another keyframe.
* Reveals timeline editing, insertion, preview, and export controls.

The user can still:

* Update any pose.
* Insert keyframes.
* Delete intermediate keyframes.
* Adjust timing.
* Continue the sequence later.

A **Continue sequence** action returns the move to sequential-capture mode, with the existing End becoming provisional again.

---

# Video Chrome Layout

## Before any keyframes

```text
Length ─────────●──── 6s

No camera move captured

        [ Capture start ]
```

The primary shutter may perform the same action as **Capture start**.

## After the first pose

```text
Length ─────────●──── 6s

●
Start

        [ Capture next ]
```

## During sequential capture

```text
Length ─────────●──── 6s

●────────◇────────◇────────●
Start     K1       K2       End

[ Capture next ]   [ Finish capture ]
```

## After finishing

```text
Length ─────────●──── 6s

●───── (+) ─────◇───── (+) ─────◇───── (+) ─────●
Start            K1             K2              End

[ Preview move ]   [ Continue sequence ]
```

When a segment is selected:

```text
[ Insert here ]   [ Preview move ]
```

The existing duration slider remains above the keyframe strip. The implementation should expand the current video chrome rather than replace the duration control.

---

# Capture State Model

Replace the existing `record → stop → export` shutter model with an explicit authoring state.

```ts
type VideoCaptureState =
  | 'empty'
  | 'capturing'
  | 'finished';
```

### `empty`

* No keyframes exist.
* The shutter captures Start.

### `capturing`

* At least one keyframe exists.
* The shutter captures the next sequential pose.
* Once two or more poses exist, **Finish capture** is available.

### `finished`

* Sequential capture is paused.
* The shutter no longer appends keyframes.
* Timeline editing, preview, insertion, and export are available.
* **Continue sequence** returns to `capturing`.

Export progress should remain separate from the authoring state:

```ts
const [isExportingCameraMove, setIsExportingCameraMove] = useState(false);
```

Do not overload capture state with export state.

---

# Shutter Behavior

The shutter remains the primary capture control.

## Empty state

```text
Shutter action: Capture Start
```

## Capturing state

```text
Shutter action: Capture next pose
```

It should not become an Export button after the second capture.

## Finished state

The shutter may either:

* Trigger Preview, if preview becomes the primary post-finish action.
* Become inactive for keyframe capture while explicit Preview and Export controls are shown.

The preferred approach is to keep Preview and Export as labeled actions rather than assigning another unrelated meaning to the shutter.

The existing instructional copy must also change.

Replace phrases such as:

```text
Fly to end · press stop
End set · export when ready
```

with state-aware guidance such as:

```text
Pose the first camera position · capture start
Move to the next pose · capture again
Capture another pose or finish the move
Move finished · preview, edit, or export
```

---

# Timing Behavior

## Automatically timed sequences

During sequential capture, poses are evenly distributed across the selected duration.

```text
2 poses over 6s:
0s ───────────── 6s

3 poses over 6s:
0s ────── 3s ────── 6s

4 poses over 6s:
0s ─── 2s ─── 4s ─── 6s
```

Appending a keyframe should update the times of existing keyframes while preserving their IDs, camera data, easing, and object snapshots.

## Manually timed sequences

Once the user manually changes an intermediate keyframe time, future sequential captures preserve the existing timing.

The newly appended pose splits only the final segment.

Example:

```text
Existing:
0s ── 1s ───── 4s ── 6s

Capture next:
0s ── 1s ───── 4s ─ 5s ─ 6s
```

The former End moves to the midpoint between the previous keyframe and the duration. The new pose becomes End at the full duration.

## Deriving manual timing

Do not store `isManuallyTimed` as local UI state.

Derive it from the keyframe data:

```ts
function hasManualCameraKeyframeTiming(
  keyframes: readonly CameraKeyframe[],
  durationSeconds: number,
): boolean;
```

For `n` sorted keyframes, the expected automatically distributed time is:

```ts
expectedTime = (index / (n - 1)) * durationSeconds;
```

Compare actual and expected times with a small tolerance:

```ts
const CAMERA_KEYFRAME_TIME_EPSILON = 0.001;
```

This keeps behavior correct after:

* Reload.
* Shot switching.
* Undo and redo.
* Project recovery.
* Snapshot restoration.
* Duration changes.
* Timing changes from another interface.

Manual retiming may be disabled during active sequential capture in the first release and enabled after **Finish capture**. This is the preferred initial implementation because it avoids timing changing beneath the user while they are still authoring the sequence.

---

# Timeline Behavior

The timeline displays keyframes according to their actual time.

Node position:

```ts
leftPercent = (keyframe.timeSeconds / durationSeconds) * 100;
```

Keyframes should not be distributed visually at equal widths unless their times are actually equal.

Use minimum hit targets without changing the center of each node.

Recommended minimum interactive size:

```text
44 × 44 px
```

## Node appearance

* Start: filled endpoint node.
* End: filled endpoint node.
* Intermediate: hollow diamond or circle.
* Selected node: accented outline or glow.
* Labels such as `K1`, `K2`, and `K3` are derived from chronological position.

Do not rely on persisted labels such as `Keyframe 1` for displayed numbering or identity.

## Endpoint identity

Determine endpoint roles from sorted position:

```ts
const isStart = index === 0;
const isEnd = index === sortedKeyframes.length - 1;
```

Stored `"Start"` and `"End"` labels can remain during migration for backward compatibility, but new logic should not depend exclusively on those strings.

---

# Keyframe Selection

Selecting a keyframe should:

1. Select the node.
2. Move the viewfinder to its stored camera pose once.
3. Restore its stored object overrides for inspection where appropriate.
4. Open the keyframe editor.
5. Leave the camera independent after the jump.

The camera must not remain bound to the selected keyframe.

The user may freely move the camera after selection and choose **Update pose** to commit the current view.

---

# Node Editor

Selecting any node reveals a collision-aware popover or responsive bottom sheet.

## All keyframes

* **Update pose**

This overwrites:

* Camera data.
* Object overrides.

It preserves:

* ID.
* Time.
* Role in the sequence.
* Easing.
* Label metadata.

## Intermediate keyframes only

* Time input.
* Delete.

## Start and End

Start and End times are not directly editable:

* Start is always `0s`.
* End is always the selected move duration.

Start and End are not individually deletable.

Use **Retake move** or **Clear move** to clear the complete sequence.

---

# Segment Selection and Out-of-Order Insertion

Each gap between adjacent keyframes is interactive.

```text
Start ─── (+) ─── K1 ─── (+) ─── K2 ─── (+) ─── End
```

Selecting a gap:

* Highlights the segment.
* Stores the starting keyframe ID as `selectedSegmentStartId`.
* Reveals **Insert here**.

Selecting **Insert here** captures the current camera pose at the midpoint of that segment.

```ts
timeSeconds =
  before.timeSeconds +
  ((after.timeSeconds - before.timeSeconds) / 2);
```

The existing timing of all other keyframes remains unchanged.

A generic **Insert keyframe** control should not appear without a selected segment because its destination would be ambiguous.

---

# Easing Behavior

The current keyframe model stores easing on the keyframe that begins a segment.

Therefore, when an existing End is demoted to an intermediate keyframe, it must receive easing for its new outgoing segment.

The sequential append API must accept the currently selected easing:

```ts
easing: CameraKeyframeEasing;
```

When appending:

```ts
demotedEnd.easing = easing;
```

The newly created End should have no outgoing easing value.

While the interface still exposes a global easing control, every non-final keyframe should carry the selected global easing value.

Per-segment easing remains a later enhancement. The underlying model already supports it.

---

# Engine API Changes

Add the following functions to `src/engine/cameraKeyframes.ts`.

## 1. Sequential append

```ts
appendSequentialCameraKeyframe({
  keyframes,
  camera,
  durationSeconds,
  objectOverrides,
  easing,
  preserveManualTiming,
}): CameraKeyframe[]
```

### Behavior

#### Zero keyframes

Creates Start:

```ts
{
  timeSeconds: 0,
  camera,
  objectOverrides
}
```

#### One keyframe

Keeps the existing keyframe as Start and creates End at `durationSeconds`.

#### Two or more keyframes

* Preserves the existing End ID.
* Converts the existing End into an intermediate keyframe.
* Assigns it the selected easing.
* Creates a new End at `durationSeconds`.
* Redistributes all times evenly when `preserveManualTiming` is false.
* Splits only the final segment when `preserveManualTiming` is true.

Existing keyframes must retain:

* IDs.
* Camera data.
* Object overrides.
* Easing, except where the former End requires a newly assigned easing.
* Any future metadata.

Do not recreate all existing keyframes merely to change their timing.

---

## 2. Segment insertion

```ts
insertCameraKeyframeInSegment({
  keyframes,
  afterKeyframeId,
  camera,
  objectOverrides,
  easing,
}): CameraKeyframe[]
```

### Behavior

* Finds the keyframe identified by `afterKeyframeId`.
* Finds the next chronological keyframe.
* Returns unchanged data if no next keyframe exists.
* Inserts a new intermediate at the segment midpoint.
* Assigns the requested easing to the new keyframe for its outgoing segment.
* Preserves all existing keyframe times and IDs.

A validation helper may also be added:

```ts
canInsertCameraKeyframeAfter(
  keyframes,
  afterKeyframeId,
): boolean;
```

---

## 3. Pose update

```ts
recaptureCameraKeyframe({
  keyframes,
  keyframeId,
  camera,
  objectOverrides,
}): CameraKeyframe[]
```

### Behavior

Updates only:

* `camera`
* `objectOverrides`

Preserves:

* `id`
* `label`
* `timeSeconds`
* `easing`
* sequence position

The interface refers to this action as **Update pose**.

---

## 4. Manual timing detection

```ts
hasManualCameraKeyframeTiming(
  keyframes,
  durationSeconds,
): boolean;
```

### Behavior

* Sorts the keyframes.
* Returns false for fewer than three keyframes.
* Compares each keyframe with its expected evenly distributed time.
* Uses a defined floating-point tolerance.

---

# KeyframeStrip Component

Create:

```text
src/components/workspaces/KeyframeStrip.tsx
```

The component should be presentational.

It must not directly:

* Read the project store.
* Capture the camera.
* Mutate shots.
* Control undo history.
* Navigate the viewfinder.
* Export video.

Those responsibilities remain in `ShotsWorkspace`.

## Props

```ts
interface KeyframeStripProps {
  keyframes: CameraKeyframe[];
  durationSeconds: number;
  captureState: 'empty' | 'capturing' | 'finished';

  selectedKeyframeId: string | null;
  selectedSegmentStartId: string | null;

  onCaptureNext: () => void;
  onFinishCapture: () => void;
  onContinueCapture: () => void;
  onPreview: () => void;

  onSelectKeyframe: (keyframeId: string | null) => void;
  onSelectSegment: (startKeyframeId: string | null) => void;
  onInsertInSelectedSegment: () => void;

  onUpdatePose: (keyframeId: string) => void;
  onChangeTime: (keyframeId: string, time: number) => void;
  onDelete: (keyframeId: string) => void;
}
```

## Rendering responsibilities

* Render keyframes at their real timeline positions.
* Render Start and End differently from intermediates.
* Render selectable gaps between nodes after at least two keyframes exist.
* Render context-sensitive actions for the active capture state.
* Render the selected-node editor.
* Support keyboard navigation.
* Keep controls visible at viewport edges.
* Use a portal, floating-positioning utility, or bottom sheet to avoid clipping.

## Accessibility

* Nodes and gaps must be keyboard reachable.
* Arrow keys may move between adjacent nodes or segments.
* Enter or Space selects.
* Escape closes the editor and restores focus.
* Selected state must use `aria-selected` or an equivalent semantic.
* Controls require explicit accessible labels.
* Do not rely exclusively on node color or shape.

---

# ShotsWorkspace Changes

## 1. Integrate KeyframeStrip

Expand the current video-duration chrome to render `KeyframeStrip` below the duration slider.

Do not remove or unnecessarily rewrite the existing duration slider.

## 2. Replace the shutter state machine

Replace the existing `record`, `stop`, and `export` phase behavior with the new capture state.

The shutter should use the same sequential append callback as the visible **Capture next** action.

## 3. Add sequential capture callback

The callback should:

1. Read the latest selected shot from the store.
2. Capture the effective current camera.
3. Snapshot staged-object overrides.
4. Derive whether timing is manual.
5. Call `appendSequentialCameraKeyframe`.
6. Clear stale rendered video assets.
7. Update the capture state.
8. Preserve undo behavior.

## 4. Add segment insertion callback

The callback should:

1. Require a selected segment.
2. Capture the effective current camera.
3. Snapshot staged-object overrides.
4. Call `insertCameraKeyframeInSegment`.
5. Clear stale rendered video assets.
6. Select the newly inserted keyframe.

## 5. Add pose update callback

The callback should:

1. Capture the effective current camera.
2. Snapshot staged-object overrides.
3. Call `recaptureCameraKeyframe`.
4. Clear stale rendered video assets.

## 6. Add node navigation callback

Selecting a node should:

* Set `selectedKeyframeId`.
* Clear any selected segment.
* Perform a one-time camera move to the stored pose.
* Reseed the viewfinder if needed.
* Avoid continuously following the keyframe.

## 7. Add segment selection state

```ts
const [selectedSegmentStartId, setSelectedSegmentStartId] =
  useState<string | null>(null);
```

Reset node and segment selection when:

* Switching shots.
* Clearing the move.
* Retaking the move.
* Deleting the selected keyframe.
* Starting a fresh capture sequence.

## 8. Preview action

Add or reuse a lightweight camera-move preview callback.

Preview should not require export.

If a real-time preview already exists elsewhere, reuse its interpolation path rather than creating a second animation implementation.

## 9. Continue sequence

Add a callback that:

* Changes capture state from `finished` to `capturing`.
* Leaves existing keyframes unchanged.
* Treats the current End as provisional.
* Updates instructional copy.

## 10. Retake move

Retain the existing Retake behavior:

* Clear all camera keyframes.
* Clear stale camera-move assets.
* Reset capture state to `empty`.
* Clear selected node and segment.
* Return to initial capture guidance.

---

# Precision Drawer Changes

Remove the existing in-between keyframe editor after the on-canvas strip is operational.

Remove:

* Add intermediate control.
* Intermediate keyframe list.
* Intermediate time controls.
* Intermediate delete buttons.

Retain:

* Shot name.
* Shot status.
* Landmarks.
* Duration input.
* Global easing dropdown.
* Export settings.
* Set Start and Set End as temporary fallback controls during transition.

The fallback Set Start and Set End controls should eventually be removed or clearly placed under an advanced/manual section because they do not match the primary sequential workflow.

Do not maintain two full keyframe editors indefinitely.

---

# Stored Labels and Migration

Maintain compatibility with existing keyframes that use labels such as:

* `Start`
* `End`
* `Keyframe 1`

For new UI:

* Sort by `timeSeconds`.
* Treat first and last as endpoints.
* Derive visible intermediate labels from sorted index.

Example:

```ts
const displayLabel =
  index === 0
    ? 'Start'
    : index === sorted.length - 1
      ? 'End'
      : `K${index}`;
```

Avoid renaming persisted keyframes purely for display purposes.

Existing helper functions may remain during transition, but new sequential and timeline logic should use sorted order rather than label matching wherever possible.

---

# Testing Plan

## Engine tests

Add tests for `appendSequentialCameraKeyframe`.

Cover:

* Zero keyframes creates Start.
* One keyframe creates End.
* Third capture demotes the previous End.
* Existing IDs are preserved.
* New End receives a new ID.
* Existing object overrides are preserved.
* Former End receives easing.
* New End has no outgoing easing.
* Automatic timing redistributes evenly.
* Manual timing splits only the final segment.
* Duration limits remain respected.
* Invalid input returns a safe result.

Add tests for `insertCameraKeyframeInSegment`.

Cover:

* Correct segment midpoint.
* Correct insertion order.
* Existing times remain unchanged.
* Existing IDs remain unchanged.
* Insertion after End is rejected.
* Unknown IDs are rejected safely.
* Easing is assigned correctly.

Add tests for `recaptureCameraKeyframe`.

Cover:

* Camera is replaced.
* Object overrides are replaced.
* ID is unchanged.
* Time is unchanged.
* Easing is unchanged.
* Label is unchanged.
* Unknown ID leaves data unchanged.

Add tests for `hasManualCameraKeyframeTiming`.

Cover:

* Fewer than three points.
* Evenly distributed timing.
* Small floating-point deviations.
* Meaningful manual deviation.
* Different durations.
* Imported unsorted keyframes.

## Component tests

Test `KeyframeStrip` interactions rather than checking only source strings.

Cover:

* Empty state renders Capture start.
* One keyframe renders Capture next.
* Two or more keyframes render Finish capture.
* Finished state renders Preview and Continue sequence.
* Segment selection reveals Insert here.
* Selecting a node invokes navigation.
* Update pose invokes the correct callback.
* Time input appears only for intermediates.
* Delete appears only for intermediates.
* Timeline placement reflects actual time.
* Keyboard navigation works.
* Escape closes the editor and restores focus.

## Integration or E2E tests

Cover:

* First shutter press creates Start.
* Second shutter press creates End.
* Third shutter press creates an intermediate and new End.
* Finish capture stops sequential appending.
* Continue sequence allows another append.
* Updating a pose preserves timing.
* Inserting into a selected segment works.
* Duration changes reposition all nodes.
* Manual timing survives reload.
* Switching shots resets timeline selection.
* Undo and redo restore keyframe sequences.
* Retake clears all capture state.
* Popovers remain visible near mobile viewport edges.
* Export uses the complete authored sequence.

Replace selectors tied to the drawer editor with selectors such as:

```text
data-camera-keyframe-strip
data-camera-keyframe-node
data-camera-keyframe-segment
data-camera-keyframe-capture-next
data-camera-keyframe-finish
data-camera-keyframe-continue
data-camera-keyframe-insert
data-camera-keyframe-update-pose
```

---

# File Changes

| File                                                                    | Changes                                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/engine/cameraKeyframes.ts`                                         | Add sequential append, segment insertion, pose update, manual-timing detection, and validation helpers         |
| `src/components/workspaces/KeyframeStrip.tsx`                           | Add responsive timeline, node editor, segment selection, and capture controls                                  |
| `src/components/workspaces/ShotsWorkspace.tsx`                          | Replace shutter state machine, integrate strip, add callbacks, camera navigation, preview, and selection state |
| `src/components/common/PrecisionDrawer.tsx` or its ShotsWorkspace usage | Remove the old in-between editor after the new strip is functional                                             |
| `tests/cameraKeyframes.test.ts`                                         | Add comprehensive engine tests                                                                                 |
| Component or E2E test files                                             | Add real interaction coverage and update selectors                                                             |

---

# Implementation Order

## Phase 1: Engine foundation

1. Add `appendSequentialCameraKeyframe`.
2. Add `insertCameraKeyframeInSegment`.
3. Add `recaptureCameraKeyframe`.
4. Add `hasManualCameraKeyframeTiming`.
5. Add validation helpers.
6. Add engine tests.

## Phase 2: Capture state

1. Replace the existing shutter phase model.
2. Wire the shutter to sequential append.
3. Add Finish capture.
4. Add Continue sequence.
5. Update instructional copy.
6. Verify Retake and export-state behavior.

## Phase 3: Minimal timeline

1. Add `KeyframeStrip`.
2. Render time-positioned nodes.
3. Show capture-state actions.
4. Add node selection.
5. Add one-time camera navigation.
6. Add Update pose.

## Phase 4: Precision insertion and timing

1. Add selectable gaps.
2. Add Insert here.
3. Add post-finish time editing.
4. Add intermediate deletion.
5. Add duration-responsive node positioning.

## Phase 5: Preview and responsive polish

1. Add Preview move.
2. Add collision-safe popover or mobile bottom sheet.
3. Add keyboard navigation.
4. Add focus restoration.
5. Test narrow and short viewports.
6. Verify controls never overlap the shutter, gallery thumbnail, or shot navigation.

## Phase 6: Remove the old editor

1. Remove the drawer’s in-between editor.
2. Remove obsolete callbacks and selectors.
3. Retain temporary Start and End fallback controls only if still necessary.
4. Update documentation.
5. Run type checking, unit tests, integration tests, build, and browser smoke tests.

---

# Deferred Enhancements

These should not block the first release:

* Per-segment easing controls.
* Drag-to-retime keyframes.
* Timeline scrubbing.
* Playback head.
* Spline or smooth-path interpolation.
* Bezier motion curves.
* Multi-select keyframes.
* Copy and paste poses.
* Keyboard capture shortcuts.
* Timeline zoom for long moves.
* Named keyframes.
* Path visualization in the 3D viewport.

The highest-value follow-up after the initial release is smooth-path interpolation or a real-time preview, because the current renderer remains piecewise linear between keyframes.
