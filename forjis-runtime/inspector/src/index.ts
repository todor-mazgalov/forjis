/**
 * Public barrel for the `@forjis/inspector` SDK package.
 *
 * Re-exports the DOM entry points (`mount` / `unmount`), the transport-level
 * types used by tests and advanced consumers, and the `version` namespace so
 * host apps can inspect the shipped protocol and package versions.
 *
 * Later Inspector tasks (008–011) will extend this barrel with overlay,
 * picker, and clarify surfaces. Keep this file lean to preserve a stable
 * `"."` export per the workspace's `package.json`.
 */

export { mount } from './mount.js';
export type {
  InspectorMountOptions,
  InspectorMountHandle,
} from './mount.js';
export { unmount } from './unmount.js';
export {
  InspectorClient,
  InspectorSessionError,
} from './transport.js';
export type {
  InspectorClientOptions,
  InspectorSessionErrorCode,
} from './transport.js';
export * as version from './version.js';
