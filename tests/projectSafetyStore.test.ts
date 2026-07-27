import { afterEach, describe, expect, it } from 'vitest';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';

describe('project safety status store', () => {
  afterEach(() => {
    useProjectSafetyStore.setState({
      status: 'unsaved',
      message: undefined,
      lastSavedAt: undefined,
      activeRevisionId: undefined,
      criticalWrite: false,
    });
  });

  it('preserves the latest verified save metadata through unsaved and failed status updates', () => {
    const store = useProjectSafetyStore.getState();
    store.setPersistenceState({
      status: 'saved', message: 'Saved', lastSavedAt: '2026-07-26T12:00:00.000Z', activeRevisionId: 'revision-1', criticalWrite: false,
    });
    store.setPersistenceState({ status: 'unsaved', message: 'Editing', criticalWrite: false });
    store.setPersistenceState({ status: 'failed', message: 'Write failed', criticalWrite: false });

    expect(useProjectSafetyStore.getState()).toMatchObject({
      lastSavedAt: '2026-07-26T12:00:00.000Z',
      activeRevisionId: 'revision-1',
      status: 'failed',
    });
  });
});
