import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { BUILD_HISTORY_COALESCE_MS } from '../src/engine/buildHistory';
import { createPlacedSceneObject, duplicateSceneObject, snapBuildPoint } from '../src/engine/sandbox';
import { useProjectStore } from '../src/state/useProjectStore';

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
    useProjectStore.setState({
      project: createDefaultProject(),
      selectedObjectIds: [],
      gridSnap: true,
      buildMode: 'place',
      activePrimitive: 'box',
    });

    const object = useProjectStore.getState().placeObject('box', [1.24, 0, 1.26]);
    const state = useProjectStore.getState();

    expect(state.project.schemaVersion).toBe('1.0');
    expect(state.selectedObjectIds).toEqual([]);
    expect(state.buildMode).toBe('place');
    expect(object.transform.position).toEqual([1, 0.7, 1.5]);
  });

  it('clears the current selection when arming stamp mode', () => {
    const project = createDefaultProject();
    const selected = project.scene.objects[1];
    useProjectStore.setState({
      project,
      selectedObjectIds: [selected.id],
      buildMode: 'select',
      activePrimitive: 'box',
    });

    useProjectStore.getState().setActivePrimitive('wall');

    const state = useProjectStore.getState();
    expect(state.buildMode).toBe('place');
    expect(state.activePrimitive).toBe('wall');
    expect(state.selectedObjectIds).toEqual([]);
  });

  it('moves unlocked objects to a new ground point when dragged', () => {
    const project = createDefaultProject();
    const object = project.scene.objects[2];
    useProjectStore.setState({ project, gridSnap: true, selectedObjectIds: [object.id] });

    useProjectStore.getState().moveObjectToGroundPoint(object.id, [2.4, 0, -1.8]);

    expect(useProjectStore.getState().project.scene.objects[2].transform.position[0]).toBe(2.5);
    expect(useProjectStore.getState().project.scene.objects[2].transform.position[2]).toBe(-2);
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
    useProjectStore.setState({ project, gridSnap: true, selectedObjectIds: [floor.id] });

    useProjectStore.getState().moveObjectToGroundPoint(floor.id, [4.2, 0, 2.8]);

    const moved = useProjectStore.getState().project.scene.objects.at(-1);
    expect(moved?.transform.position).toEqual([4, 0.04, 3]);
  });

  it('preserves vertical position when moving objects in space via the translate gizmo', () => {
    const project = createDefaultProject();
    const object = project.scene.objects[2];
    const originalY = object.transform.position[1];
    useProjectStore.setState({ project, gridSnap: true, selectedObjectIds: [object.id] });

    useProjectStore.getState().moveObjectPosition(object.id, [2.4, originalY + 1.25, -1.8]);

    const moved = useProjectStore.getState().project.scene.objects[2];
    expect(moved.transform.position[0]).toBe(2.5);
    expect(moved.transform.position[1]).toBeCloseTo(originalY + 1.25);
    expect(moved.transform.position[2]).toBe(-2);
  });

  it('undoes and redoes placeObject, and batches continuous moves into one undo step', () => {
    const project = createDefaultProject();
    const startCount = project.scene.objects.length;
    useProjectStore.setState({
      project,
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
      gridSnap: true,
    });

    useProjectStore.getState().placeObject('box', [1, 0, 1]);
    expect(useProjectStore.getState().project.scene.objects).toHaveLength(startCount + 1);
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(1);

    expect(useProjectStore.getState().undoBuild()).toBe(true);
    expect(useProjectStore.getState().project.scene.objects).toHaveLength(startCount);
    expect(useProjectStore.getState().buildHistoryFuture).toHaveLength(1);

    expect(useProjectStore.getState().redoBuild()).toBe(true);
    expect(useProjectStore.getState().project.scene.objects).toHaveLength(startCount + 1);

    const placed = useProjectStore.getState().project.scene.objects.at(-1)!;
    useProjectStore.getState().beginBuildHistoryBatch();
    useProjectStore.getState().moveObjectPosition(placed.id, [2, placed.transform.position[1], 2]);
    useProjectStore.getState().moveObjectPosition(placed.id, [3, placed.transform.position[1], 3]);
    useProjectStore.getState().moveObjectPosition(placed.id, [4, placed.transform.position[1], 4]);
    useProjectStore.getState().endBuildHistoryBatch();

    // place + one batch pre-state (not three move steps)
    expect(useProjectStore.getState().buildHistoryPast.length).toBeGreaterThanOrEqual(2);
    const pastLenAfterBatch = useProjectStore.getState().buildHistoryPast.length;

    useProjectStore.getState().undoBuild();
    const afterUndoMove = useProjectStore.getState().project.scene.objects.find((item) => item.id === placed.id);
    expect(afterUndoMove?.transform.position[0]).not.toBe(4);
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(pastLenAfterBatch - 1);
  });

  it('records step history for discrete updateObject and coalesces rapid field edits', () => {
    vi.useFakeTimers();
    const project = createDefaultProject();
    const object = project.scene.objects[1];
    useProjectStore.setState({
      project,
      selectedObjectIds: [object.id],
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
    });

    useProjectStore.getState().updateObject(object.id, {
      transform: {
        ...object.transform,
        rotation: [0, 15, 0],
      },
    });
    useProjectStore.getState().updateObject(object.id, {
      transform: {
        ...object.transform,
        rotation: [0, 30, 0],
      },
    });
    useProjectStore.getState().updateObject(object.id, {
      transform: {
        ...object.transform,
        rotation: [0, 45, 0],
      },
    });
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(3);

    useProjectStore.setState({
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryCoalesceActive: false,
    });
    const target = useProjectStore.getState().project.scene.objects[1];
    useProjectStore.getState().updateObject(target.id, { name: 'A' }, { history: 'coalesce' });
    useProjectStore.getState().updateObject(target.id, { name: 'AB' }, { history: 'coalesce' });
    useProjectStore.getState().updateObject(target.id, { name: 'ABC' }, { history: 'coalesce' });
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(1);

    vi.advanceTimersByTime(BUILD_HISTORY_COALESCE_MS + 10);
    useProjectStore.getState().updateObject(target.id, { name: 'ABCD' }, { history: 'coalesce' });
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(2);
    vi.useRealTimers();
  });

  it('skips history for no-op pano origin and identical updateObject', () => {
    const project = createDefaultProject();
    const origin = [...project.scene.panoOrigin] as [number, number, number];
    const object = project.scene.objects[1];
    useProjectStore.setState({
      project,
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
    });

    useProjectStore.getState().setPanoOrigin(origin);
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(0);

    useProjectStore.getState().updateObject(object.id, { name: object.name });
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(0);
  });

  it('clears selection when removing the selected object', () => {
    const project = createDefaultProject();
    const object = project.scene.objects[1];

    useProjectStore.setState({
      project,
      selectedObjectIds: [object.id],
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
    });

    useProjectStore.getState().removeObject(object.id);

    expect(useProjectStore.getState().selectedObjectIds).toEqual([]);
    expect(
      useProjectStore.getState().project.scene.objects.some((item) => item.id === object.id),
    ).toBe(false);
  });

  it('clears build history stacks and runtime flags when opening a project', () => {
    const project = createDefaultProject();
    useProjectStore.setState({
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
    useProjectStore.getState().setProject(incoming);

    const state = useProjectStore.getState();
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
    useProjectStore.setState({ project, gridSnap: true, selectedObjectIds: [object.id] });

    useProjectStore.getState().moveObjectToGroundPoint(object.id, [4.2, 0, -2.8]);

    expect(useProjectStore.getState().project.scene.objects[1].transform.position).toEqual(object.transform.position);
  });
});
