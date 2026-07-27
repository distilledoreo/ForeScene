import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { BUILD_HISTORY_COALESCE_MS } from '../src/engine/buildHistory';
import { createPlacedSceneObject, duplicateSceneObject, snapBuildPoint } from '../src/engine/sandbox';
import { useContinuityStore } from '../src/state/useContinuityStore';

describe('sandbox build interactions', () => {
  it('snaps build points on the floor grid without changing height', () => {
    expect(snapBuildPoint([1.26, 2.4, -0.74], true)).toEqual([1.5, 2.4, -0.5]);
    expect(snapBuildPoint([1.26, 2.4, -0.74], false)).toEqual([1.26, 2.4, -0.74]);
  });

  it('places primitives at clicked floor coordinates while preserving object height defaults', () => {
    const wall = createPlacedSceneObject({
      type: 'wall',
      index: 3,
      point: [2.1, 0, -1.2],
      snapToGrid: true,
    });

    expect(wall.name).toBe('Wall 3');
    expect(wall.transform.position).toEqual([2, 1.5, -1]);
  });

  it('duplicates objects with a new identity and an unlocked visible copy', () => {
    const original = createPlacedSceneObject({
      type: 'column',
      index: 1,
      point: [0.2, 0, 0.2],
      snapToGrid: true,
    });
    const lockedHidden = { ...original, locked: true, visible: false };
    const duplicate = duplicateSceneObject(lockedHidden, 2, true);

    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.name).toBe('Column 2');
    expect(duplicate.locked).toBe(false);
    expect(duplicate.visible).toBe(true);
    expect(duplicate.dimensions).toEqual(original.dimensions);
    expect(duplicate.transform.position).toEqual([1, 1.5, 1]);
  });

  it('stamps floor tiles with visible tile dimensions on the ground plane', () => {
    const floor = createPlacedSceneObject({
      type: 'floor',
      index: 2,
      point: [2.2, 0, 1.1],
      snapToGrid: true,
    });

    expect(floor.name).toBe('Floor 2');
    expect(floor.dimensions).toEqual([4, 0.08, 4]);
    expect(floor.transform.position).toEqual([2, 0.04, 1]);
  });

  it('stores placed objects without changing project schema version', () => {
    useContinuityStore.setState({
      project: createDefaultProject(),
      selectedObjectIds: [],
      gridSnap: true,
      buildMode: 'place',
      activePrimitive: 'box',
    });

    const object = useContinuityStore.getState().placeObject('box', [1.24, 0, 1.26]);
    const state = useContinuityStore.getState();

    expect(state.project.schemaVersion).toBe('1.0');
    expect(state.selectedObjectIds).toEqual([]);
    expect(state.buildMode).toBe('place');
    expect(object.transform.position).toEqual([1, 0.7, 1.5]);
  });

  it('clears the current selection when arming stamp mode', () => {
    const project = createDefaultProject();
    const selected = project.scene.objects[1];
    useContinuityStore.setState({
      project,
      selectedObjectIds: [selected.id],
      buildMode: 'select',
      activePrimitive: 'box',
    });

    useContinuityStore.getState().setActivePrimitive('wall');

    const state = useContinuityStore.getState();
    expect(state.buildMode).toBe('place');
    expect(state.activePrimitive).toBe('wall');
    expect(state.selectedObjectIds).toEqual([]);
  });

  it('moves unlocked objects to a new ground point when dragged', () => {
    const project = createDefaultProject();
    const object = project.scene.objects[2];
    useContinuityStore.setState({ project, gridSnap: true, selectedObjectIds: [object.id] });

    useContinuityStore.getState().moveObjectToGroundPoint(object.id, [2.4, 0, -1.8]);

    expect(useContinuityStore.getState().project.scene.objects[2].transform.position[0]).toBe(2.5);
    expect(useContinuityStore.getState().project.scene.objects[2].transform.position[2]).toBe(-2);
  });

  it('keeps the starter ground slab locked by default', () => {
    const project = createDefaultProject();
    expect(project.scene.objects[0].type).toBe('floor');
    expect(project.scene.objects[0].locked).toBe(true);
  });

  it('moves unlocked floor tiles when dragged', () => {
    const project = createDefaultProject();
    const floor = createPlacedSceneObject({
      type: 'floor',
      index: 2,
      point: [2, 0, 1],
      snapToGrid: true,
    });
    project.scene.objects.push(floor);
    useContinuityStore.setState({ project, gridSnap: true, selectedObjectIds: [floor.id] });

    useContinuityStore.getState().moveObjectToGroundPoint(floor.id, [4.2, 0, 2.8]);

    const moved = useContinuityStore.getState().project.scene.objects.at(-1);
    expect(moved?.transform.position).toEqual([4, 0.04, 3]);
  });

  it('preserves vertical position when moving objects in space via the translate gizmo', () => {
    const project = createDefaultProject();
    const object = project.scene.objects[2];
    const originalY = object.transform.position[1];
    useContinuityStore.setState({ project, gridSnap: true, selectedObjectIds: [object.id] });

    useContinuityStore.getState().moveObjectPosition(object.id, [2.4, originalY + 1.25, -1.8]);

    const moved = useContinuityStore.getState().project.scene.objects[2];
    expect(moved.transform.position[0]).toBe(2.5);
    expect(moved.transform.position[1]).toBeCloseTo(originalY + 1.25);
    expect(moved.transform.position[2]).toBe(-2);
  });

  it('undoes and redoes placeObject, and batches continuous moves into one undo step', () => {
    const project = createDefaultProject();
    const startCount = project.scene.objects.length;
    useContinuityStore.setState({
      project,
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
      gridSnap: true,
    });

    useContinuityStore.getState().placeObject('box', [1, 0, 1]);
    expect(useContinuityStore.getState().project.scene.objects).toHaveLength(startCount + 1);
    expect(useContinuityStore.getState().buildHistoryPast).toHaveLength(1);

    expect(useContinuityStore.getState().undoBuild()).toBe(true);
    expect(useContinuityStore.getState().project.scene.objects).toHaveLength(startCount);
    expect(useContinuityStore.getState().buildHistoryFuture).toHaveLength(1);

    expect(useContinuityStore.getState().redoBuild()).toBe(true);
    expect(useContinuityStore.getState().project.scene.objects).toHaveLength(startCount + 1);

    const placed = useContinuityStore.getState().project.scene.objects.at(-1)!;
    useContinuityStore.getState().beginBuildHistoryBatch();
    useContinuityStore.getState().moveObjectPosition(placed.id, [2, placed.transform.position[1], 2]);
    useContinuityStore.getState().moveObjectPosition(placed.id, [3, placed.transform.position[1], 3]);
    useContinuityStore.getState().moveObjectPosition(placed.id, [4, placed.transform.position[1], 4]);
    useContinuityStore.getState().endBuildHistoryBatch();

    // place + one batch pre-state (not three move steps)
    expect(useContinuityStore.getState().buildHistoryPast.length).toBeGreaterThanOrEqual(2);
    const pastLenAfterBatch = useContinuityStore.getState().buildHistoryPast.length;

    useContinuityStore.getState().undoBuild();
    const afterUndoMove = useContinuityStore.getState().project.scene.objects.find((item) => item.id === placed.id);
    expect(afterUndoMove?.transform.position[0]).not.toBe(4);
    expect(useContinuityStore.getState().buildHistoryPast).toHaveLength(pastLenAfterBatch - 1);
  });

  it('records step history for discrete updateObject and coalesces rapid field edits', () => {
    vi.useFakeTimers();
    const project = createDefaultProject();
    const object = project.scene.objects[1];
    useContinuityStore.setState({
      project,
      selectedObjectIds: [object.id],
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
    });

    useContinuityStore.getState().updateObject(object.id, {
      transform: {
        ...object.transform,
        rotation: [0, 15, 0],
      },
    });
    useContinuityStore.getState().updateObject(object.id, {
      transform: {
        ...object.transform,
        rotation: [0, 30, 0],
      },
    });
    useContinuityStore.getState().updateObject(object.id, {
      transform: {
        ...object.transform,
        rotation: [0, 45, 0],
      },
    });
    expect(useContinuityStore.getState().buildHistoryPast).toHaveLength(3);

    useContinuityStore.setState({
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryCoalesceActive: false,
    });
    const target = useContinuityStore.getState().project.scene.objects[1];
    useContinuityStore.getState().updateObject(target.id, { name: 'A' }, { history: 'coalesce' });
    useContinuityStore.getState().updateObject(target.id, { name: 'AB' }, { history: 'coalesce' });
    useContinuityStore.getState().updateObject(target.id, { name: 'ABC' }, { history: 'coalesce' });
    expect(useContinuityStore.getState().buildHistoryPast).toHaveLength(1);

    vi.advanceTimersByTime(BUILD_HISTORY_COALESCE_MS + 10);
    useContinuityStore.getState().updateObject(target.id, { name: 'ABCD' }, { history: 'coalesce' });
    expect(useContinuityStore.getState().buildHistoryPast).toHaveLength(2);
    vi.useRealTimers();
  });

  it('skips history for no-op pano origin and identical updateObject', () => {
    const project = createDefaultProject();
    const origin = [...project.scene.panoOrigin] as [number, number, number];
    const object = project.scene.objects[1];
    useContinuityStore.setState({
      project,
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
    });

    useContinuityStore.getState().setPanoOrigin(origin);
    expect(useContinuityStore.getState().buildHistoryPast).toHaveLength(0);

    useContinuityStore.getState().updateObject(object.id, { name: object.name });
    expect(useContinuityStore.getState().buildHistoryPast).toHaveLength(0);
  });

  it('clears selection when removing the selected object', () => {
    const project = createDefaultProject();
    const object = project.scene.objects[1];

    useContinuityStore.setState({
      project,
      selectedObjectIds: [object.id],
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
    });

    useContinuityStore.getState().removeObject(object.id);

    expect(useContinuityStore.getState().selectedObjectIds).toEqual([]);
    expect(
      useContinuityStore.getState().project.scene.objects.some((item) => item.id === object.id),
    ).toBe(false);
  });

  it('clears build history stacks and runtime flags when opening a project', () => {
    const project = createDefaultProject();
    useContinuityStore.setState({
      project,
      buildHistoryPast: [{
        objects: project.scene.objects,
        panoOrigin: project.scene.panoOrigin,
        panoRotation: project.scene.panoRotation,
        selectedObjectIds: [],
      }],
      buildHistoryFuture: [{
        objects: project.scene.objects,
        panoOrigin: project.scene.panoOrigin,
        panoRotation: project.scene.panoRotation,
        selectedObjectIds: [],
      }],
      buildHistoryBatchDepth: 2,
      buildHistoryBatchCaptured: true,
      buildHistoryCoalesceActive: true,
    });

    const incoming = createDefaultProject();
    incoming.name = 'Fresh Project';
    useContinuityStore.getState().setProject(incoming);

    const state = useContinuityStore.getState();
    expect(state.project.name).toBe('Fresh Project');
    expect(state.buildHistoryPast).toEqual([]);
    expect(state.buildHistoryFuture).toEqual([]);
    expect(state.buildHistoryBatchDepth).toBe(0);
    expect(state.buildHistoryBatchCaptured).toBe(false);
    expect(state.buildHistoryCoalesceActive).toBe(false);
  });

  it('does not drag locked objects through the sandbox move action', () => {
    const project = createDefaultProject();
    const object = { ...project.scene.objects[1], locked: true };
    project.scene.objects[1] = object;
    useContinuityStore.setState({ project, gridSnap: true, selectedObjectIds: [object.id] });

    useContinuityStore.getState().moveObjectToGroundPoint(object.id, [4.2, 0, -2.8]);

    expect(useContinuityStore.getState().project.scene.objects[1].transform.position).toEqual(object.transform.position);
  });
});
