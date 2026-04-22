/**
 * Public entry point for `@forjis/vite-inspector`.
 *
 * Exports a single factory `forjisInspector(options?)` that returns a
 * Vite plugin wired to:
 *
 *   - `transformIndexHtml` — inject two `<meta>` tags and the
 *     `@forjis/inspector` mount script into the dev-served HTML.
 *   - `transform` — run a Babel visitor over `.jsx` / `.tsx` modules and
 *     stamp every `JSXOpeningElement` with a `data-forjis-src`
 *     attribute (and `data-forjis-component` for capitalized
 *     components) so the browser SDK can resolve pins back to source.
 *
 * The plugin is strictly dev-only (`apply: "serve"`); `vite build` runs
 * it not at all, so no inspector artifacts leak into production bundles.
 */

import babel from '@babel/core';
import type { ExistingRawSourceMap } from 'rollup';
import type { Plugin } from 'vite';
import { injectInspectorIntoHtml } from './inject-html.js';
import { createStampPlugin } from './stamp-visitor.js';

/** Default matcher for modules the `transform` hook stamps. */
const DEFAULT_INCLUDE = /\.[jt]sx$/;

/** Default matcher for modules the `transform` hook skips. */
const DEFAULT_EXCLUDE = /node_modules/;

/** Default `process.env` key carrying the Inspector WebSocket URL. */
const DEFAULT_URL_ENV_VAR = 'FORJIS_INSPECTOR_URL';

/** Default `process.env` key carrying the session token. */
const DEFAULT_TOKEN_ENV_VAR = 'FORJIS_INSPECTOR_TOKEN';

/**
 * Options accepted by {@link forjisInspector}. All fields are optional;
 * defaults are shown alongside each property.
 */
export interface ForjisInspectorOptions {
  /**
   * Inject the meta tags + mount script into `index.html`. Default `true`.
   * Set to `false` to keep the HTML hook a no-op (useful when the host
   * project hand-writes the meta tags).
   */
  readonly inject?: boolean;
  /**
   * Stamp JSX opening elements with `data-forjis-src` and
   * `data-forjis-component`. Default `true`.
   */
  readonly stamp?: boolean;
  /**
   * Regular expression matched against the module id. Only matching ids
   * go through the Babel transform. Default `/\.[jt]sx$/`.
   */
  readonly include?: RegExp;
  /**
   * Regular expression matched against the module id. Matching ids are
   * skipped (checked after `include`). Default `/node_modules/`.
   */
  readonly exclude?: RegExp;
  /**
   * `process.env` key whose value becomes the `forjis-inspector-url`
   * meta content. Default `"FORJIS_INSPECTOR_URL"`.
   */
  readonly urlEnvVar?: string;
  /**
   * `process.env` key whose value becomes the `forjis-inspector-token`
   * meta content. Default `"FORJIS_INSPECTOR_TOKEN"`.
   */
  readonly tokenEnvVar?: string;
}

/**
 * Resolved options with defaults applied so the plugin body can read
 * concrete values without repeatedly checking `undefined`.
 */
interface ResolvedOptions {
  readonly inject: boolean;
  readonly stamp: boolean;
  readonly include: RegExp;
  readonly exclude: RegExp;
  readonly urlEnvVar: string;
  readonly tokenEnvVar: string;
}

/**
 * Apply defaults to the caller-supplied options.
 *
 * @param options - Caller input; fully optional.
 * @returns Resolved options with every field populated.
 */
function resolveOptions(
  options: ForjisInspectorOptions | undefined,
): ResolvedOptions {
  return {
    inject: options?.inject !== false,
    stamp: options?.stamp !== false,
    include: options?.include ?? DEFAULT_INCLUDE,
    exclude: options?.exclude ?? DEFAULT_EXCLUDE,
    urlEnvVar: options?.urlEnvVar ?? DEFAULT_URL_ENV_VAR,
    tokenEnvVar: options?.tokenEnvVar ?? DEFAULT_TOKEN_ENV_VAR,
  };
}

/**
 * Shape returned by Vite's `transform` hook when the module was edited.
 * The `map` field matches Rollup's `ExistingRawSourceMap` (what Vite
 * forwards through its source-map chain).
 */
interface StampTransformResult {
  readonly code: string;
  readonly map: ExistingRawSourceMap | null;
}

/**
 * Run the Babel visitor over a single module.
 *
 * @param code - Source code delivered by Vite.
 * @param id - Module id (absolute path) delivered by Vite.
 * @param projectRoot - Vite project root captured in `configResolved`.
 * @returns Transform result or `undefined` when Babel produced nothing.
 */
function runStampTransform(
  code: string,
  id: string,
  projectRoot: string,
): StampTransformResult | undefined {
  const result = babel.transformSync(code, {
    filename: id,
    ast: false,
    sourceMaps: true,
    babelrc: false,
    configFile: false,
    parserOpts: {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    },
    plugins: [createStampPlugin({ projectRoot })],
  });
  if (!result || result.code == null) {
    return undefined;
  }
  const map = (result.map ?? null) as ExistingRawSourceMap | null;
  return { code: result.code, map };
}

/**
 * Factory that builds a Vite plugin stamping JSX source locations and
 * injecting the `@forjis/inspector` mount script into dev HTML.
 *
 * @param options - Optional behavior overrides; see
 *   {@link ForjisInspectorOptions}.
 * @returns Configured Vite `Plugin` object.
 */
/**
 * Virtual module id for the mount bootstrap. Resolved to the `\0`-prefixed
 * form so Vite's loader owns it (no filesystem probe), and exposed to the
 * browser via `/@id/__x00__<VIRTUAL_MOUNT_ID>` — the standard Vite scheme
 * for reaching a virtual module from an HTML `<script src>`.
 */
const VIRTUAL_MOUNT_ID = 'virtual:@forjis/vite-inspector/mount';
const RESOLVED_MOUNT_ID = '\0' + VIRTUAL_MOUNT_ID;
const MOUNT_SCRIPT_URL = '/@id/__x00__' + VIRTUAL_MOUNT_ID;

export function forjisInspector(options?: ForjisInspectorOptions): Plugin {
  const resolved = resolveOptions(options);
  let projectRoot = process.cwd();
  return {
    name: '@forjis/vite-inspector',
    apply: 'serve',
    configResolved(config) {
      projectRoot = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_MOUNT_ID) return RESOLVED_MOUNT_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_MOUNT_ID) {
        // Two-line bootstrap. The bare `@forjis/inspector` import is
        // rewritten by Vite's normal module transform when this virtual
        // module is served, so `modern-screenshot` and every other
        // transitive bare dep also resolve through optimizeDeps.
        return `import { mount } from '@forjis/inspector';\nmount();\n`;
      }
      return null;
    },
    transformIndexHtml(html: string) {
      if (!resolved.inject) {
        return undefined;
      }
      const url = process.env[resolved.urlEnvVar] ?? '';
      const token = process.env[resolved.tokenEnvVar] ?? '';
      return injectInspectorIntoHtml(html, {
        url,
        token,
        mountScriptUrl: MOUNT_SCRIPT_URL,
      });
    },
    transform(code: string, id: string) {
      if (!resolved.stamp) {
        return undefined;
      }
      if (!resolved.include.test(id)) {
        return undefined;
      }
      if (resolved.exclude.test(id)) {
        return undefined;
      }
      return runStampTransform(code, id, projectRoot);
    },
  };
}
