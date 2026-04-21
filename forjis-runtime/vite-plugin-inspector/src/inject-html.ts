/**
 * HTML injection helper for `@forjis/vite-inspector`.
 *
 * Produces an augmented HTML string with the two Inspector meta tags and
 * the `mount()` script inserted immediately before the closing `</body>`
 * tag. The helper is idempotent: when the input already carries the
 * `forjis-inspector-url` meta tag (as will be the case on Vite HMR
 * re-invocations of `transformIndexHtml`), the helper returns the input
 * unchanged so duplicate tags are never emitted.
 */

/** `name` attribute of the meta tag that carries the Inspector WebSocket URL. */
const META_URL_NAME = 'forjis-inspector-url';

/** `name` attribute of the meta tag that carries the session token. */
const META_TOKEN_NAME = 'forjis-inspector-token';

/** Marker the idempotency check scans for. */
const IDEMPOTENCY_MARKER = 'name="' + META_URL_NAME + '"';

/**
 * Environment values carried through the meta tags at dev-time.
 */
export interface InspectorInjectEnv {
  /** WebSocket URL the inspector client should connect to. */
  readonly url: string;
  /** Session token the inspector client should join with. */
  readonly token: string;
}

/**
 * Escape a string so it is safe to embed inside an HTML double-quoted
 * attribute value. Replaces `&`, `<`, `>`, and `"` (ampersand first so
 * later substitutions do not double-escape).
 *
 * @param value - Raw attribute value.
 * @returns Escaped attribute value.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the injection block (two meta tags + one module script) that will
 * be inserted into the served HTML.
 *
 * @param env - Url and token sourced from `process.env`.
 * @returns HTML fragment (no surrounding whitespace).
 */
function buildInjectionBlock(env: InspectorInjectEnv): string {
  const urlTag =
    '<meta name="' +
    META_URL_NAME +
    '" content="' +
    escapeAttr(env.url) +
    '">';
  const tokenTag =
    '<meta name="' +
    META_TOKEN_NAME +
    '" content="' +
    escapeAttr(env.token) +
    '">';
  const scriptTag =
    '<script type="module">import { mount } from "@forjis/inspector"; mount();</script>';
  return urlTag + '\n' + tokenTag + '\n' + scriptTag;
}

/**
 * Insert the Inspector injection block into the supplied HTML string.
 *
 * The block is placed immediately before the last `</body>` tag
 * (case-insensitive). When the input contains no `</body>` tag, the
 * block is appended at the end. When the input already carries the
 * Inspector URL meta tag (idempotency guard), the input is returned
 * unchanged.
 *
 * @param html - Served HTML document as produced by Vite's index.html
 *   pipeline.
 * @param env - URL and token resolved from `process.env` at dev-time.
 * @returns Augmented HTML string.
 */
export function injectInspectorIntoHtml(
  html: string,
  env: InspectorInjectEnv,
): string {
  if (html.includes(IDEMPOTENCY_MARKER)) {
    return html;
  }
  const block = buildInjectionBlock(env);
  const bodyCloseMatch = html.match(/<\/body\s*>/gi);
  if (!bodyCloseMatch || bodyCloseMatch.length === 0) {
    return html + block;
  }
  const lastTag = bodyCloseMatch[bodyCloseMatch.length - 1];
  const lastIndex = html.lastIndexOf(lastTag);
  return html.slice(0, lastIndex) + block + html.slice(lastIndex);
}
