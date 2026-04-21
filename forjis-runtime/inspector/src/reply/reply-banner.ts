/**
 * Reply-banner factory (design.md §D-004, FR-011-021).
 *
 * A tiny sticky band hosted inside the overlay shadow root that asks the
 * user whether to reply to a previously-pinned element or start a fresh
 * pin. The caller (`mount.ts`) wires `onAccept` / `onDecline` to open the
 * reply sheet or dispatch the pending capture to the ordinary comment
 * sheet.
 *
 * Module boundaries (NFR-011-002): vanilla DOM, no transport, no mount.
 */

/** Init options accepted by {@link createReplyBanner}. */
export interface InitReplyBannerOptions {
  /** Overlay shadow root. */
  readonly shadow: ShadowRoot;
  /** Invoked when the user activates the Yes control. */
  readonly onAccept: () => void;
  /** Invoked when the user activates the No control. */
  readonly onDecline: () => void;
}

/** Handle returned by {@link createReplyBanner}. */
export interface ReplyBannerHandle {
  /** The banner root element (mounted inside the supplied shadow root). */
  readonly element: HTMLElement;
  /** Show the banner with the supplied (nullable) component name. */
  show(componentName: string | null): void;
  /** Hide the banner (set `data-open="false"`). */
  hide(): void;
  /** Remove listeners and DOM. Idempotent. */
  destroy(): void;
}

/** Inline CSS for the reply banner. */
const REPLY_BANNER_STYLE = `
div[data-forjis-reply-banner] {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: auto;
  z-index: 20;
  font: 13px/1.4 system-ui, -apple-system, sans-serif;
  box-sizing: border-box;
}
div[data-forjis-reply-banner][data-open="false"] { display: none; }
.reply-banner-message { flex: 1; }
.reply-banner-yes, .reply-banner-no {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
  box-sizing: border-box;
}
.reply-banner-yes {
  background: #2563eb;
  color: #ffffff;
  border: 1px solid #1d4ed8;
}
.reply-banner-no {
  background: #ffffff;
  color: #374151;
  border: 1px solid #d1d5db;
}
`;

/**
 * Build a reply banner and mount it into `opts.shadow`. Starts hidden.
 *
 * @param opts - Init options.
 * @returns A {@link ReplyBannerHandle}.
 */
export function createReplyBanner(
  opts: InitReplyBannerOptions,
): ReplyBannerHandle {
  const root = document.createElement('div');
  root.setAttribute('data-forjis-reply-banner', 'true');
  root.setAttribute('data-open', 'false');
  const style = document.createElement('style');
  style.textContent = REPLY_BANNER_STYLE;
  root.appendChild(style);
  const msg = document.createElement('span');
  msg.className = 'reply-banner-message';
  msg.textContent = '';
  root.appendChild(msg);
  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'reply-banner-yes';
  yesBtn.textContent = 'Yes, reply';
  root.appendChild(yesBtn);
  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'reply-banner-no';
  noBtn.textContent = 'No, new pin';
  root.appendChild(noBtn);
  opts.shadow.appendChild(root);
  let destroyed = false;

  const show = (componentName: string | null): void => {
    msg.textContent =
      componentName !== null && componentName.length > 0
        ? 'Looks like your previous pin on ' + componentName + '. Reply to it?'
        : 'Looks like your previous pin. Reply to it?';
    root.setAttribute('data-open', 'true');
  };

  const hide = (): void => {
    root.setAttribute('data-open', 'false');
  };

  yesBtn.addEventListener('click', () => {
    hide();
    opts.onAccept();
  });
  noBtn.addEventListener('click', () => {
    hide();
    opts.onDecline();
  });

  return {
    element: root,
    show,
    hide,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    },
  };
}
