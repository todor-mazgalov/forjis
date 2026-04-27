/**
 * Unit tests for the throttled progress reporter helper used by
 * `refreshTreeYaml`.
 *
 * Asserts the throttle window suppresses intermediate calls while
 * always emitting the final `<total>/<total>` line, and that both
 * branches of the throttle are reachable via fake `Date.now`.
 */

import { jest } from '@jest/globals';

import { makeProgressReporter } from '../context-cache/index.js';

describe('makeProgressReporter', () => {
  let dateSpy: jest.SpiedFunction<typeof Date.now>;

  beforeEach(() => {
    dateSpy = jest.spyOn(Date, 'now');
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it('emits the first line, suppresses calls inside the throttle window, then emits when the window elapses', () => {
    const recorded: string[] = [];
    const warn = (msg: string): void => {
      recorded.push(msg);
    };

    // t=0: first call. done=1, lastEmit=0, now=0. The reporter only
    // emits when `done === total` or `now - lastEmit >= 1000`; both
    // branches are false here, so no emission yet.
    dateSpy.mockReturnValue(0);
    const report = makeProgressReporter(10, warn);
    report();
    expect(recorded).toHaveLength(0);

    // Same throttle window: still no emission.
    dateSpy.mockReturnValue(500);
    report();
    expect(recorded).toHaveLength(0);

    // Window elapsed: emission fires.
    dateSpy.mockReturnValue(1100);
    report();
    expect(recorded).toEqual(['[context-cache]: 3/10 summarized']);

    // Inside the same throttle window: suppressed.
    dateSpy.mockReturnValue(1500);
    report();
    expect(recorded).toHaveLength(1);

    // Window elapsed again: another emission.
    dateSpy.mockReturnValue(2200);
    report();
    expect(recorded).toEqual([
      '[context-cache]: 3/10 summarized',
      '[context-cache]: 5/10 summarized',
    ]);

    // Pin the clock and burn through the remaining four intermediate
    // calls — none of these advance lastEmit's window, so none emit.
    dateSpy.mockReturnValue(2200);
    report(); // done=6
    report(); // done=7
    report(); // done=8
    report(); // done=9
    expect(recorded).toHaveLength(2);

    // The 10th and final call: done === total bypasses the throttle
    // unconditionally and emits the terminating line.
    report();
    expect(recorded[recorded.length - 1]).toBe(
      '[context-cache]: 10/10 summarized',
    );
  });

  it('emits the final <total>/<total> line even when called within the same millisecond', () => {
    const recorded: string[] = [];
    const warn = (msg: string): void => {
      recorded.push(msg);
    };

    // Pin the clock so every call lands at t=0; without the
    // `done === total` short-circuit only the first emission would
    // ever fire (and even that would fail because lastEmit starts
    // at 0 and now - 0 = 0 < 1000).
    dateSpy.mockReturnValue(0);
    const report = makeProgressReporter(3, warn);
    report();
    report();
    expect(recorded).toHaveLength(0);

    report();
    expect(recorded).toEqual(['[context-cache]: 3/3 summarized']);
  });
});
