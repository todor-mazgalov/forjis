/**
 * Unit tests for the clarify-panel factory.
 *
 * Covers FR-011-001 through FR-011-012, plus NFR-011-003 (render budget)
 * and NFR-011-004 (44px tap targets). Also verifies the module-boundary
 * scan for FR-011-012 (no transport / mount / WebSocket imports).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Batch, ClarifyQuestion } from '@forjis/shared';
import { createClarifyPanel } from '../ui/clarify-panel.js';
import {
  __resetBatchStateForTests,
  addPin as batchAddPin,
  setStatus as batchSetStatus,
  updatePin,
} from '../queue/batch-state.js';

/** Build a deterministic batch-priming pin so BatchState has a non-null batch. */
function seedBatch(): Batch {
  const pin = {
    id: 'p-seed',
    platform: 'web' as const,
    screen: '/a',
    target: {
      kind: 'element' as const,
      source: null,
      selector: '#p-seed',
      componentName: null,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    capture: {
      elementScreenshot: 'data:image/png;base64,AAAA',
      viewportScreenshot: 'data:image/png;base64,AAAA',
      computedStyles: '{}',
      annotations: [],
    },
    comment: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    parentPinId: null,
    commentGroupId: null,
  };
  batchAddPin(pin);
  // Return the current batch for tests that want to assert the short id.
  // Re-seed returns the batch via setStatus notifications later.
  return { ...pin } as unknown as Batch;
}

/** Build a shadow-host + shadow-root pair mirroring the overlay's setup. */
function attachShadow(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  return { host, shadow };
}

/** Sample question with two options. */
function makeQuestion(
  id: string,
  opts: { allowFreeText?: boolean } = {},
): ClarifyQuestion {
  return {
    id,
    text: 'Which footer?',
    options: [
      { id: 'opt-a', label: 'Primary', description: 'Site footer' },
      { id: 'opt-b', label: 'Secondary', description: 'Modal footer' },
    ],
    allowFreeText: opts.allowFreeText === true,
  };
}

describe('clarify-panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    __resetBatchStateForTests();
  });

  it('FR-011-001 — factory mounts into the shadow root and destroy removes it', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    expect(shadow.querySelector('[data-forjis-clarify-panel]')).not.toBeNull();
    expect(
      document.body.querySelector('[data-forjis-clarify-panel]'),
    ).toBeNull();
    handle.destroy();
    expect(shadow.querySelector('[data-forjis-clarify-panel]')).toBeNull();
    expect(() => handle.destroy()).not.toThrow();
  });

  it('FR-011-002 — panel stays closed when no batch exists', () => {
    const { shadow } = attachShadow();
    createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    expect(root.getAttribute('data-open')).toBe('false');
  });

  it('FR-011-002 — panel opens on first clarifying status; redundant notifications do not reopen', () => {
    const { shadow } = attachShadow();
    createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    seedBatch();
    batchSetStatus('clarifying');
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    expect(root.getAttribute('data-open')).toBe('true');
    // Now close and watch a redundant notification; panel should NOT reopen.
    root.setAttribute('data-open', 'false');
    updatePin('p-seed', { comment: 'x' });
    expect(root.getAttribute('data-open')).toBe('false');
  });

  it('FR-011-003 — header shows short batch id, pin count, and Abort button', () => {
    const { shadow } = attachShadow();
    createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    seedBatch();
    batchSetStatus('clarifying');
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const batchIdSpan = root.querySelector(
      '.clarify-batch-id',
    ) as HTMLSpanElement;
    const pinCountSpan = root.querySelector(
      '.clarify-pin-count',
    ) as HTMLSpanElement;
    expect(batchIdSpan.textContent?.length).toBe(8);
    expect(pinCountSpan.textContent).toContain('1');
    const abort = root.querySelector(
      '[data-forjis-clarify-abort]',
    ) as HTMLButtonElement;
    expect(abort).not.toBeNull();
    expect(abort.disabled).toBe(false);
  });

  it('FR-011-004 — question renders with option cards in order and correct text', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q1'));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const entry = root.querySelector(
      '.clarify-question[data-question-id="q1"]',
    ) as HTMLElement;
    expect(entry).not.toBeNull();
    expect(entry.querySelector('.clarify-question-text')?.textContent).toContain(
      'Which footer?',
    );
    const cards = entry.querySelectorAll('.clarify-option-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Primary');
    expect(cards[0].textContent).toContain('Site footer');
    expect(cards[1].textContent).toContain('Secondary');
  });

  it('FR-011-004 — free-text textarea is present only when allowed', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q-no-ft'));
    handle.handleQuestion(makeQuestion('q-yes-ft', { allowFreeText: true }));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const entries = root.querySelectorAll('.clarify-question');
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector('textarea')).toBeNull();
    expect(entries[1].querySelector('textarea')).not.toBeNull();
  });

  it('FR-011-004 — multiple questions render in arrival order', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q1'));
    handle.handleQuestion(makeQuestion('q2'));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const entries = root.querySelectorAll('.clarify-question');
    expect(entries[0].getAttribute('data-question-id')).toBe('q1');
    expect(entries[1].getAttribute('data-question-id')).toBe('q2');
  });

  it('FR-011-005 — option tap invokes onSendAnswer with optionId once', () => {
    const { shadow } = attachShadow();
    const answers: unknown[] = [];
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: (a) => answers.push(a),
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q1'));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const btnB = root.querySelector(
      '.clarify-option-card[data-option-id="opt-b"]',
    ) as HTMLButtonElement;
    btnB.click();
    expect(answers).toEqual([
      { questionId: 'q1', optionId: 'opt-b', freeText: null },
    ]);
  });

  it('FR-011-006 — non-empty free-text submit invokes onSendAnswer with trimmed text', () => {
    const { shadow } = attachShadow();
    const answers: unknown[] = [];
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: (a) => answers.push(a),
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q1', { allowFreeText: true }));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '  the footer  ';
    const submit = root.querySelector(
      '.clarify-freetext-submit',
    ) as HTMLButtonElement;
    submit.click();
    expect(answers).toEqual([
      { questionId: 'q1', optionId: null, freeText: 'the footer' },
    ]);
  });

  it('FR-011-006 — empty or whitespace free-text submit is a no-op', () => {
    const { shadow } = attachShadow();
    const answers: unknown[] = [];
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: (a) => answers.push(a),
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q1', { allowFreeText: true }));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '   ';
    const submit = root.querySelector(
      '.clarify-freetext-submit',
    ) as HTMLButtonElement;
    submit.click();
    expect(answers).toHaveLength(0);
  });

  it('FR-011-007 — option cards lock after answering; user-reply fragment appears; re-tap is a no-op', () => {
    const { shadow } = attachShadow();
    const answers: unknown[] = [];
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: (a) => answers.push(a),
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q1'));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const btnA = root.querySelector(
      '.clarify-option-card[data-option-id="opt-a"]',
    ) as HTMLButtonElement;
    btnA.click();
    expect(answers).toHaveLength(1);
    const cards = root.querySelectorAll(
      '.clarify-option-card',
    ) as NodeListOf<HTMLButtonElement>;
    for (const card of Array.from(cards)) {
      expect(card.disabled).toBe(true);
      expect(card.getAttribute('aria-disabled')).toBe('true');
    }
    const reply = root.querySelector('.clarify-user-reply');
    expect(reply?.textContent).toContain('Primary');
    btnA.click();
    expect(answers).toHaveLength(1);
  });

  it('FR-011-008 — Abort click invokes onAbort once, disables button, and shows finalizing text', () => {
    const { shadow } = attachShadow();
    let abortCount = 0;
    createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => {
        abortCount += 1;
      },
    });
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const abort = root.querySelector(
      '[data-forjis-clarify-abort]',
    ) as HTMLButtonElement;
    abort.click();
    abort.click();
    expect(abortCount).toBe(1);
    expect(abort.disabled).toBe(true);
    const status = root.querySelector(
      '[data-forjis-clarify-status]',
    ) as HTMLElement;
    expect(status.textContent?.toLowerCase()).toContain('finalizing');
  });

  it('FR-011-009 — handleTaskStatus updates status strip text for running / failed', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    handle.handleTaskStatus('running');
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    const status = root.querySelector(
      '[data-forjis-clarify-status]',
    ) as HTMLElement;
    expect(status.textContent?.toLowerCase()).toContain('running');
    handle.handleTaskStatus('failed');
    expect(status.textContent?.toLowerCase()).toContain('failed');
  });

  it('FR-011-010 — handleFinalize renders a card with the task path and removes messages', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    seedBatch();
    batchSetStatus('clarifying');
    handle.handleQuestion(makeQuestion('q1'));
    handle.handleFinalize('/tmp/forjis/tasks/t-42');
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    expect(root.textContent).toContain('/tmp/forjis/tasks/t-42');
    expect(root.querySelector('.clarify-question')).toBeNull();
    // Header retains short batch id.
    const batchIdSpan = root.querySelector(
      '.clarify-batch-id',
    ) as HTMLSpanElement;
    expect(batchIdSpan.textContent?.length).toBe(8);
  });

  it('FR-011-011 — handleFinalize then handleTaskStatus("done") sets data-state="resolved"', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    handle.handleFinalize('/any/path');
    handle.handleTaskStatus('done');
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    expect(root.getAttribute('data-state')).toBe('resolved');
  });

  it('FR-011-012 — source file contains no transport / mount / WebSocket imports', () => {
    const src = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'src/ui/clarify-panel.ts',
      ),
      'utf-8',
    );
    expect(/from\s+['"][^'"]*transport/.test(src)).toBe(false);
    expect(/from\s+['"][^'"]*mount/.test(src)).toBe(false);
    expect(/new\s+WebSocket\(/.test(src)).toBe(false);
  });

  it('NFR-011-003 — render of 5 questions with 4 options each completes under 100 ms (FR target 16 ms)', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    const question: ClarifyQuestion = {
      id: 'q-base',
      text: 'Pick one',
      options: [
        { id: 'o1', label: 'One', description: 'Desc 1' },
        { id: 'o2', label: 'Two', description: 'Desc 2' },
        { id: 'o3', label: 'Three', description: 'Desc 3' },
        { id: 'o4', label: 'Four', description: 'Desc 4' },
      ],
      allowFreeText: false,
    };
    const start = performance.now();
    for (let i = 0; i < 5; i += 1) {
      handle.handleQuestion({ ...question, id: 'q-' + String(i) });
    }
    const delta = performance.now() - start;
    expect(delta).toBeLessThan(100);
  });

  it('NFR-011-004 — option card, Abort button, free-text submit have ≥ 44×44 tap targets', () => {
    const { shadow } = attachShadow();
    const handle = createClarifyPanel({
      shadow,
      onSendAnswer: () => undefined,
      onAbort: () => undefined,
    });
    handle.handleQuestion(makeQuestion('q1', { allowFreeText: true }));
    const root = shadow.querySelector(
      '[data-forjis-clarify-panel]',
    ) as HTMLElement;
    // jsdom does not apply shadow-root <style> declarations to
    // getComputedStyle; instead the test inspects the inline <style> block
    // to verify the 44px tap-target CSS rules exist for each control class.
    const styleEl = root.querySelector('style') as HTMLStyleElement;
    const css = styleEl.textContent ?? '';
    const classes = [
      '.clarify-option-card',
      '.clarify-abort-btn',
      '.clarify-freetext-submit',
    ];
    for (const cls of classes) {
      const re = new RegExp(
        cls.replace('.', '\\.') +
          '[^}]*min-width:\\s*44px[^}]*min-height:\\s*44px',
        's',
      );
      expect(re.test(css)).toBe(true);
    }
  });
});
