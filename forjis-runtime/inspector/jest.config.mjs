/**
 * Jest configuration for @forjis/inspector.
 *
 * Uses the jsdom environment so `document` / `HTMLMetaElement` / the default
 * `WebSocket` binding are available. `mock-socket` installs its own shim at
 * test time by creating a `Server` at the test URL; any `new WebSocket(url)`
 * with the matching URL is then intercepted.
 */
export default {
  testEnvironment: 'jsdom',
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
