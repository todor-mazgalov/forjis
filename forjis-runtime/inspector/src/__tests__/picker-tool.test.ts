/**
 * Unit tests for `ui/picker-tool.ts`.
 *
 * Covers FR-010-033 scenarios 1..3: default `"element"`; setTool notifies
 * listeners; unsubscribe stops notifications; reset clears state.
 */

import { jest } from '@jest/globals';
import {
  __resetPickerToolForTests,
  getTool,
  onToolChange,
  setTool,
} from '../ui/picker-tool.js';

describe('picker-tool', () => {
  beforeEach(() => {
    __resetPickerToolForTests();
  });

  afterEach(() => {
    __resetPickerToolForTests();
  });

  it('default tool is "element" (FR-010-033 scenario 1)', () => {
    expect(getTool()).toBe('element');
  });

  it('setTool notifies listeners on change', () => {
    const fn = jest.fn();
    onToolChange(fn);
    setTool('region');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('region');
    expect(getTool()).toBe('region');
  });

  it('setTool is a no-op when the tool is unchanged', () => {
    const fn = jest.fn();
    onToolChange(fn);
    setTool('element'); // default is already "element"
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const fn = jest.fn();
    const unsub = onToolChange(fn);
    setTool('region');
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    setTool('element');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('__resetPickerToolForTests clears state', () => {
    setTool('region');
    expect(getTool()).toBe('region');
    __resetPickerToolForTests();
    expect(getTool()).toBe('element');
  });
});
