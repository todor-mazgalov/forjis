# @forjis/inspector

Browser-runtime SDK for the Forjis Inspector. This scaffold ships the
WebSocket transport + DOM root placeholder that later Inspector tasks build
on. **WIP — the user-facing overlay, element picker, pin capture, and
clarify-chat UI land in tasks 008 through 011.**

## Install

`@forjis/inspector` is published as a workspace member of the Forjis runtime
monorepo. Consumers inside the monorepo pick it up via the root `npm install`:

```json
{
  "dependencies": {
    "@forjis/inspector": "0.5.1"
  }
}
```

External apps (for example a Vite-hosted UI under development) can add it
through a `file:` reference or, once published, through the standard npm
registry. The package ships only an ESM build — bundlers that target modern
browsers resolve `dist/index.js` via the `"."` export.

## Usage

Either pass the WebSocket URL and session token explicitly:

```ts
import { mount } from '@forjis/inspector';

const handle = mount({
  url: 'ws://127.0.0.1:8123/inspector/ws?t=<session-token>',
  token: '<session-token>',
});

await handle.ready;
```

Or rely on the `<meta>` tags that the Forjis Vite plugin injects into the
host app's HTML (task 012):

```html
<meta name="forjis-inspector-url" content="ws://127.0.0.1:8123/inspector/ws?t=..." />
<meta name="forjis-inspector-token" content="..." />
<script type="module">
  import { mount } from '@forjis/inspector';
  mount();
</script>
```

Call `handle.unmount()` (or the free-function `unmount()` exported by the
barrel) to close the socket and remove the root element.

## Protocol

The transport speaks the v1.0 Inspector protocol frozen in
`@forjis/shared`. The server side is implemented at
`forjis-runtime/web/src/inspector-ws.ts` — refer to that file for the
upgrade-time token check, the 5 s handshake timer, and the server-side
close-code matrix.

## Surface

- `mount(options?)` — attaches `<div id="forjis-inspector-root">`, opens
  the WebSocket, returns a handle.
- `unmount()` — tears down the active mount (no-op when nothing is
  mounted).
- `InspectorClient` — raw transport for tests and advanced consumers.
- `InspectorSessionError` — typed error surfaced through `ready`
  rejections and the `onError` callback.
- `version` — namespace exporting `PROTOCOL_VERSION` and
  `PACKAGE_VERSION`.
