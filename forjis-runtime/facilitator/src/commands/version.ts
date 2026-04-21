/**
 * Version command for @forjis/cli.
 *
 * Reads the version field from each runtime component's package.json
 * and prints a formatted, columnar summary to stdout.
 */

import { createRequire } from 'node:module';

/** Fixed column width for label alignment (accommodates "orchestrator:"). */
const LABEL_WIDTH = 14;

/** Map of component short names to their resolved versions. */
export interface ComponentVersions {
  cli: string;
  facilitator: string;
  orchestrator: string;
  web: string;
}

/**
 * Reads the version field from each runtime component's package.json.
 *
 * Returns "unknown" for any component whose package.json cannot be resolved.
 */
export function getComponentVersions(): ComponentVersions {
  const require = createRequire(import.meta.url);

  const resolve = (pkg: string): string => {
    try {
      const json = require(`${pkg}/package.json`) as { version: string };
      return json.version;
    } catch {
      return 'unknown';
    }
  };

  return {
    cli: resolve('@forjis/cli'),
    facilitator: resolve('@forjis/facilitator'),
    orchestrator: resolve('@forjis/orchestrator'),
    web: resolve('@forjis/web'),
  };
}

/**
 * Prints all component versions to stdout in columnar format.
 *
 * Output format:
 *   forjis versions:
 *     cli:          x.y.z
 *     facilitator:  x.y.z
 *     orchestrator: x.y.z
 *     web:          x.y.z
 */
export function versionCommand(): void {
  const versions = getComponentVersions();

  console.log('forjis versions:');
  for (const [name, version] of Object.entries(versions)) {
    const label = `${name}:`.padEnd(LABEL_WIDTH);
    console.log(`  ${label}${version}`);
  }
}
