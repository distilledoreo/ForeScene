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

  it('accepts every ProjectSaveStatus value the header data-project-save-status can display (F5)', () => {
    const statuses = ['saved', 'saving', 'unsaved', 'failed', 'recovered'] as const;
    for (const status of statuses) {
      useProjectSafetyStore.getState().setPersistenceState({
        status,
        message: `Status ${status}`,
        criticalWrite: status === 'saving',
      });
      expect(useProjectSafetyStore.getState().status).toBe(status);
    }
    // Terminal failed state is sticky until a later successful write updates it.
    useProjectSafetyStore.getState().setPersistenceState({
      status: 'failed',
      message: 'A new asset could not be written locally.',
      lastSavedAt: '2026-07-26T12:00:00.000Z',
      activeRevisionId: 'revision-1',
      criticalWrite: false,
    });
    expect(useProjectSafetyStore.getState()).toMatchObject({
      status: 'failed',
      lastSavedAt: '2026-07-26T12:00:00.000Z',
      activeRevisionId: 'revision-1',
    });
  });
});
