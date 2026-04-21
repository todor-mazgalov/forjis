/**
 * Test helpers for config writer tests.
 *
 * Provides factory functions for creating mock WriterContext objects
 * with realistic defaults.
 */

import { join } from 'node:path';
import { jest } from '@jest/globals';

import type {
  BuildConfig,
  ChecksumCache,
  ChecksumEntry,
  RuntimeConfig,
  WriterContext,
} from '../../types.js';
import type { ResourceRegistry } from '../../repo/index.js';

/**
 * Creates a test WriterContext with a mock registry and minimal config.
 *
 * @param projectDir - The temp directory to use as the project root.
 * @param existingEntries - Optional cache entries from a previous write.
 * @returns A WriterContext ready for use in tests.
 */
export function createTestContext(
  projectDir: string,
  existingEntries?: Record<string, ChecksumEntry>
): WriterContext {
  const configDir = join(projectDir, '.forjis', 'config');

  const previousCache: ChecksumCache | null = existingEntries
    ? { owner: 'resolver', version: '1', entries: existingEntries }
    : null;

  return {
    projectDir,
    configDir,
    config: createMinimalRuntimeConfig(),
    buildConfig: createMinimalBuildConfig(),
    registry: createMockRegistry(),
    cacheEntries: {},
    previousCache,
    plugins: [],
  };
}

/**
 * Creates a minimal RuntimeConfig for testing.
 */
function createMinimalRuntimeConfig(): RuntimeConfig {
  return {
    orgs: [
      {
        name: 'test-org',
        teams: [
          {
            name: 'default',
            roles: [
              {
                name: 'Developer',
                agent: 'dev-agent',
                skills: ['typescript'],
                hooks: { pre: ['lint-check'], validation: [], post: [] },
              },
            ],
          },
        ],
      },
    ],
    metrics: new Map(),
    outcomeRules: [],
    outcomeEnabled: true,
    defaultAction: 'halt',
    defaultMaxRetries: 1,
    pipeline: null,
    allowedTools: [],
    tokenBudget: { maxTokens: 500000, resetWindowMs: 3600000 },
    resolvedConstraints: { mandatory: 'Do not push to main.', optional: '', pillars: [] },
    healthCheck: { interval: 300, maxRetries: 3 },
  };
}

/**
 * Creates a minimal BuildConfig for testing.
 */
function createMinimalBuildConfig(): BuildConfig {
  return {
    version: 1,
    repositories: [{ type: 'git', url: 'https://github.com/org/repo.git', ref: 'v1' }],
    plugins: [],
    orgs: [],
    tasks: { source: 'dir', path: './tasks', pollIntervalMs: 300000, autoDependencies: false, maxConcurrent: 2 },
    outcome: null,
    tokenBudget: { maxTokens: 500000, resetWindowMs: 3600000 },
    constraints: { include: [], mandatory: 'Do not push to main.', optional: '', pillars: [] },
    personas: null,
    healthCheck: { interval: 300, maxRetries: 3 },
  };
}

/**
 * Creates a mock ResourceRegistry that returns predictable file paths.
 */
function createMockRegistry(): ResourceRegistry {
  return {
    resolve: jest.fn().mockImplementation((type: string, name: string) => ({
      type,
      name,
      repoName: 'test-repo',
      filePath: `/cache/test-repo/${type}s/${name}.md`,
    })),
    listAll: jest.fn().mockReturnValue([]),
    listByType: jest.fn().mockReturnValue([]),
    getConflicts: jest.fn().mockReturnValue(new Map()),
    parseQualifiedName: jest.fn().mockImplementation((input: string) => ({ name: input })),
  } as unknown as ResourceRegistry;
}
