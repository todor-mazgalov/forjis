/**
 * TaskCard — a single task row rendered inside the left {@link TaskRail}.
 *
 * Layout (left to right): `<StatusDot/>`, title, priority `<Chip/>`, and an
 * elapsed-time label in JetBrains Mono on the right. The title renders the
 * task directory id; hovering shows the full description as a native tooltip.
 * For running tasks with a populated `progress` field, a segmented progress
 * chain (done / active / queued) sits between the header and the branch list.
 * Selection state is owned by the parent; this component is a pure view over
 * `task`, `selected`, and `now`.
 */

import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';
import type { TaskListItem, TaskStatus } from '@forjis/shared';
import { Chip } from '../../components/primitives/Chip';
import { StatusDot, type StatusDotState } from '../../components/primitives/StatusDot';
import { Copy } from '../../icons/Copy';
import { formatElapsed } from './time';
import {
  buildProgressSegments,
  type ProgressSegment,
  type ProgressStep,
  type SegmentClass,
} from './progress-segments';
import { formatPriorityLabel } from './task-card-format';
import styles from './TaskCard.module.css';

export { buildProgressSegments, type ProgressSegment, type ProgressStep, type SegmentClass } from './progress-segments';
export { formatPriorityLabel } from './task-card-format';


/** Props for {@link TaskCard}. */
export interface TaskCardProps {
  /** The task being rendered. */
  task: TaskListItem;
  /** Whether this card is the currently selected card. */
  selected: boolean;
  /** Current epoch-ms used to refresh elapsed labels for running tasks. */
  now: number;
  /** Fired when the user clicks the card body. */
  onSelect: (taskId: string) => void;
}

/**
 * Map the subset of {@link TaskStatus} values that appear in task cards to
 * the `StatusDot` state enum. `pending` and `needs_clarification` fall back
 * to `queued` because the visual language for "not yet running" is shared.
 */
function toDotState(status: TaskStatus): StatusDotState {
  if (status === 'running' || status === 'done' || status === 'failed') return status;
  return 'queued';
}

/**
 * Write the given branch name to the clipboard. Split out so the async
 * boundary is named; failures are swallowed because the clipboard API may be
 * unavailable (non-secure contexts) and a broken copy is preferable to an
 * unhandled rejection.
 */
function copyBranchToClipboard(branchName: string): void {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(branchName).catch(() => {
    /* Clipboard access denied or unavailable — intentionally silent. */
  });
}

/**
 * Extended progress shape that includes the per-step status array added in
 * redesign-021 §15. The backend populates `steps`; when the field is absent
 * (older records) the component falls back to the `done`/`total` counts.
 */
type ProgressWithSteps = NonNullable<TaskListItem['progress']> & {
  steps?: ProgressStep[];
};

/**
 * Build a fallback step list from `done`, `total`, and `current` for records
 * that pre-date the `steps` field. The resulting list approximates the state:
 * first `done` steps are `done`, the next is `running` if `current !== null`,
 * and the remainder are `planned`.
 */
function buildFallbackSteps(progress: NonNullable<TaskListItem['progress']>): ProgressStep[] {
  const { total, done, current } = progress;
  const out: ProgressStep[] = [];
  for (let i = 0; i < total; i += 1) {
    if (i < done) out.push({ role: String(i), status: 'done' });
    else if (i === done && current !== null) out.push({ role: current, status: 'running' });
    else out.push({ role: String(i), status: 'planned' });
  }
  return out;
}

/**
 * Segmented progress chain rendered below a running task's header. One
 * fixed-width `12px × 3px` segment per plan step. Colour is driven by the
 * `progress.steps` array (redesign-021 §15); when the field is absent the
 * component falls back to `done`/`total`/`current` counts.
 *
 * Accessibility: the chain container carries `role="img"` and an `aria-label`
 * summarising `<done>/<total>`; each segment's `title` attribute identifies
 * `<role> · <status>`.
 */
const ProgressChain: Component<{ progress: ProgressWithSteps }> = (props) => {
  const steps = (): ProgressStep[] =>
    props.progress.steps ?? buildFallbackSteps(props.progress);

  const segments = (): ProgressSegment[] => buildProgressSegments(steps());

  const ariaLabel = (): string =>
    `${props.progress.done}/${props.progress.total} steps done`;

  return (
    <div
      class={styles.progressChain}
      role="img"
      aria-label={ariaLabel()}
    >
      <For each={segments()}>
        {(seg) => (
          <span
            class={`${styles.segment} ${styles[seg.cls]}`}
            title={`${seg.role} \u00b7 ${seg.status}`}
          />
        )}
      </For>
    </div>
  );
};

/** A single branch row inside a task card's branch chain. */
const BranchRow: Component<{ branch: string }> = (props) => {
  const onCopyClick = (event: MouseEvent): void => {
    event.stopPropagation();
    copyBranchToClipboard(props.branch);
  };
  return (
    <div class={styles.branchRow}>
      <span class={styles.branchNode} aria-hidden="true" />
      <span class={styles.branchName} title={props.branch}>
        {props.branch}
      </span>
      <button
        type="button"
        class={styles.branchCopyBtn}
        title="Copy branch name"
        aria-label={`Copy branch ${props.branch}`}
        onClick={onCopyClick}
      >
        <Copy size={12} />
      </button>
    </div>
  );
};

/** Single selectable task row. Click selects; the branch copy button does not. */
export const TaskCard: Component<TaskCardProps> = (props) => {
  const rootClass = (): string =>
    props.selected ? `${styles.card} ${styles.cardSelected}` : styles.card;
  const elapsed = (): string =>
    formatElapsed(props.task.started, props.task.completed, props.now);
  const onClick = (): void => props.onSelect(props.task.id);
  return (
    <article
      class={rootClass()}
      data-task-id={props.task.id}
      onClick={onClick}
      role="button"
      tabindex="-1"
    >
      <header class={styles.header}>
        <StatusDot
          state={toDotState(props.task.status)}
          variant={props.task.status === 'running' ? 'ring' : 'static'}
          size={8}
        />
        <span class={styles.title} title={props.task.description}>
          {props.task.id}
        </span>
        <Chip label={formatPriorityLabel(props.task.priority)} />
        <span class={styles.elapsed}>{elapsed()}</span>
      </header>
      <Show when={props.task.status === 'running' && props.task.progress}>
        <ProgressChain progress={props.task.progress!} />
      </Show>
      <Show when={props.task.branches && props.task.branches.length > 0}>
        <div class={styles.branchList}>
          <For each={props.task.branches}>
            {(branch) => <BranchRow branch={branch} />}
          </For>
        </div>
      </Show>
    </article>
  );
};
