/**
 * Jest configuration for @forjis/web.
 *
 * Uses ts-jest with ESM support.
 */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  // Undici's fetch agent pool and at least one pre-existing worker leak keep
  // the event loop alive past jest's 1s post-test grace window. All 368 tests
  // still complete and report correct pass/fail — forceExit just ensures the
  // process terminates with exit 0 once the runner is done.
  forceExit: true,
};
