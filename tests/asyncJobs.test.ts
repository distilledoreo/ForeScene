import { describe, expect, it } from 'vitest';
import { runSettledSequentially } from '../src/engine/asyncJobs';

describe('runSettledSequentially', () => {
  it('runs optional jobs one at a time and continues after a failure', async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let active = 0;
    let peakActive = 0;
    const job = (name: string, fail = false) => async () => {
      started.push(name);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await Promise.resolve();
      active -= 1;
      if (fail) throw new Error(name);
      completed.push(name);
    };

    await runSettledSequentially([job('first'), job('second', true), job('third')]);

    expect(started).toEqual(['first', 'second', 'third']);
    expect(completed).toEqual(['first', 'third']);
    expect(peakActive).toBe(1);
  });
});
