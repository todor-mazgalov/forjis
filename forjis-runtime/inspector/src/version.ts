/**
 * Version metadata surfaced by the `@forjis/inspector` SDK.
 *
 * `PROTOCOL_VERSION` is re-exported verbatim from `@forjis/shared` so SDK
 * consumers have a single import path for both the wire-protocol tag and the
 * npm package version. `PACKAGE_VERSION` is hand-maintained to mirror the
 * workspace's `package.json` (every `@forjis/*` workspace currently ships at
 * literal `"0.5.1"` — an automated bumper is deferred per design A-006).
 */

export { PROTOCOL_VERSION } from '@forjis/shared';

/**
 * Published npm version of the `@forjis/inspector` package.
 *
 * Hand-synchronised with `package.json` — keep the literal in lockstep when
 * the workspace version bumps.
 */
export const PACKAGE_VERSION = '0.5.1' as const;
