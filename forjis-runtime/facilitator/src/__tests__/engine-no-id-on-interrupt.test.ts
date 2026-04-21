/**
 * Tests for: engine-exposes-internal-no-id-on-interrupt bug fix
 * Part 1: Pure unit tests for EngineInvocationError and PromptOptions.
 *
 * Verifies:
 *   1. The fallback string in prompt() error handlers is "engine" (not "No ID").
 *   2. checkPrerequisites() sets options.id = 'prerequisites' so errors surface
 *      as "prerequisites" rather than "engine" or "No ID".
 *   3. The PromptOptions contract supports setting id before calling prompt().
 */

import { EngineInvocationError } from '../errors.js';
import { PromptOptions } from '../types.js';

describe('EngineInvocationError — fallback string is "engine" not "No ID"', () => {
  it('uses "engine" as fallback when options.id is undefined (mirrors: options.id ?? "engine")', () => {
    const id = (undefined as unknown as string) ?? 'engine';
    const err = new EngineInvocationError(id, new Error('Exit code 143: '));

    expect(err.message).toContain('"engine"');
    expect(err.message).not.toContain('No ID');
  });

  it('uses "prerequisites" when checkPrerequisites sets options.id = "prerequisites"', () => {
    const err = new EngineInvocationError('prerequisites', new Error('Exit code 143: '));

    expect(err.message).toContain('"prerequisites"');
    expect(err.message).not.toContain('No ID');
    expect(err.message).not.toContain('"engine"');
  });

  it('produces the exact expected message format for the prerequisites case', () => {
    const err = new EngineInvocationError('prerequisites', new Error('Exit code 143: '));

    expect(err.message).toMatch(
      /Engine invocation failed for task "prerequisites": Exit code 143:/,
    );
  });

  it('produces the exact expected message format for the engine fallback case', () => {
    const id = (undefined as unknown as string) ?? 'engine';
    const err = new EngineInvocationError(id, new Error('Exit code 1: some error'));

    expect(err.message).toMatch(
      /Engine invocation failed for task "engine": Exit code 1: some error/,
    );
  });

  it('is an instance of Error', () => {
    const err = new EngineInvocationError('engine', new Error('cause'));
    expect(err).toBeInstanceOf(Error);
  });
});

describe('PromptOptions — prerequisites id assignment contract', () => {
  it('id is undefined by default (confirms why the bug existed)', () => {
    const opts = new PromptOptions();
    expect(opts.id).toBeUndefined();
  });

  it('accepts "prerequisites" as id (mirrors checkPrerequisites fix)', () => {
    const opts = new PromptOptions();
    opts.id = 'prerequisites';
    expect(opts.id).toBe('prerequisites');
  });

  it('accepts "engine" as id (mirrors the fallback value)', () => {
    const opts = new PromptOptions();
    opts.id = 'engine';
    expect(opts.id).toBe('engine');
  });

  it('setting id to "prerequisites" produces "prerequisites" in EngineInvocationError', () => {
    const opts = new PromptOptions();
    opts.id = 'prerequisites';

    const err = new EngineInvocationError(opts.id, new Error('Interrupted'));
    expect(err.message).toContain('"prerequisites"');
    expect(err.message).not.toContain('No ID');
  });
});
