/**
 * Jest configuration for @forjis/vite-inspector.
 *
 * Uses the `node` environment — the plugin runs inside Vite's Node process
 * and the unit tests operate purely on strings (HTML input/output) and
 * Babel AST transforms, so no DOM shim is required. Mirrors the
 * `@forjis/inspector` workspace's ts-jest ESM pattern, including the
 * `.js` → source module-name mapper that lets TypeScript sources keep
 * their `.js` extensions on relative imports.
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
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
};
