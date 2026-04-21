/**
 * DOM entry point for the browser-side Forjis Inspector SDK.
 *
 * `mount()` resolves the session URL and token (explicit or meta-tag),
 * appends `<div id="forjis-inspector-root">`, initializes the screen
 * tracker, rehydrates BatchState from sessionStorage, constructs the
 * transport, mounts the overlay + queue panel + clarify panel + sidebar
 * + reply banner + reply sheet inside the overlay shadow, and wires the
 * cross-component callbacks defined in design.md §D-006 (task 011).
 *
 * Teardown order: sidebar → reply banner → reply sheet → clarify panel →
 * queue panel → overlay → screen tracker → client → root removal. BatchState
 * and the history store are NOT destroyed on unmount so a reload can restore
 * them from storage.
 */

import type {
  Batch,
  InspectorMessage,
  Pin,
  PinTarget,
} from '@forjis/shared';
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
import {
  getHistory,
  initHistoryStore,
  pushBatch as historyPushBatch,
  updateStatus as historyUpdateStatus,
  updateSummary as historyUpdateSummary,
} from './history/history-store.js';
import { buildPin } from './pipeline.js';
import {
  detectReplyCandidate,
  type ReplyCandidate,
} from './reply/reply-detect.js';
import {
  createReplyBanner,
  type ReplyBannerHandle,
} from './reply/reply-banner.js';
import {
  createReplySheet,
  type ReplySheetHandle,
} from './reply/reply-sheet.js';
import { InspectorClient } from './transport.js';
import {
  createClarifyPanel,
  type ClarifyPanelHandle,
} from './ui/clarify-panel.js';
import { initOverlay, type OverlayHandle } from './ui/overlay.js';
import {
  createQueuePanel,
  type QueuePanelHandle,
} from './ui/queue-panel.js';
import { createSidebar, type SidebarHandle } from './ui/sidebar.js';
import { generateUuid } from './util/uuid.js';

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

/** Send `pin.create * N` + `batch.submit`; flip local status to "clarifying". */
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

/** Message-router closure shape expected by the inbound wiring. */
type InboundHandler = (msg: InspectorMessage) => void;

/** Immutable bag of dependencies threaded into `createInboundHandler`. */
interface InboundWiringDeps {
  readonly getPanel: () => ClarifyPanelHandle | null;
}

/**
 * Build the `onMessage` handler routing inbound frames to the clarify
 * panel, history store, and BatchState clear.
 *
 * @param deps - Late-bound access to the clarify panel.
 * @returns Typed message handler.
 */
function createInboundHandler(deps: InboundWiringDeps): InboundHandler {
  return (msg) => {
    if (msg.type === 'clarify.question') {
      const current = getBatch();
      const panel = deps.getPanel();
      if (panel && current && msg.batchId === current.id) {
        panel.handleQuestion(msg.question);
      }
      return;
    }
    if (msg.type === 'task.status') {
      const current = getBatch();
      const panel = deps.getPanel();
      if (panel && current && msg.batchId === current.id) {
        panel.handleTaskStatus(msg.status, msg.summary);
      }
      if (msg.summary !== undefined && msg.summary !== null) {
        historyUpdateSummary(msg.batchId, msg.summary);
      }
      historyUpdateStatus(msg.batchId, msg.status);
      if (
        current &&
        msg.batchId === current.id &&
        (msg.status === 'done' || msg.status === 'failed')
      ) {
        batchClear();
      }
      return;
    }
    if (msg.type === 'batch.finalize') {
      const current = getBatch();
      if (current && msg.batchId === current.id) {
        const panel = deps.getPanel();
        if (panel) {
          panel.handleFinalize(msg.taskPath);
        }
        historyPushBatch(current, msg.taskPath);
        batchClear();
      }
      return;
    }
  };
}

/** Closed-over blobs + target retained while the reply banner is open. */
interface PendingCapture {
  readonly target: PinTarget;
  readonly blobs: {
    elementBlob: Blob;
    viewportBlob: Blob;
    computedStyles: Record<string, string>;
  };
}

/**
 * Decode a stored `data:image/png;base64,...` URL back into a Blob so the
 * reply pipeline can feed it to `buildPin` exactly as it would a freshly
 * captured screenshot. Uses `atob` rather than `fetch` so the function
 * works under both modern browsers and jsdom (which does not implement
 * `fetch` on data URLs).
 *
 * @param dataUrl - Data URL produced by `blobToDataUrl`.
 * @returns Promise resolving to an equivalent Blob.
 */
function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    return Promise.resolve(new Blob([], { type: 'application/octet-stream' }));
  }
  const header = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  const mimeMatch = /^data:([^;,]+)(;base64)?$/.exec(header);
  const mime = mimeMatch && mimeMatch[1] ? mimeMatch[1] : 'application/octet-stream';
  const isBase64 = header.includes(';base64');
  try {
    if (isBase64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return Promise.resolve(new Blob([bytes], { type: mime }));
    }
    return Promise.resolve(
      new Blob([decodeURIComponent(payload)], { type: mime }),
    );
  } catch {
    return Promise.resolve(new Blob([], { type: mime }));
  }
}

/** Reply capture bundle fed into `buildPin` by the reply flow. */
interface ReplyCaptureBundle {
  readonly target: PinTarget;
  readonly elementBlob: Blob;
  readonly viewportBlob: Blob;
  readonly computedStyles: Record<string, string>;
}

/**
 * Transform the parent pin into a reply-capture bundle suitable for
 * feeding into `buildPin`. Used by the sidebar-initiated reply path where
 * no fresh screenshot exists.
 *
 * @param pin - Parent pin whose stored data URLs back the new reply.
 * @returns Promise resolving to the reply-capture bundle.
 */
async function bundleFromHistoricPin(pin: Pin): Promise<ReplyCaptureBundle> {
  const elementBlob = await dataUrlToBlob(pin.capture.elementScreenshot);
  const viewportBlob = await dataUrlToBlob(pin.capture.viewportScreenshot);
  let computedStyles: Record<string, string> = {};
  try {
    const parsed = JSON.parse(pin.capture.computedStyles);
    if (parsed && typeof parsed === 'object') {
      computedStyles = parsed as Record<string, string>;
    }
  } catch {
    /* fall back to empty record; facilitator tolerates it. */
  }
  return {
    target: pin.target,
    elementBlob,
    viewportBlob,
    computedStyles,
  };
}

/**
 * Build the reply batch + reply pin and dispatch `pin.create` +
 * `batch.submit` to the transport in that order (FR-011-031).
 *
 * @param client - Transport client.
 * @param payload - Parent linkage + reply comment from the reply sheet.
 * @param capture - Pre-captured blobs for the new pin.
 */
async function dispatchReplyBatch(
  client: InspectorClient,
  payload: {
    parentPinId: string;
    parentBatchId: string;
    parentTaskPath: string;
    comment: string;
  },
  capture: ReplyCaptureBundle,
): Promise<void> {
  const replyPin = await buildPin(
    capture.target,
    payload.comment,
    [],
    {
      elementPng: capture.elementBlob,
      viewportPng: capture.viewportBlob,
      computedStyles: capture.computedStyles,
    },
    { parentPinId: payload.parentPinId },
  );
  const replyBatch: Batch = {
    id: generateUuid(),
    platform: 'web',
    screens: replyPin.screen === null ? [] : [replyPin.screen],
    pins: [replyPin],
    createdAt: new Date().toISOString(),
    parentBatchId: payload.parentBatchId,
    status: 'queued',
  };
  client.send({ type: 'pin.create', batchId: replyBatch.id, pin: replyPin });
  client.send({ type: 'batch.submit', batchId: replyBatch.id });
}

/** Resources built inside {@link mount} and torn down on unmount. */
interface MountContext {
  readonly overlay: OverlayHandle;
  readonly clarifyPanel: ClarifyPanelHandle;
  readonly sidebar: SidebarHandle;
  readonly replyBanner: ReplyBannerHandle;
  readonly replySheet: ReplySheetHandle;
  readonly queuePanel: QueuePanelHandle;
  readonly client: InspectorClient;
  readonly root: HTMLDivElement;
}

/**
 * Construct the client with a late-bound inbound handler. Returns both
 * the client and the setter used to install the clarify panel once it
 * exists.
 */
function makeClient(
  url: string,
  token: string,
): {
  client: InspectorClient;
  setPanel: (panel: ClarifyPanelHandle) => void;
} {
  let clarifyPanel: ClarifyPanelHandle | null = null;
  const handler = createInboundHandler({ getPanel: () => clarifyPanel });
  const client = new InspectorClient({ url, token, onMessage: handler });
  return {
    client,
    setPanel: (panel) => {
      clarifyPanel = panel;
    },
  };
}

/**
 * Wire the overlay, clarify panel, sidebar, reply banner, reply sheet,
 * and queue panel against the shared shadow root, sharing per-mount
 * closure state for reply-flow orchestration.
 *
 * @param client - Transport client used for outbound dispatch.
 * @param root - Host `<div>` appended to `document.body`.
 * @returns Assembled {@link MountContext}.
 */
function wireShadowComponents(
  client: InspectorClient,
  root: HTMLDivElement,
): {
  overlay: OverlayHandle;
  clarifyPanel: ClarifyPanelHandle;
  sidebar: SidebarHandle;
  replyBanner: ReplyBannerHandle;
  replySheet: ReplySheetHandle;
  queuePanel: QueuePanelHandle;
} {
  let pending: PendingCapture | null = null;
  let candidate: ReplyCandidate | null = null;
  let overlayRef: OverlayHandle | null = null;
  let replySheet: ReplySheetHandle | null = null;
  let replyBanner: ReplyBannerHandle | null = null;

  const overlay = initOverlay({
    root,
    onPick: () => undefined,
    onSubmitPin: (pin) => batchAddPin(pin),
    onPickConfirmed: (el, target, blobs) => {
      const current = getBatch();
      if (current !== null && current.status === 'clarifying') {
        return false;
      }
      const found = detectReplyCandidate(el, getHistory());
      if (found === null) {
        return false;
      }
      pending = { target, blobs };
      candidate = found;
      if (replyBanner) {
        replyBanner.show(found.pin.target.componentName);
      }
      return true;
    },
  });
  overlayRef = overlay;

  const shadow = root.shadowRoot;
  if (!shadow) {
    throw new Error('forjis-inspector: overlay failed to attach shadow root');
  }

  replyBanner = createReplyBanner({
    shadow,
    onAccept: () => {
      if (!pending || !candidate || !replySheet) {
        pending = null;
        candidate = null;
        return;
      }
      replySheet.open({
        pin: candidate.pin,
        batch: candidate.batch,
        taskPath: candidate.taskPath,
        summary: candidate.summary,
      });
      // `pending` is not needed once the sheet is open because the reply
      // path uses the parent pin's stored screenshots. Release the Blob
      // reference so GC can reclaim it.
      pending = null;
      candidate = null;
    },
    onDecline: () => {
      if (!pending || !overlayRef) {
        pending = null;
        candidate = null;
        return;
      }
      overlayRef.dispatchPendingCapture(pending.target, pending.blobs);
      pending = null;
      candidate = null;
    },
  });

  replySheet = createReplySheet({
    shadow,
    onSubmitReply: (payload) => {
      void handleReplySubmit(client, payload);
    },
    onCancel: () => undefined,
  });

  const clarifyPanel = createClarifyPanel({
    shadow,
    onSendAnswer: (answer) => {
      const current = getBatch();
      if (!current) {
        return;
      }
      client.send({
        type: 'clarify.answer',
        batchId: current.id,
        answer,
      });
    },
    onAbort: () => {
      const current = getBatch();
      if (!current) {
        return;
      }
      client.send({ type: 'batch.abort', batchId: current.id });
    },
  });

  const sidebar = createSidebar({
    shadow,
    onReply: (ctx) => {
      if (!replySheet) {
        return;
      }
      replySheet.open({
        pin: ctx.pin,
        batch: ctx.batch,
        taskPath: ctx.taskPath,
        summary: ctx.summary,
      });
    },
  });

  const queuePanel = createQueuePanel({
    shadow,
    onSubmitBatch: () => submitBatch(client),
    onNavigateToPin: (pin) => navigateToPin(pin),
  });

  return { overlay, clarifyPanel, sidebar, replyBanner, replySheet, queuePanel };
}

/**
 * Look up the parent pin inside the history store and dispatch the reply
 * batch. Invoked by the reply sheet's Send handler.
 *
 * @param client - Transport client.
 * @param payload - Parent linkage + trimmed comment.
 */
async function handleReplySubmit(
  client: InspectorClient,
  payload: {
    parentPinId: string;
    parentBatchId: string;
    parentTaskPath: string;
    comment: string;
  },
): Promise<void> {
  const history = getHistory();
  const entry = history.find((e) => e.batch.id === payload.parentBatchId);
  if (!entry) {
    return;
  }
  const parentPin = entry.batch.pins.find((p) => p.id === payload.parentPinId);
  if (!parentPin) {
    return;
  }
  const capture = await bundleFromHistoricPin(parentPin);
  await dispatchReplyBatch(client, payload, capture);
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
  initHistoryStore(token);
  const { client, setPanel } = makeClient(url, token);
  const wired = wireShadowComponents(client, root);
  setPanel(wired.clarifyPanel);
  const ctx: MountContext = {
    overlay: wired.overlay,
    clarifyPanel: wired.clarifyPanel,
    sidebar: wired.sidebar,
    replyBanner: wired.replyBanner,
    replySheet: wired.replySheet,
    queuePanel: wired.queuePanel,
    client,
    root,
  };
  const handle = buildHandle(ctx);
  currentHandle = handle;
  return handle;
}

/**
 * Build the {@link InspectorMountHandle} returned by {@link mount}.
 *
 * Teardown order (design.md §D-006): sidebar → reply banner → reply sheet
 * → clarify panel → queue panel → overlay → screen tracker → transport →
 * root removal. BatchState and the history store are NOT destroyed so a
 * reload can rehydrate them via the same token on next mount.
 *
 * @param ctx - Mount context with every teardown-eligible handle.
 * @returns A mount handle.
 */
function buildHandle(ctx: MountContext): InspectorMountHandle {
  const handle: InspectorMountHandle = {
    ready: ctx.client.ready,
    send: (msg: InspectorMessage) => ctx.client.send(msg),
    unmount: () => {
      if (currentHandle !== handle) {
        return;
      }
      currentHandle = null;
      ctx.sidebar.destroy();
      ctx.replyBanner.destroy();
      ctx.replySheet.destroy();
      ctx.clarifyPanel.destroy();
      ctx.queuePanel.destroy();
      ctx.overlay.destroy();
      destroyScreenTracker();
      ctx.client.close();
      if (ctx.root.parentNode) {
        ctx.root.parentNode.removeChild(ctx.root);
      }
    },
  };
  return handle;
}
