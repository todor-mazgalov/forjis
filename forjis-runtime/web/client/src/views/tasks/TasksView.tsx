/**
 * TasksView — top-level layout for the Tasks page.
 *
 * Three-column CSS grid per TASK.md (redesign-005). Owns the
 * `selectedTaskId` signal shared by the rail, pipeline, and detail panes.
 * The pipeline column went live in redesign-006/007; the detail column
 * is live as of redesign-008 — the right track now mounts
 * {@link DetailPane}, which fans out a step header, a four-
 * tab strip, and the live Events stream.
 *
 * `PipelineSelectionProvider` wraps the pipeline and detail columns so both
 * siblings share `selectedStepId`. The `TaskRail` is intentionally outside
 * the provider — it has no need for the step-level signal.
 */

import type { Component } from 'solid-js';
import { createSignal } from 'solid-js';
import { DetailPane } from './DetailPane';
import { TaskRail } from './TaskRail';
import { PipelinePanel } from './PipelinePanel';
import { PipelineSelectionProvider } from './PipelineSelectionContext';
import styles from './TasksView.module.css';

/** Tasks page root. Mount inside the shell's `<main>` outlet. */
export const TasksView: Component = () => {
  const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null);
  return (
    <section class={styles.grid} aria-label="Tasks view">
      <TaskRail
        selectedTaskId={selectedTaskId()}
        onSelect={setSelectedTaskId}
      />
      <PipelineSelectionProvider selectedTaskId={selectedTaskId}>
        <PipelinePanel selectedTaskId={selectedTaskId()} />
        <DetailPane selectedTaskId={selectedTaskId} />
      </PipelineSelectionProvider>
    </section>
  );
};
