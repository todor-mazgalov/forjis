/**
 * Unit tests for {@link injectInspectorIntoHtml} and the plugin-factory
 * surface exposed by {@link forjisInspector}.
 *
 * Exercises FR-005 (injection order), FR-006 (idempotency), the missing
 * `</body>` fallback, attribute escaping, and FR-003/FR-004 (plugin shape
 * + `apply: "serve"`). Additional reviewer tests cover FR-003 options
 * behavior (inject/stamp false, include/exclude filters), FR-005
 * empty-env fallback, script-payload escaping, FR-006 documented
 * behavior when values differ, and FR-011 source-map return shape.
 */

import { forjisInspector } from '../index.js';
import { injectInspectorIntoHtml } from '../inject-html.js';

describe('injectInspectorIntoHtml', () => {
  it('injects meta tags and the mount script before </body> in the documented order', () => {
    const html = '<html><body><div id="app"></div></body></html>';
    const out = injectInspectorIntoHtml(html, {
      url: 'ws://localhost:5173/inspector',
      token: 'tkn',
    });
    const urlIdx = out.indexOf(
      '<meta name="forjis-inspector-url" content="ws://localhost:5173/inspector">',
    );
    const tokenIdx = out.indexOf(
      '<meta name="forjis-inspector-token" content="tkn">',
    );
    const scriptIdx = out.indexOf(
      '<script type="module">import { mount } from "@forjis/inspector"; mount();</script>',
    );
    const bodyIdx = out.lastIndexOf('</body>');
    expect(urlIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThan(urlIdx);
    expect(scriptIdx).toBeGreaterThan(tokenIdx);
    expect(bodyIdx).toBeGreaterThan(scriptIdx);
  });

  it('is idempotent — a second invocation returns byte-identical output', () => {
    const html = '<html><body><div id="app"></div></body></html>';
    const env = { url: 'ws://x/ws', token: 't' };
    const first = injectInspectorIntoHtml(html, env);
    const second = injectInspectorIntoHtml(first, env);
    expect(second).toBe(first);
  });

  it('appends the block at end when the input lacks </body>', () => {
    const html = '<!doctype html><p>no body tag</p>';
    const out = injectInspectorIntoHtml(html, {
      url: 'ws://x/ws',
      token: 't',
    });
    expect(out.startsWith(html)).toBe(true);
    expect(out).toContain('<meta name="forjis-inspector-url"');
    expect(out).toContain('<meta name="forjis-inspector-token"');
    expect(out).toContain('import { mount } from "@forjis/inspector"');
  });

  it('escapes &, <, >, and " inside attribute values', () => {
    const html = '<html><body></body></html>';
    const out = injectInspectorIntoHtml(html, {
      url: 'ws://x?q="1"&y=<2>',
      token: 'a"b&c<d>e',
    });
    expect(out).toContain(
      '<meta name="forjis-inspector-url" content="ws://x?q=&quot;1&quot;&amp;y=&lt;2&gt;">',
    );
    expect(out).toContain(
      '<meta name="forjis-inspector-token" content="a&quot;b&amp;c&lt;d&gt;e">',
    );
  });

  it('encodes a script-injection token payload as escaped attribute text', () => {
    const html = '<html><body></body></html>';
    const out = injectInspectorIntoHtml(html, {
      url: '',
      token: '"><script>alert(1)</script>',
    });
    // The raw script tag payload must NOT appear verbatim inside the meta
    // tag — it must be HTML-encoded so a browser cannot execute it.
    expect(out).toContain(
      '<meta name="forjis-inspector-token" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">',
    );
    expect(out).not.toContain(
      '<meta name="forjis-inspector-token" content=""><script>',
    );
  });

  it('uses the documented meta-tag name constants verbatim', () => {
    const html = '<html><body></body></html>';
    const out = injectInspectorIntoHtml(html, { url: 'u', token: 't' });
    // These attribute-name spellings are load-bearing — they are what the
    // @forjis/inspector SDK scans for via META_URL_NAME / META_TOKEN_NAME.
    expect(out).toContain('name="forjis-inspector-url"');
    expect(out).toContain('name="forjis-inspector-token"');
  });

  it('idempotently skips re-injection even when env values change (documented behavior)', () => {
    // D-003 step 1 + FR-006: when the marker is present, the helper returns
    // the input verbatim. A later env change does NOT refresh the meta. This
    // test pins that behavior so regressions are visible.
    const first = injectInspectorIntoHtml(
      '<html><body></body></html>',
      { url: 'ws://initial', token: 'tkn-initial' },
    );
    const second = injectInspectorIntoHtml(first, {
      url: 'ws://CHANGED',
      token: 'tkn-CHANGED',
    });
    expect(second).toBe(first);
    expect(second).not.toContain('ws://CHANGED');
    expect(second).not.toContain('tkn-CHANGED');
  });
});

describe('forjisInspector()', () => {
  it('returns a plugin with the documented name, apply mode, and hook functions', () => {
    const plugin = forjisInspector();
    expect(plugin.name).toBe('@forjis/vite-inspector');
    expect(plugin.apply).toBe('serve');
    expect(typeof plugin.transformIndexHtml).toBe('function');
    expect(typeof plugin.transform).toBe('function');
  });

  it('transformIndexHtml returns undefined when options.inject === false', () => {
    const plugin = forjisInspector({ inject: false });
    // The hook may be an object-form descriptor; we accept either the raw
    // function or the {handler} form. The plugin wires the bare function,
    // so invoke it directly.
    const hook = plugin.transformIndexHtml as (html: string) => unknown;
    const result = hook('<html><body></body></html>');
    expect(result).toBeUndefined();
  });

  it('transformIndexHtml falls back to empty strings when env vars are unset', () => {
    const prevUrl = process.env.FORJIS_INSPECTOR_URL;
    const prevToken = process.env.FORJIS_INSPECTOR_TOKEN;
    delete process.env.FORJIS_INSPECTOR_URL;
    delete process.env.FORJIS_INSPECTOR_TOKEN;
    try {
      const plugin = forjisInspector();
      const hook = plugin.transformIndexHtml as (html: string) => string;
      const out = hook('<html><body></body></html>');
      // D-003 "Env-var fallback": empty content, NOT a fabricated URL.
      expect(out).toContain('<meta name="forjis-inspector-url" content="">');
      expect(out).toContain('<meta name="forjis-inspector-token" content="">');
    } finally {
      if (prevUrl !== undefined) process.env.FORJIS_INSPECTOR_URL = prevUrl;
      if (prevToken !== undefined) process.env.FORJIS_INSPECTOR_TOKEN = prevToken;
    }
  });

  it('transform returns undefined when options.stamp === false', () => {
    const plugin = forjisInspector({ stamp: false });
    const hook = plugin.transform as (code: string, id: string) => unknown;
    const result = hook('const x = <div/>;', '/project/src/a.tsx');
    expect(result).toBeUndefined();
  });

  it('transform returns undefined for a plain .js id (fails the default include)', () => {
    const plugin = forjisInspector();
    const hook = plugin.transform as (code: string, id: string) => unknown;
    const result = hook('export const x = 1;', '/project/src/plain.js');
    expect(result).toBeUndefined();
  });

  it('transform returns undefined for an id inside node_modules (matches default exclude)', () => {
    const plugin = forjisInspector();
    const hook = plugin.transform as (code: string, id: string) => unknown;
    const result = hook(
      'export const x = () => <div/>;',
      '/project/node_modules/some-pkg/dist/index.tsx',
    );
    expect(result).toBeUndefined();
  });

  it('transform returns a { code, map } object for a JSX module id (FR-011)', () => {
    const plugin = forjisInspector();
    const hook = plugin.transform as (
      code: string,
      id: string,
    ) => { code: string; map: unknown } | undefined;
    const result = hook(
      'const tree = <div/>;\n',
      '/project/src/fixture.tsx',
    );
    expect(result).toBeDefined();
    expect(typeof result!.code).toBe('string');
    expect(result!.code).toContain('data-forjis-src=');
    expect(result!.map).not.toBeNull();
    expect(typeof result!.map).toBe('object');
  });

  it('respects a custom include regex so non-matching ids are left alone', () => {
    const plugin = forjisInspector({ include: /\.only-tsx$/ });
    const hook = plugin.transform as (code: string, id: string) => unknown;
    // A standard .tsx would match the default include but is now excluded
    // by the custom include.
    expect(hook('const t = <div/>;', '/project/src/a.tsx')).toBeUndefined();
  });

  it('respects a custom exclude regex so matching ids are skipped', () => {
    const plugin = forjisInspector({ exclude: /vendor\// });
    const hook = plugin.transform as (code: string, id: string) => unknown;
    expect(
      hook('const t = <div/>;', '/project/vendor/thing.tsx'),
    ).toBeUndefined();
  });
});
