/**
 * DOM entry point for the browser-side Forjis Inspector SDK.
 *
 * `mount()` is the single caller-facing hook that ships in the scaffold. It
 * resolves the session URL and token (from explicit arguments or the
 * `<meta name="forjis-inspector-*">` tags injected by the Vite plugin),
 * attaches a `<div id="forjis-inspector-root">` placeholder to `document.body`
 * for later overlay UI, and opens an {@link InspectorClient} against the
 * resolved URL.
 *
 * Later Inspector tasks (008–011) render into the root div and call
 * `handle.send(...)` to originate `pin.*` / `batch.*` / `clarify.*` traffic.
 * This scaffold ships only transport + DOM root so those later tasks have a
 * stable place to compose.
 */

import type { InspectorMessage } from '@forjis/shared';
import { InspectorClient } from './transport.js';
import { initOverlay, type OverlayHandle } from './ui/overlay.js';

/** `id` of the root placeholder element appended to `document.body`. */
const ROOT_ELEMENT_ID = 'forjis-inspector-root';

/** `name` attribute of the meta tag that carries the Inspector WebSocket URL. */
const META_URL_NAME = 'forjis-inspector-url';

/** `name` attribute of the meta tag that carries the session token. */
const META_TOKEN_NAME = 'forjis-inspector-token';

/**
 * Caller-supplied configuration for {@link mount}.
 *
 * Both fields are optional — when omitted, {@link mount} reads the matching
 * `<meta name="forjis-inspector-*">` tag. When neither source supplies a
 * value, {@link mount} throws synchronously.
 */
export interface InspectorMountOptions {
  /** Explicit WebSocket URL. Overrides the meta tag when present. */
  readonly url?: string;

  /** Explicit session token. Overrides the meta tag when present. */
  readonly token?: string;
}

/**
 * Handle returned by {@link mount}.
 *
 * Later UI tasks call `send` to originate Inspector messages, await `ready`
 * before surfacing connect state, and call `unmount` during page teardown.
 */
export interface InspectorMountHandle {
  /** Resolves on the first `session.ack`, rejects on first-connect failure. */
  readonly ready: Promise<void>;

  /**
   * Send an outbound {@link InspectorMessage}. Queues until `ready` resolves.
   *
   * @param msg - Inspector message to deliver.
   */
  send(msg: InspectorMessage): void;

  /** Close the session and remove the DOM root. Idempotent. */
  unmount(): void;
}

let currentHandle: InspectorMountHandle | null = null;

/**
 * Return the currently-active mount handle, or `null` when nothing is mounted.
 *
 * Used internally by `unmount.ts` so the free-function `unmount()` export can
 * delegate to the active handle without a circular import of {@link mount}.
 *
 * @returns Active mount handle or `null`.
 */
export function getCurrentHandle(): InspectorMountHandle | null {
  return currentHandle;
}

/**
 * Read a `<meta name="...">` tag's `content` attribute from the current DOM.
 *
 * Returns `null` when the tag is absent, when it has no `content` attribute,
 * or when `content` is the empty string (the meta-tag contract treats an
 * empty value as "unset" so the caller falls through to the error path).
 *
 * @param name - Value of the tag's `name` attribute.
 * @returns The `content` string or `null`.
 */
function readMetaTag(name: string): string | null {
  const selector = 'meta[name="' + name + '"]';
  const element = document.querySelector(selector);
  if (!element) {
    return null;
  }
  const content = element.getAttribute('content');
  if (content === null || content === '') {
    return null;
  }
  return content;
}

/**
 * Mount the Forjis Inspector into the current document.
 *
 * Side effects (synchronous, before the function returns):
 * - Appends `<div id="forjis-inspector-root">` to `document.body`.
 * - Constructs an {@link InspectorClient} and opens its WebSocket.
 *
 * Throws synchronously on the following configuration errors:
 * - A prior mount handle is still active (double-mount).
 * - Neither `options.url` nor the `forjis-inspector-url` meta tag is set.
 * - Neither `options.token` nor the `forjis-inspector-token` meta tag is set.
 *
 * @param options - Optional URL/token overrides; see {@link InspectorMountOptions}.
 * @returns A handle with `ready`, `send`, and `unmount`.
 * @throws {Error} On double-mount or missing configuration.
 */
export function mount(options?: InspectorMountOptions): InspectorMountHandle {
  if (currentHandle !== null) {
    throw new Error('forjis-inspector: already mounted; call unmount() first');
  }
  const url = options?.url ?? readMetaTag(META_URL_NAME);
  if (!url) {
    throw new Error(
      'forjis-inspector: missing url (no options.url and no <meta name="' +
        META_URL_NAME +
        '">)',
    );
  }
  const token = options?.token ?? readMetaTag(META_TOKEN_NAME);
  if (!token) {
    throw new Error(
      'forjis-inspector: missing token (no options.token and no <meta name="' +
        META_TOKEN_NAME +
        '">)',
    );
  }
  const root = document.createElement('div');
  root.id = ROOT_ELEMENT_ID;
  document.body.appendChild(root);
  const client = new InspectorClient({ url, token });
  const overlay = initOverlay({
    root,
    onPick: () => {
      /* task-010: enqueue pin */
    },
    onSubmitPin: (pin) => {
      /* task-010: enqueue pin */
      void pin;
    },
  });
  const handle = buildHandle(client, root, overlay);
  currentHandle = handle;
  return handle;
}

/**
 * Build the {@link InspectorMountHandle} returned by {@link mount}.
 *
 * Extracted to keep `mount()` under the 40-line guideline and to isolate the
 * teardown closure that clears the module-local `currentHandle`. Unmount
 * order: overlay teardown → transport close → DOM removal.
 *
 * @param client - The freshly-constructed transport client.
 * @param root - The root DOM element to remove on unmount.
 * @param overlay - The overlay handle whose `destroy()` runs first.
 * @returns A mount handle wired to {@link client}, {@link root}, and
 *   {@link overlay}.
 */
function buildHandle(
  client: InspectorClient,
  root: HTMLDivElement,
  overlay: OverlayHandle,
): InspectorMountHandle {
  const handle: InspectorMountHandle = {
    ready: client.ready,
    send: (msg: InspectorMessage) => client.send(msg),
    unmount: () => {
      if (currentHandle !== handle) {
        return;
      }
      currentHandle = null;
      overlay.destroy();
      client.close();
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    },
  };
  return handle;
}
