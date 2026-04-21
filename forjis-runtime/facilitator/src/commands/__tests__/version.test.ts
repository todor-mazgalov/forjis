/**
 * Unit tests for the version command.
 *
 * Validates that getComponentVersions() returns all expected keys
 * and that versionCommand() prints formatted output to stdout.
 */

import { jest } from '@jest/globals';
import { getComponentVersions, versionCommand } from '../version.js';

const SEMVER_OR_UNKNOWN = /^\d+\.\d+\.\d+(-[\w.]+)?$|^unknown$/;

describe('getComponentVersions', () => {
  it('returns an object with all four component keys', () => {
    const versions = getComponentVersions();
    expect(versions).toHaveProperty('cli');
    expect(versions).toHaveProperty('facilitator');
    expect(versions).toHaveProperty('orchestrator');
    expect(versions).toHaveProperty('web');
  });

  it('returns valid semver strings or "unknown" for each component', () => {
    const versions = getComponentVersions();
    for (const [key, value] of Object.entries(versions)) {
      expect(value).toMatch(SEMVER_OR_UNKNOWN);
    }
  });

  it('returns "unknown" for all components when packages are unresolvable', async () => {
    await jest.isolateModulesAsync(async () => {
      // Mock node:module so createRequire returns a require that always throws,
      // simulating unresolvable packages and exercising the error-handling path.
      const failingRequire = () => {
        throw new Error('Cannot find module');
      };
      failingRequire.resolve = () => { throw new Error('Cannot find module'); };

      jest.unstable_mockModule('node:module', () => ({
        createRequire: () => failingRequire,
      }));

      // Dynamic import within isolateModulesAsync gets a fresh module graph
      const { getComponentVersions: getVersionsMocked } = await import('../version.js');
      const versions = getVersionsMocked();

      expect(versions.cli).toBe('unknown');
      expect(versions.facilitator).toBe('unknown');
      expect(versions.orchestrator).toBe('unknown');
      expect(versions.web).toBe('unknown');
    });
  });
});

describe('versionCommand', () => {
  it('prints columnar output starting with "forjis versions:"', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    versionCommand();

    expect(spy).toHaveBeenCalledWith('forjis versions:');

    const calls = spy.mock.calls.map((c) => c[0] as string);
    expect(calls).toContainEqual(expect.stringContaining('cli:'));
    expect(calls).toContainEqual(expect.stringContaining('facilitator:'));
    expect(calls).toContainEqual(expect.stringContaining('orchestrator:'));
    expect(calls).toContainEqual(expect.stringContaining('web:'));

    spy.mockRestore();
  });

  it('aligns labels to a fixed column width', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    versionCommand();

    const lines = spy.mock.calls
      .map((c) => c[0] as string)
      .filter((l) => l.startsWith('  '));

    for (const line of lines) {
      // Each line: "  <label padded to 14>version"
      // The label portion (after 2 leading spaces) should be 14 chars
      const labelPart = line.slice(2, 16);
      expect(labelPart).toHaveLength(14);
    }

    spy.mockRestore();
  });
});
