# @forjis/vite-inspector

Vite plugin that wires the Forjis Inspector browser SDK into any Vite dev
server. It has three dev-time responsibilities:

- Inject `<meta name="forjis-inspector-url">` and
  `<meta name="forjis-inspector-token">` tags into the served HTML so the
  browser SDK can discover its session configuration.
- Inject a `<script type="module">import { mount } from
  "@forjis/inspector"; mount();</script>` tag so the SDK mounts
  automatically on every dev reload.
- Stamp every `JSXOpeningElement` in `.jsx` / `.tsx` modules with a
  `data-forjis-src="<file>:<line>:<col>"` attribute (and
  `data-forjis-component="<Name>"` on capitalized components) so later
  Inspector tasks can resolve a DOM pin back to the exact source location
  it came from.

The plugin is strictly dev-only — it declares `apply: "serve"`, so
`vite build` never invokes it and no inspector artifacts appear in
production bundles.

## Install

```sh
npm install -D @forjis/vite-inspector
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { forjisInspector } from '@forjis/vite-inspector';

export default defineConfig({
  plugins: [forjisInspector()],
});
```

## Environment variables

The plugin reads two environment variables at dev-time and threads them
into the injected meta tags:

| Variable                 | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `FORJIS_INSPECTOR_URL`   | WebSocket URL the inspector client should connect to.       |
| `FORJIS_INSPECTOR_TOKEN` | Session token the inspector client should join with.        |

`forjis dev` sets both automatically. When neither is set, the plugin
writes empty `content=""` attributes so `mount()` surfaces its
documented "missing url" / "missing token" errors rather than pointing
silently at a URL that does not exist.

## Options

```ts
export interface ForjisInspectorOptions {
  /** Inject meta tags + mount script into index.html. Default true. */
  inject?: boolean;
  /** Stamp JSX elements with data-forjis-src / data-forjis-component. Default true. */
  stamp?: boolean;
  /** Module-id filter for the transform hook. Default /\.[jt]sx$/. */
  include?: RegExp;
  /** Module-id exclusion for the transform hook. Default /node_modules/. */
  exclude?: RegExp;
  /** process.env key carrying the Inspector URL. Default "FORJIS_INSPECTOR_URL". */
  urlEnvVar?: string;
  /** process.env key carrying the session token. Default "FORJIS_INSPECTOR_TOKEN". */
  tokenEnvVar?: string;
}
```

## Dev-only caveat

Because the plugin sets `apply: "serve"`, running `vite build` (or any
command that sets the Vite mode to `build`) skips both the HTML
injection and the JSX stamping. That is intentional — the Inspector is a
development-time overlay and has no role in production bundles.
