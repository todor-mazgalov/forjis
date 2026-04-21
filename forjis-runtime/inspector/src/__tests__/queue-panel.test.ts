/**
 * Unit tests for `ui/queue-panel.ts`.
 *
 * Covers FR-010-019 through FR-010-028 scenarios using a spied
 * `onSubmitBatch` + `onNavigateToPin` and a fresh shadow-root host.
 */

import { jest } from '@jest/globals';
import type { Pin } from '@forjis/shared';
import {
  __resetBatchStateForTests,
  addPin,
  clear,
  initBatchState,
  removePin,
  setStatus,
} from '../queue/batch-state.js';
import { createQueuePanel, type QueuePanelHandle } from '../ui/queue-panel.js';

/**
 * Build a deterministic `Pin` for queue-panel assertions.
 *
 * @param id - Identifier.
 * @param screen - Screen pathname or null.
 * @param comment - Optional comment.
 * @returns Pin value.
 */
function makePin(id: string, screen: string | null, comment = ''): Pin {
  return {
    id,
    platform: 'web',
    screen,
    target: {
      kind: 'element',
      source: null,
      selector: '#' + id,
      componentName: null,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
    },
    capture: {
      elementScreenshot: 'data:image/png;base64,' + id,
      viewportScreenshot: 'data:image/png;base64,view',
      computedStyles: '{}',
      annotations: [],
    },
    comment,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentPinId: null,
    commentGroupId: null,
  };
}

describe('queue-panel', () => {
  let host: HTMLDivElement;
  let shadow: ShadowRoot;
  let panel: QueuePanelHandle;
  let onSubmitBatch: jest.Mock;
  let onNavigateToPin: jest.Mock;

  beforeEach(() => {
    __resetBatchStateForTests();
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    onSubmitBatch = jest.fn();
    onNavigateToPin = jest.fn();
    initBatchState('tok-q');
    panel = createQueuePanel({ shadow, onSubmitBatch, onNavigateToPin });
  });

  afterEach(() => {
    panel.destroy();
    __resetBatchStateForTests();
  });

  it('panel DOM lives inside the shadow root (FR-010-019)', () => {
    const found = shadow.querySelector('[data-forjis-queue-panel]');
    expect(found).not.toBeNull();
  });

  it('collapsed by default (FR-010-020)', () => {
    const drawer = shadow.querySelector('.queue-drawer');
    expect(drawer?.getAttribute('data-open')).toBe('false');
  });

  it('clicking pill expands, clicking again collapses (FR-010-020)', () => {
    const pill = shadow.querySelector<HTMLElement>('.queue-pill');
    pill?.click();
    const drawer = shadow.querySelector('.queue-drawer');
    expect(drawer?.getAttribute('data-open')).toBe('true');
    pill?.click();
    expect(drawer?.getAttribute('data-open')).toBe('false');
  });

  it('renders one row per queued pin with truncated comment + thumbnail (FR-010-021)', () => {
    const longComment = 'x'.repeat(200);
    addPin(makePin('p-1', '/a', longComment));
    addPin(makePin('p-2', '/a', 'short'));
    addPin(makePin('p-3', '/a'));
    const rows = shadow.querySelectorAll('.queue-row');
    expect(rows).toHaveLength(3);
    const firstComment = rows[0].querySelector('.comment');
    expect(firstComment?.textContent?.endsWith('…')).toBe(true);
    expect((firstComment?.textContent ?? '').length).toBeLessThanOrEqual(80);
    const img = rows[0].querySelector<HTMLImageElement>('img');
    expect(img?.src).toContain('data:image/png;base64,p-1');
  });

  it('updates reactively on addPin / removePin (FR-010-022)', () => {
    addPin(makePin('p-1', '/a'));
    addPin(makePin('p-2', '/a'));
    expect(shadow.querySelectorAll('.queue-row')).toHaveLength(2);
    removePin('p-1');
    expect(shadow.querySelectorAll('.queue-row')).toHaveLength(1);
    expect(
      shadow.querySelector('.queue-row')?.getAttribute('data-pin-id'),
    ).toBe('p-2');
  });

  it('per-pin remove action calls BatchState.removePin (FR-010-023)', () => {
    addPin(makePin('p-1', '/a'));
    addPin(makePin('p-2', '/a'));
    const removeBtn = shadow.querySelector<HTMLButtonElement>(
      '.queue-row[data-pin-id="p-1"] button[data-action="remove"]',
    );
    removeBtn?.click();
    expect(shadow.querySelectorAll('.queue-row')).toHaveLength(1);
  });

  it('per-pin edit updates only comment (FR-010-024)', () => {
    addPin(makePin('p-1', '/a', 'original'));
    const editBtn = shadow.querySelector<HTMLButtonElement>(
      '.queue-row[data-pin-id="p-1"] button[data-action="edit"]',
    );
    editBtn?.click();
    const textarea = shadow.querySelector<HTMLTextAreaElement>(
      '.queue-row[data-pin-id="p-1"] textarea',
    );
    expect(textarea).not.toBeNull();
    if (textarea) {
      textarea.value = 'edited';
    }
    const saveBtn = shadow.querySelector<HTMLButtonElement>(
      '.queue-row[data-pin-id="p-1"] button[data-action="save"]',
    );
    saveBtn?.click();
    // After save, subscribe re-renders; find the updated row.
    const updated = shadow.querySelector(
      '.queue-row[data-pin-id="p-1"] .comment',
    );
    expect(updated?.textContent).toBe('edited');
  });

  it('per-pin navigate invokes onNavigateToPin (FR-010-025)', () => {
    const pin = makePin('p-1', '/target');
    addPin(pin);
    const navBtn = shadow.querySelector<HTMLButtonElement>(
      '.queue-row[data-pin-id="p-1"] button[data-action="navigate"]',
    );
    navBtn?.click();
    expect(onNavigateToPin).toHaveBeenCalledTimes(1);
    expect((onNavigateToPin.mock.calls[0][0] as Pin).id).toBe('p-1');
  });

  it('submit button is disabled at zero pins and enabled once pins are queued (FR-010-026)', () => {
    const submit = shadow.querySelector<HTMLButtonElement>(
      '.queue-footer button',
    );
    expect(submit?.disabled).toBe(true);
    addPin(makePin('p-1', '/a'));
    expect(submit?.disabled).toBe(false);
    removePin('p-1');
    expect(submit?.disabled).toBe(true);
  });

  it('enabled submit button fires onSubmitBatch (FR-010-027)', () => {
    addPin(makePin('p-1', '/a'));
    const submit = shadow.querySelector<HTMLButtonElement>(
      '.queue-footer button',
    );
    submit?.click();
    expect(onSubmitBatch).toHaveBeenCalledTimes(1);
  });

  it('disabled submit is a no-op (FR-010-027 scenario 2)', () => {
    const submit = shadow.querySelector<HTMLButtonElement>(
      '.queue-footer button',
    );
    submit?.click();
    expect(onSubmitBatch).not.toHaveBeenCalled();
  });

  it('setStatus does not clear the list (FR-010-028 scenario 2)', () => {
    addPin(makePin('p-1', '/a'));
    addPin(makePin('p-2', '/a'));
    addPin(makePin('p-3', '/a'));
    setStatus('clarifying');
    expect(shadow.querySelectorAll('.queue-row')).toHaveLength(3);
  });

  it('clear empties the panel', () => {
    addPin(makePin('p-1', '/a'));
    expect(shadow.querySelectorAll('.queue-row')).toHaveLength(1);
    clear();
    expect(shadow.querySelectorAll('.queue-row')).toHaveLength(0);
    expect(shadow.querySelector('.queue-empty')).not.toBeNull();
  });

  it('Escape collapses an expanded panel', () => {
    const pill = shadow.querySelector<HTMLElement>('.queue-pill');
    pill?.click();
    const drawer = shadow.querySelector('.queue-drawer');
    expect(drawer?.getAttribute('data-open')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drawer?.getAttribute('data-open')).toBe('false');
  });
});
