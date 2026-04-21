/**
 * Unit tests for the optional `dev` block parser in `build-file.ts`.
 *
 * Mirrors the structure of the `parseBuildFile — inspector block` test
 * suite in `build-file.test.ts`. Covers every scenario enumerated in
 * `specs/build-file-dev-section/spec.md`:
 *
 *   - omitting the block produces `dev: null`
 *   - a full block round-trips every field
 *   - a minimal block (command only) parses cleanly
 *   - missing `command` is reported as a validation error
 *   - out-of-range `port` is reported as a validation error
 *   - unknown keys inside the block are reported as validation errors
 */

import { parseBuildFile } from '../build-file.js';
import { BuildFileValidationError } from '../errors.js';

// --------------------------------------------------------------------------
// parseBuildFile — dev block
// --------------------------------------------------------------------------

describe('parseBuildFile — dev block', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('returns null dev when key is absent', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.dev).toBeNull();
  });

  it('parses a full dev block', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'dev:',
      '  command: "npm run dev"',
      '  cwd: "./app"',
      '  port: 5000',
      '  host: "0.0.0.0"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.dev).toEqual({
      command: 'npm run dev',
      cwd: './app',
      port: 5000,
      host: '0.0.0.0',
    });
  });

  it('parses a minimal dev block with only command', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'dev:',
      '  command: "pnpm dev"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.dev).toEqual({ command: 'pnpm dev' });
  });

  it('reports missing command as a validation error', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'dev:',
      '  port: 4242',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('dev.command'),
        ),
      ).toBe(true);
    }
  });

  it('reports out-of-range port as a validation error', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'dev:',
      '  command: "npm run dev"',
      '  port: 70000',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const msgs = (err as BuildFileValidationError).errors;
      expect(msgs.some((e) => e.includes('dev.port'))).toBe(true);
      expect(msgs.some((e) => e.includes('1024') && e.includes('65535'))).toBe(
        true,
      );
    }
  });

  it('reports unknown keys as validation errors', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'dev:',
      '  command: "npm run dev"',
      '  weird: 1',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('dev: unrecognized key "weird"'),
        ),
      ).toBe(true);
    }
  });

  it('rejects non-object dev', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'dev: "not-an-object"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('"dev" must be an object'),
        ),
      ).toBe(true);
    }
  });
});
