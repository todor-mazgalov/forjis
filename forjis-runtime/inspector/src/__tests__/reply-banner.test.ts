/**
 * Unit tests for the reply-banner factory.
 *
 * Covers FR-011-021 (Yes → onAccept, No → onDecline, banner text includes
 * the component name, banner hides on either action) and NFR-011-002
 * (module boundary scan: no transport/mount/WebSocket imports).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReplyBanner } from '../reply/reply-banner.js';

/** Attach a fresh shadow root for each test. */
function attachShadow(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  return { host, shadow };
}

describe('reply-banner', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('FR-011-021 — show() renders banner text that includes the component name', () => {
    const { shadow } = attachShadow();
    const handle = createReplyBanner({
      shadow,
      onAccept: () => undefined,
      onDecline: () => undefined,
    });
    handle.show('Footer');
    const root = shadow.querySelector(
      '[data-forjis-reply-banner]',
    ) as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-open')).toBe('true');
    expect(root?.textContent ?? '').toContain('Footer');
    expect(root?.textContent ?? '').toMatch(/reply/i);
  });

  it('FR-011-021 — show(null) falls back to a generic message without a component name', () => {
    const { shadow } = attachShadow();
    const handle = createReplyBanner({
      shadow,
      onAccept: () => undefined,
      onDecline: () => undefined,
    });
    handle.show(null);
    const root = shadow.querySelector(
      '[data-forjis-reply-banner]',
    ) as HTMLElement;
    const msg = root.querySelector('.reply-banner-message') as HTMLElement;
    expect(msg.textContent).toBe('Looks like your previous pin. Reply to it?');
    expect(root.getAttribute('data-open')).toBe('true');
  });

  it('FR-011-021 — Yes invokes onAccept exactly once and hides the banner', () => {
    const { shadow } = attachShadow();
    let acceptCount = 0;
    let declineCount = 0;
    const handle = createReplyBanner({
      shadow,
      onAccept: () => {
        acceptCount += 1;
      },
      onDecline: () => {
        declineCount += 1;
      },
    });
    handle.show('Footer');
    const root = shadow.querySelector(
      '[data-forjis-reply-banner]',
    ) as HTMLElement;
    const yesBtn = root.querySelector(
      '.reply-banner-yes',
    ) as HTMLButtonElement;
    yesBtn.click();
    expect(acceptCount).toBe(1);
    expect(declineCount).toBe(0);
    expect(root.getAttribute('data-open')).toBe('false');
  });

  it('FR-011-021 — No invokes onDecline exactly once and hides the banner', () => {
    const { shadow } = attachShadow();
    let acceptCount = 0;
    let declineCount = 0;
    const handle = createReplyBanner({
      shadow,
      onAccept: () => {
        acceptCount += 1;
      },
      onDecline: () => {
        declineCount += 1;
      },
    });
    handle.show('Footer');
    const root = shadow.querySelector(
      '[data-forjis-reply-banner]',
    ) as HTMLElement;
    const noBtn = root.querySelector('.reply-banner-no') as HTMLButtonElement;
    noBtn.click();
    expect(declineCount).toBe(1);
    expect(acceptCount).toBe(0);
    expect(root.getAttribute('data-open')).toBe('false');
  });

  it('FR-011-021 — hide() flips data-open back to "false" without side effects', () => {
    const { shadow } = attachShadow();
    let acceptCount = 0;
    let declineCount = 0;
    const handle = createReplyBanner({
      shadow,
      onAccept: () => {
        acceptCount += 1;
      },
      onDecline: () => {
        declineCount += 1;
      },
    });
    handle.show('Header');
    const root = shadow.querySelector(
      '[data-forjis-reply-banner]',
    ) as HTMLElement;
    expect(root.getAttribute('data-open')).toBe('true');
    handle.hide();
    expect(root.getAttribute('data-open')).toBe('false');
    // hide() is a pure state toggle; no accept/decline should fire.
    expect(acceptCount).toBe(0);
    expect(declineCount).toBe(0);
  });

  it('FR-011-021 — destroy is idempotent and removes the banner from the shadow root', () => {
    const { shadow } = attachShadow();
    const handle = createReplyBanner({
      shadow,
      onAccept: () => undefined,
      onDecline: () => undefined,
    });
    expect(shadow.querySelector('[data-forjis-reply-banner]')).not.toBeNull();
    handle.destroy();
    expect(shadow.querySelector('[data-forjis-reply-banner]')).toBeNull();
    expect(() => handle.destroy()).not.toThrow();
  });

  it('NFR-011-002 — source contains no transport / mount / WebSocket imports', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/reply/reply-banner.ts'),
      'utf-8',
    );
    expect(/from\s+['"][^'"]*transport/.test(src)).toBe(false);
    expect(/from\s+['"][^'"]*mount/.test(src)).toBe(false);
    expect(/new\s+WebSocket\(/.test(src)).toBe(false);
  });
});
