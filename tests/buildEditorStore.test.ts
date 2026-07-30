import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { createBuildClipboardPayload } from '../src/engine/buildClipboard';
import { useProjectStore } from '../src/state/useProjectStore';

describe('Build editor store operations', () => {
  beforeEach(() => {
    const project = createDefaultProject();
    useProjectStore.setState({
      project,
      selectedObjectIds: [],
      buildClipboard: undefined,
      buildClipboardPasteCount: 0,
      gridSnap: true,
      buildMode: 'select',
      buildHistoryPast: [],
      buildHistoryFuture: [],
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
      buildTransformPivot: undefined,
    });
  });

  it('supports replace, toggle, range, select-all, and clear selection', () => {
    const store = useProjectStore.getState();
    const ids = store.project.scene.objects.map((object) => object.id);
    store.selectObject(ids[0]);
    useProjectStore.getState().selectObject(ids[1], 'toggle');
    expect(useProjectStore.getState().selectedObjectIds).toEqual([ids[0], ids[1]]);
    useProjectStore.getState().selectObjectRange(ids.at(-1)!);
    expect(useProjectStore.getState().selectedObjectIds).toEqual(ids);
    useProjectStore.getState().clearObjectSelection();
    expect(useProjectStore.getState().selectedObjectIds).toEqual([]);
    useProjectStore.getState().selectAllObjects();
    expect(useProjectStore.getState().selectedObjectIds).toEqual(
      store.project.scene.objects.filter((object) => object.visible && !object.locked).map((object) => object.id),
    );
  });

  it('blocks destructive group operations when any selected object is locked', () => {
    const state = useProjectStore.getState();
    const [first, second] = state.project.scene.objects;
    const project = structuredClone(state.project);
    project.scene.objects.find((object) => object.id === second.id)!.locked = true;
    useProjectStore.setState({ project, selectedObjectIds: [first.id, second.id] });

    expect(useProjectStore.getState().removeSelectedObjects()).toBe(false);
    expect(useProjectStore.getState().translateSelectedObjectsBy([1, 0, 0])).toBe(false);
    expect(useProjectStore.getState().project.scene.objects).toHaveLength(state.project.scene.objects.length);
  });

  it('pastes repeatedly with cascading offsets and restores selection through undo', () => {
    const state = useProjectStore.getState();
    const source = state.project.scene.objects[0];
    const payload = createBuildClipboardPayload(state.project.id, [source]);
    state.setBuildClipboard(payload);

    const first = useProjectStore.getState().pasteBuildObjects(payload);
    const second = useProjectStore.getState().pasteBuildObjects(payload);
    expect(first[0].transform.position[0] - source.transform.position[0]).toBe(1);
    expect(second[0].transform.position[0] - source.transform.position[0]).toBe(1.5);
    expect(useProjectStore.getState().selectedObjectIds).toEqual([second[0].id]);

    expect(useProjectStore.getState().undoBuild()).toBe(true);
    expect(useProjectStore.getState().selectedObjectIds).toEqual([first[0].id]);
    expect(useProjectStore.getState().project.scene.objects.some((object) => object.id === second[0].id)).toBe(false);
  });

  it('duplicates a set as one undoable edit and selects the clones', () => {
    const state = useProjectStore.getState();
    const selected = state.project.scene.objects.slice(0, 2);
    useProjectStore.setState({ selectedObjectIds: selected.map((object) => object.id) });
    const duplicates = useProjectStore.getState().duplicateSelectedObjects();
    expect(duplicates).toHaveLength(2);
    expect(useProjectStore.getState().selectedObjectIds).toEqual(duplicates.map((object) => object.id));
    expect(useProjectStore.getState().buildHistoryPast).toHaveLength(1);
  });
});
