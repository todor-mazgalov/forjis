/**
 * Jest configuration for @forjis/facilitator.
 *
 * Uses ts-jest with ESM support. Tests using jest.mock() for
 * node:child_process work because ts-jest hoists mock calls.
 */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@forjis/resolver$': '<rootDir>/../resolver/dist/index.js',
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
};
