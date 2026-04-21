/**
 * DOM entry point for the browser-side Forjis Inspector SDK.
 *
 * `mount()` resolves the session URL and token (explicit or meta-tag),
 * appends `<div id="forjis-inspector-root">`, initializes the screen
 * tracker, rehydrates BatchState from sessionStorage, constructs the
 * transport, mounts the overlay + queue panel inside the overlay shadow,
 * and wires the cross-component callbacks defined in design.md §D-012.
 *
 * Teardown order (FR-010-019 panel removal, FR-010-012 sessionStorage
 * preserved for reload): queue panel → overlay → screen tracker →
 * client → root removal. BatchState is NOT destroyed on unmount so a
 * reload can restore it.
 */

import type { InspectorMessage, Pin } from '@forjis/shared';
import {
  addPin as batchAddPin,
  clear as batchClear,
  getBatch,
  initBatchState,
  setStatus as batchSetStatus,
} from './queue/batch-state.js';
import {
  destroyScreenTracker,
  initScreenTracker,
} from './queue/screen-tracker.js';
import { InspectorClient } from './transport.js';
import { initOverlay, type OverlayHandle } from './ui/overlay.js';
import {
  createQueuePanel,
  type QueuePanelHandle,
} from './ui/queue-panel.js';

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
 */
export interface InspectorMountHandle {
  /** Resolves on the first `session.ack`, rejects on first-connect failure. */
  readonly ready: Promise<void>;
  /** Send an outbound {@link InspectorMessage}. Queues until `ready` resolves. */
  send(msg: InspectorMessage): void;
  /** Close the session and remove the DOM root. Idempotent. */
  unmount(): void;
}

let currentHandle: InspectorMountHandle | null = null;

/**
 * Return the currently-active mount handle, or `null` when nothing is mounted.
 *
 * @returns Active mount handle or `null`.
 */
export function getCurrentHandle(): InspectorMountHandle | null {
  return currentHandle;
}

/**
 * Read a `<meta name="...">` tag's `content` attribute from the current DOM.
 *
 * @param name - Value of the tag's `name` attribute.
 * @returns The `content` string or `null` when absent or empty.
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
 * Resolve the session URL and token, throwing on missing configuration.
 *
 * @param options - Optional caller-supplied overrides.
 * @returns `{ url, token }` tuple.
 */
function resolveConfig(options?: InspectorMountOptions): {
  url: string;
  token: string;
} {
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
  return { url, token };
}

/**
 * Build the `handleInboundMsg` callback passed to {@link InspectorClient}.
 *
 * Clears the local batch when the server sends `batch.finalize` for the
 * current batch id or `task.status` with a terminal status for the current
 * batch id (FR-010-029).
 *
 * @returns Typed message handler.
 */
function createInboundHandler(): (msg: InspectorMessage) => void {
  return (msg) => {
    const current = getBatch();
    if (!current) {
      return;
    }
    if (msg.type === 'batch.finalize' && msg.batchId === current.id) {
      batchClear();
      return;
    }
    if (
      msg.type === 'task.status' &&
      msg.batchId === current.id &&
      (msg.status === 'done' || msg.status === 'failed')
    ) {
      batchClear();
    }
  };
}

/**
 * Send `pin.create * N` followed by one `batch.submit` and flip local
 * status to `"clarifying"` (FR-010-027, FR-010-028). Does NOT clear the
 * local queue — only terminal server messages do (see
 * {@link createInboundHandler}).
 *
 * @param client - Transport client.
 */
function submitBatch(client: InspectorClient): void {
  const batch = getBatch();
  if (!batch || batch.pins.length === 0) {
    return;
  }
  for (const pin of batch.pins) {
    client.send({ type: 'pin.create', batchId: batch.id, pin });
  }
  client.send({ type: 'batch.submit', batchId: batch.id });
  batchSetStatus('clarifying');
}

/**
 * Navigate to a pin's original screen and scroll its bbox into view.
 * Best-effort: host-app routers may re-render asynchronously, so the
 * scroll is deferred one `requestAnimationFrame` (FR-010-025).
 *
 * @param pin - Pin to navigate to.
 */
function navigateToPin(pin: Pin): void {
  if (pin.screen === null) {
    return;
  }
  if (window.location.pathname !== pin.screen) {
    history.pushState({}, '', pin.screen);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  const doScroll = (): void => {
    const targetY = Math.max(
      0,
      pin.target.bbox.y - window.innerHeight / 2 + pin.target.bbox.h / 2,
    );
    window.scrollTo({ top: targetY, behavior: 'auto' });
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(doScroll);
    return;
  }
  doScroll();
}

/**
 * Mount the Forjis Inspector into the current document.
 *
 * @param options - Optional URL/token overrides.
 * @returns A handle with `ready`, `send`, and `unmount`.
 * @throws {Error} On double-mount or missing configuration.
 */
export function mount(options?: InspectorMountOptions): InspectorMountHandle {
  if (currentHandle !== null) {
    throw new Error('forjis-inspector: already mounted; call unmount() first');
  }
  const { url, token } = resolveConfig(options);
  const root = document.createElement('div');
  root.id = ROOT_ELEMENT_ID;
  document.body.appendChild(root);
  initScreenTracker();
  initBatchState(token);
  const client = new InspectorClient({
    url,
    token,
    onMessage: createInboundHandler(),
  });
  const overlay = initOverlay({
    root,
    onPick: () => {
      /* onSubmitPin receives the finalized pin via the comment-sheet Send path */
    },
    onSubmitPin: (pin) => {
      batchAddPin(pin);
    },
  });
  const shadow = root.shadowRoot;
  if (!shadow) {
    throw new Error('forjis-inspector: overlay failed to attach shadow root');
  }
  const queuePanel = createQueuePanel({
    shadow,
    onSubmitBatch: () => submitBatch(client),
    onNavigateToPin: (pin) => navigateToPin(pin),
  });
  const handle = buildHandle(client, root, overlay, queuePanel);
  currentHandle = handle;
  return handle;
}

/**
 * Build the {@link InspectorMountHandle} returned by {@link mount}.
 *
 * Teardown order: queue panel → overlay → screen tracker → transport →
 * root removal. BatchState is NOT destroyed so a reload can rehydrate it
 * via `initBatchState` on the next mount.
 *
 * @param client - The freshly-constructed transport client.
 * @param root - The root DOM element to remove on unmount.
 * @param overlay - Overlay handle.
 * @param queuePanel - Queue panel handle.
 * @returns A mount handle.
 */
function buildHandle(
  client: InspectorClient,
  root: HTMLDivElement,
  overlay: OverlayHandle,
  queuePanel: QueuePanelHandle,
): InspectorMountHandle {
  const handle: InspectorMountHandle = {
    ready: client.ready,
    send: (msg: InspectorMessage) => client.send(msg),
    unmount: () => {
      if (currentHandle !== handle) {
        return;
      }
      currentHandle = null;
      queuePanel.destroy();
      overlay.destroy();
      destroyScreenTracker();
      client.close();
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    },
  };
  return handle;
}
