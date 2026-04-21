/**
 * ToolResultBlock — expandable body for a tool-result event.
 *
 * Companion to {@link ToolCallBlock}. Renders a `USER` row with the tool-use
 * id and timestamp on top, and the tool's raw output payload below as a
 * pre-formatted text block. Bodies longer than {@link RESULT_PREVIEW_LINES}
 * lines start clipped with a fade gradient and reveal an `Expand` toggle.
 *
 * Used as the `renderResult` slot inside {@link ToolCallBlock}: tool-result
 * events are nested under their parent tool-call and inherit its left-border
 * indentation. The body is plain text (not JSON-highlighted) because tool
 * outputs are free-form stdout / stderr / text payloads.
 */

import type { Component } from 'solid-js';
import { Show, createSignal } from 'solid-js';
import type { TaskEvent } from '@forjis/shared';
import eventStyles from './EventsTab.module.css';
import callStyles from './ToolCallBlock.module.css';
import { ansiToHtml } from './ansi-to-html';
import styles from './ToolResultBlock.module.css';

/**
 * Preview-window height for collapsed tool-result bodies. Tool outputs
 * (ls dumps, file reads, build logs) are often long and unstructured, so
 * the default preview is tighter than {@link RESULT_PREVIEW_LINES} (which
 * governs the JSON tool-call body): 50 lines keeps the stream scannable
 * while still showing enough context to decide whether to expand.
 */
const RESULT_PREVIEW_LINES = 50;

/** Props for {@link ToolResultBlock}. */
export interface ToolResultBlockProps {
  /** The tool-result event. `event.payload` drives the body; `parentId` is the tool-use id. */
  event: TaskEvent;
}

/**
 * Coerce any payload shape to a displayable string. Strings pass through; other
 * values are JSON.stringify'd with indent so nested tool results (rare) are
 * still readable. Falls back to `String(value)` on serialisation failure.
 */
function payloadToText(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** Format the event's timestamp as `HH:MM:SS` in the user's local time zone. */
function formatTimeOfDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Clip body text to the preview window when collapsed. Returns the text to
 * render plus a flag the caller uses to drive the fade-gradient modifier.
 */
function buildBodyText(fullText: string, expanded: boolean): { text: string; clipped: boolean } {
  if (!fullText) return { text: '', clipped: false };
  if (expanded) return { text: fullText, clipped: false };
  const lines = fullText.split('\n');
  if (lines.length <= RESULT_PREVIEW_LINES) return { text: fullText, clipped: false };
  return { text: lines.slice(0, RESULT_PREVIEW_LINES).join('\n'), clipped: true };
}

/** Nested tool-result block. See file header. */
export const ToolResultBlock: Component<ToolResultBlockProps> = (props) => {
  const [expanded, setExpanded] = createSignal<boolean>(false);

  const fullText = (): string => payloadToText(props.event.payload);
  const lineCount = (): number => fullText() ? fullText().split('\n').length : 0;
  const isLong = (): boolean => lineCount() > RESULT_PREVIEW_LINES;

  const body = (): { text: string; clipped: boolean } =>
    buildBodyText(fullText(), expanded());

  /** Translate ANSI SGR colour codes to inline-styled spans so terminal
   *  output (jest/vite/npm) renders with its intended highlights instead of
   *  leaking `[0m [90m` escape-code garbage into the page. */
  const bodyHtml = (): string => ansiToHtml(body().text);

  const previewClass = (): string => {
    const parts = [callStyles.body, callStyles.preview];
    if (body().clipped) parts.push(callStyles.previewClipped);
    return parts.join(' ');
  };

  const toggle = (): void => {
    setExpanded((prev) => !prev);
  };

  return (
    <div class={styles.block}>
      <div class={styles.header}>
        <span class={`${eventStyles.typeBadge} ${eventStyles.badgeUser}`}>user</span>
        <Show when={props.event.parentId !== undefined}>
          <span class={styles.id} title={props.event.parentId}>id={props.event.parentId}</span>
        </Show>
        <span class={styles.timestamp}>{formatTimeOfDay(props.event.timestamp)}</span>
      </div>
      <Show when={fullText()}>
        <pre class={previewClass()} innerHTML={bodyHtml()} />
        <Show when={isLong()}>
          <button type="button" class={callStyles.expandBtn} onClick={toggle}>
            {expanded() ? 'Collapse' : 'Expand'}
          </button>
        </Show>
      </Show>
    </div>
  );
};
