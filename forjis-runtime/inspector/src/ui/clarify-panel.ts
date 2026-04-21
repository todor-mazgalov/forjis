/**
 * Clarify chat panel factory (design.md §D-003, FR-011-001..012).
 *
 * A drawer hosted inside the overlay's shadow root. Auto-opens when the
 * observed {@link Batch}'s `status` flips to `"clarifying"`. Renders one
 * message entry per `clarify.question`, each with tap-target option cards
 * and an optional free-text textarea. After the user answers, the question
 * locks: every card becomes non-interactive and a user-reply fragment shows
 * the chosen label or free-text value. Updates a status strip on
 * `task.status`, replaces the body with a finalized card on
 * `batch.finalize`, and transitions to a resolved state when `task.status`
 * becomes `"done"` after finalize. An Abort button invokes the
 * caller-supplied `onAbort` callback exactly once and displays a
 * "finalizing with assumptions…" affordance.
 *
 * Module boundaries (NFR-011-002): imports only `@forjis/shared` types and
 * `../queue/batch-state.js`. All outbound traffic flows through the
 * `onSendAnswer` / `onAbort` callbacks supplied by the factory caller.
 */

import type {
  Batch,
  BatchStatus,
  ClarifyAnswer,
  ClarifyQuestion,
} from '@forjis/shared';
import { getBatch, subscribe } from '../queue/batch-state.js';

/** Init options accepted by {@link createClarifyPanel}. */
export interface InitClarifyPanelOptions {
  /** Overlay shadow root. */
  readonly shadow: ShadowRoot;
  /** Invoked once per answered question with the composed `ClarifyAnswer`. */
  readonly onSendAnswer: (answer: ClarifyAnswer) => void;
  /** Invoked once when the user activates the Abort & finalize button. */
  readonly onAbort: () => void;
}

/** Handle returned by {@link createClarifyPanel}. */
export interface ClarifyPanelHandle {
  /** The panel root element (mounted inside the supplied shadow root). */
  readonly element: HTMLElement;
  /** Show the panel (set `data-open="true"`). */
  open(): void;
  /** Hide the panel (set `data-open="false"`). */
  close(): void;
  /** Render one message entry for the supplied clarify question. */
  handleQuestion(question: ClarifyQuestion): void;
  /** Update the status strip with the human-readable status text. */
  handleTaskStatus(status: BatchStatus, summary?: string): void;
  /** Replace the panel body with a finalized card showing the task path. */
  handleFinalize(taskPath: string): void;
  /** Remove listeners and DOM. Idempotent. */
  destroy(): void;
}

/** Inline CSS for the clarify panel — isolated inside the shadow root. */
const CLARIFY_PANEL_STYLE = `
div[data-forjis-clarify-panel] {
  position: fixed;
  bottom: 72px;
  left: 16px;
  width: 360px;
  max-height: 520px;
  background: #ffffff;
  color: #111827;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.2);
  font: 13px/1.4 system-ui, -apple-system, sans-serif;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
  z-index: 10;
  box-sizing: border-box;
}
div[data-forjis-clarify-panel][data-open="false"] { display: none; }
.clarify-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
}
.clarify-batch-id {
  font-weight: 600;
  font-size: 12px;
  color: #374151;
}
.clarify-pin-count {
  background: #eff6ff;
  color: #1e40af;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
}
.clarify-token-budget {
  margin-left: auto;
  font-size: 11px;
  color: #6b7280;
}
.clarify-abort-btn {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fecaca;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  box-sizing: border-box;
}
.clarify-abort-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.clarify-status {
  padding: 6px 12px;
  font-size: 12px;
  color: #374151;
  border-bottom: 1px solid #e5e7eb;
  background: #ffffff;
}
.clarify-messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.clarify-question {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f9fafb;
}
.clarify-question-text {
  font-weight: 600;
  color: #111827;
}
.clarify-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.clarify-option-card {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  background: #ffffff;
  color: inherit;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  text-align: left;
  font: inherit;
  cursor: pointer;
  box-sizing: border-box;
}
.clarify-option-card:hover:not([disabled]) { background: #eff6ff; }
.clarify-option-card[disabled] { opacity: 0.6; cursor: not-allowed; }
.clarify-option-label { font-weight: 600; }
.clarify-option-description { font-size: 12px; color: #4b5563; }
.clarify-freetext {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
.clarify-freetext textarea {
  width: 100%;
  min-height: 64px;
  resize: vertical;
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font: inherit;
  box-sizing: border-box;
}
.clarify-freetext-submit {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: #2563eb;
  color: #ffffff;
  border: 1px solid #1d4ed8;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  align-self: flex-end;
  box-sizing: border-box;
}
.clarify-freetext-submit:disabled { opacity: 0.5; cursor: not-allowed; }
.clarify-user-reply {
  margin-top: 6px;
  padding: 6px 8px;
  background: #eff6ff;
  border-left: 3px solid #2563eb;
  font-size: 12px;
  color: #1e3a8a;
}
.clarify-finalized-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.clarify-finalized-label { font-weight: 600; }
.clarify-finalized-path { font-family: ui-monospace, Menlo, monospace; font-size: 12px; word-break: break-all; color: #374151; }
@media (max-width: 767.98px) {
  div[data-forjis-clarify-panel] {
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 70vh;
    border-radius: 16px 16px 0 0;
  }
}
`;

/** Cached DOM references for the panel. */
interface PanelDom {
  root: HTMLElement;
  batchIdSpan: HTMLSpanElement;
  pinCountSpan: HTMLSpanElement;
  tokenBudgetSpan: HTMLSpanElement;
  abortBtn: HTMLButtonElement;
  statusStrip: HTMLElement;
  messages: HTMLElement;
  body: HTMLElement;
}

/** Construct the panel's structural DOM. Returns detached references. */
function buildPanelDom(): PanelDom {
  const root = document.createElement('div');
  root.setAttribute('data-forjis-clarify-panel', 'true');
  root.setAttribute('data-open', 'false');
  const style = document.createElement('style');
  style.textContent = CLARIFY_PANEL_STYLE;
  root.appendChild(style);
  const header = document.createElement('div');
  header.className = 'clarify-header';
  const batchIdSpan = document.createElement('span');
  batchIdSpan.className = 'clarify-batch-id';
  batchIdSpan.textContent = '';
  const pinCountSpan = document.createElement('span');
  pinCountSpan.className = 'clarify-pin-count';
  pinCountSpan.textContent = '0 pins';
  const tokenBudgetSpan = document.createElement('span');
  tokenBudgetSpan.className = 'clarify-token-budget';
  tokenBudgetSpan.textContent = '';
  const abortBtn = document.createElement('button');
  abortBtn.type = 'button';
  abortBtn.className = 'clarify-abort-btn';
  abortBtn.setAttribute('data-forjis-clarify-abort', 'true');
  abortBtn.textContent = 'Abort & finalize';
  header.appendChild(batchIdSpan);
  header.appendChild(pinCountSpan);
  header.appendChild(tokenBudgetSpan);
  header.appendChild(abortBtn);
  root.appendChild(header);
  const statusStrip = document.createElement('div');
  statusStrip.className = 'clarify-status';
  statusStrip.setAttribute('data-forjis-clarify-status', 'true');
  statusStrip.textContent = '';
  root.appendChild(statusStrip);
  const body = document.createElement('div');
  body.className = 'clarify-body';
  const messages = document.createElement('div');
  messages.className = 'clarify-messages';
  messages.setAttribute('data-forjis-clarify-messages', 'true');
  body.appendChild(messages);
  root.appendChild(body);
  return {
    root,
    batchIdSpan,
    pinCountSpan,
    tokenBudgetSpan,
    abortBtn,
    statusStrip,
    messages,
    body,
  };
}

/** Per-question lock state held in the factory's closure. */
interface QuestionLock {
  locked: boolean;
  entry: HTMLElement;
  optionButtons: HTMLButtonElement[];
  textarea: HTMLTextAreaElement | null;
  submitBtn: HTMLButtonElement | null;
}

/** Reflect `batch` metadata (short id + pin count) into the header. */
function syncHeader(dom: PanelDom, batch: Batch | null): void {
  if (batch === null) {
    dom.batchIdSpan.textContent = '';
    dom.pinCountSpan.textContent = '0 pins';
    return;
  }
  dom.batchIdSpan.textContent = batch.id.slice(0, 8);
  dom.pinCountSpan.textContent = String(batch.pins.length) + ' pins';
}

/** Build the option-card button for a single {@link ClarifyQuestion}. */
function buildOptionCard(
  option: { id: string; label: string; description: string },
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clarify-option-card';
  btn.setAttribute('data-option-id', option.id);
  const labelSpan = document.createElement('span');
  labelSpan.className = 'clarify-option-label';
  labelSpan.textContent = option.label;
  const descSpan = document.createElement('span');
  descSpan.className = 'clarify-option-description';
  descSpan.textContent = option.description;
  btn.appendChild(labelSpan);
  btn.appendChild(descSpan);
  return btn;
}

/** Append a user-reply fragment beneath a locked question entry. */
function appendUserReply(entry: HTMLElement, text: string): void {
  const reply = document.createElement('div');
  reply.className = 'clarify-user-reply';
  reply.textContent = text;
  entry.appendChild(reply);
}

/** Lock every interactive control on a question entry. */
function lockControls(lock: QuestionLock): void {
  for (const btn of lock.optionButtons) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  }
  if (lock.textarea) {
    lock.textarea.disabled = true;
  }
  if (lock.submitBtn) {
    lock.submitBtn.disabled = true;
  }
  lock.locked = true;
}

/**
 * Build one `div.clarify-question` entry for the given question, wiring
 * option-card clicks and the optional free-text submit to the
 * `onAnswer(answer, replyText)` callback. The factory closure (not this
 * builder) is responsible for installing the lock after each answer.
 *
 * @param question - Question to render.
 * @param onAnswer - Invoked with the answer + a human-readable reply
 *   string (option label or trimmed free-text).
 * @returns Tuple of the entry element and its {@link QuestionLock}.
 */
function buildQuestionEntry(
  question: ClarifyQuestion,
  onAnswer: (answer: ClarifyAnswer, replyText: string) => void,
): { entry: HTMLElement; lock: QuestionLock } {
  const entry = document.createElement('div');
  entry.className = 'clarify-question';
  entry.setAttribute('data-question-id', question.id);
  const textSpan = document.createElement('div');
  textSpan.className = 'clarify-question-text';
  textSpan.textContent = question.text;
  entry.appendChild(textSpan);
  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'clarify-options';
  const optionButtons: HTMLButtonElement[] = [];
  for (const option of question.options) {
    const btn = buildOptionCard(option);
    btn.addEventListener('click', () => {
      if (lock.locked) {
        return;
      }
      onAnswer(
        { questionId: question.id, optionId: option.id, freeText: null },
        option.label,
      );
    });
    optionsWrap.appendChild(btn);
    optionButtons.push(btn);
  }
  entry.appendChild(optionsWrap);
  let textarea: HTMLTextAreaElement | null = null;
  let submitBtn: HTMLButtonElement | null = null;
  if (question.allowFreeText) {
    const freeTextWrap = document.createElement('div');
    freeTextWrap.className = 'clarify-freetext';
    textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.placeholder = 'Or type your own answer…';
    freeTextWrap.appendChild(textarea);
    submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'clarify-freetext-submit';
    submitBtn.textContent = 'Send answer';
    const currentTextarea = textarea;
    submitBtn.addEventListener('click', () => {
      if (lock.locked) {
        return;
      }
      const trimmed = currentTextarea.value.trim();
      if (trimmed.length === 0) {
        return;
      }
      onAnswer(
        { questionId: question.id, optionId: null, freeText: trimmed },
        trimmed,
      );
    });
    freeTextWrap.appendChild(submitBtn);
    entry.appendChild(freeTextWrap);
  }
  const lock: QuestionLock = {
    locked: false,
    entry,
    optionButtons,
    textarea,
    submitBtn,
  };
  return { entry, lock };
}

/** Human-readable status-strip text for a known {@link BatchStatus}. */
function formatStatusText(status: BatchStatus, summary?: string): string | null {
  if (status === 'running') {
    return summary ? 'Running — ' + summary : 'Running…';
  }
  if (status === 'done') {
    return summary ? 'Done — ' + summary : 'Done';
  }
  if (status === 'failed') {
    return summary ? 'Failed — ' + summary : 'Failed';
  }
  return null;
}

/**
 * Build a clarify panel and mount it into `opts.shadow`. Subscribes to
 * `BatchState` for auto-open behaviour; exposes `handleQuestion`,
 * `handleTaskStatus`, and `handleFinalize` for caller-driven updates.
 *
 * @param opts - Init options.
 * @returns A {@link ClarifyPanelHandle}.
 */
export function createClarifyPanel(
  opts: InitClarifyPanelOptions,
): ClarifyPanelHandle {
  const dom = buildPanelDom();
  opts.shadow.appendChild(dom.root);
  const lockMap: Map<string, QuestionLock> = new Map();
  let hasOpenedForCurrentBatch = false;
  let destroyed = false;
  let finalized = false;
  let abortInvoked = false;

  const open = (): void => {
    dom.root.setAttribute('data-open', 'true');
  };

  const close = (): void => {
    dom.root.setAttribute('data-open', 'false');
  };

  const handleAnswer = (answer: ClarifyAnswer, replyText: string): void => {
    const lock = lockMap.get(answer.questionId);
    if (!lock || lock.locked) {
      return;
    }
    opts.onSendAnswer(answer);
    lockControls(lock);
    appendUserReply(lock.entry, replyText);
  };

  const handleQuestion = (question: ClarifyQuestion): void => {
    const { entry, lock } = buildQuestionEntry(question, handleAnswer);
    lockMap.set(question.id, lock);
    dom.messages.appendChild(entry);
  };

  const handleTaskStatus = (status: BatchStatus, summary?: string): void => {
    const text = formatStatusText(status, summary);
    if (text !== null) {
      dom.statusStrip.textContent = text;
    }
    if (finalized && status === 'done') {
      dom.root.setAttribute('data-state', 'resolved');
    }
  };

  const handleFinalize = (taskPath: string): void => {
    finalized = true;
    // Hide existing messages, render finalized card in-place.
    while (dom.body.firstChild) {
      dom.body.removeChild(dom.body.firstChild);
    }
    const card = document.createElement('div');
    card.className = 'clarify-finalized-card';
    const label = document.createElement('div');
    label.className = 'clarify-finalized-label';
    label.textContent = 'Batch finalized';
    const pathEl = document.createElement('div');
    pathEl.className = 'clarify-finalized-path';
    pathEl.textContent = taskPath;
    card.appendChild(label);
    card.appendChild(pathEl);
    dom.body.appendChild(card);
    dom.root.setAttribute('data-state', 'finalized');
  };

  dom.abortBtn.addEventListener('click', () => {
    if (abortInvoked) {
      return;
    }
    abortInvoked = true;
    dom.abortBtn.disabled = true;
    opts.onAbort();
    dom.statusStrip.textContent = 'Finalizing with assumptions…';
  });

  const unsubscribe = subscribe((batch) => {
    if (batch === null) {
      hasOpenedForCurrentBatch = false;
      return;
    }
    syncHeader(dom, batch);
    if (batch.status === 'clarifying' && !hasOpenedForCurrentBatch) {
      hasOpenedForCurrentBatch = true;
      open();
    }
  });

  // Initial header paint for any pre-existing batch.
  syncHeader(dom, getBatch());

  return {
    element: dom.root,
    open,
    close,
    handleQuestion,
    handleTaskStatus,
    handleFinalize,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      unsubscribe();
      if (dom.root.parentNode) {
        dom.root.parentNode.removeChild(dom.root);
      }
    },
  };
}
