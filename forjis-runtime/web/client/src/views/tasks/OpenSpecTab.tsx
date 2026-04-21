/**
 * OpenSpecTab — detail-pane body for the "OpenSpec" tab (redesign-009,
 * extended redesign-021 §8).
 *
 * Renders the union of two sources:
 *   1. Top-level `.md` files under `.forjis/tasks/<taskId>/` — opened via
 *      `source='task'` (the existing path, unchanged).
 *   2. Manifest entries under `openspec/changes/<taskId>/` — opened via
 *      `source='project'` through the new `getProjectFile` route (§7).
 *
 * The second source is driven by the lifted `manifest` accessor passed from
 * `DetailPane` so a single manifest resource backs both the badge count and
 * the tab body without a second fetch.
 *
 * The tab is task-scoped (no `stepRoleId` filter) because every pipeline step
 * shares the same task directory. See design.md (redesign-009) § OpenSpecTab.
 */

import type { Accessor, Component, JSX } from 'solid-js';
import { For, Show, createMemo, createResource } from 'solid-js';
import type { ManifestResponse } from '@forjis/shared';
import { getTaskFiles } from '../../shell/api';
import { openFile } from '../../components/fileViewerStore';
import { openSpecManifestPaths } from './openspec-tab-utils';
import styles from './OpenSpecTab.module.css';

// Re-export the pure helper so callers (tests, DetailPane) can import it from
// here without knowing about the companion module.
export { openSpecManifestPaths } from './openspec-tab-utils';

/** Props for {@link OpenSpecTab}. */
export interface OpenSpecTabProps {
  /** Currently selected task id. `null` → renders the "select a task" placeholder. */
  taskId: string | null;
  /**
   * Lifted manifest accessor from `DetailPane`. When provided, OpenSpecTab
   * reads it to surface `openspec/changes/<taskId>/` entries alongside the
   * task-dir `.md` files — no second manifest fetch is made.
   */
  manifest?: Accessor<ManifestResponse | null>;
  /**
   * Lifted task-files accessor from `DetailPane` (redesign-021 §13).
   * When provided, OpenSpecTab reads from this instead of creating its own
   * `getTaskFiles` resource — a single resource backs both the badge count
   * and the tab body without a second HTTP fetch.
   */
  taskFiles?: Accessor<string[] | null>;
}

/** Live OpenSpec tab. See file header. */
export const OpenSpecTab: Component<OpenSpecTabProps> = (props) => {
  // If a lifted accessor is provided by DetailPane, use it directly; otherwise
  // fall back to a local resource so the tab is usable standalone (e.g. tests,
  // storybook). This satisfies redesign-021 §13: one resource, no double fetch.
  const [localTaskFiles] = createResource<string[] | null, string | null>(
    () => (props.taskFiles !== undefined ? null : props.taskId),
    async (id) => (id === null ? null : getTaskFiles(id)),
  );

  const taskFiles = (): string[] | null =>
    props.taskFiles !== undefined ? props.taskFiles() : (localTaskFiles() ?? null);

  const manifestPaths = createMemo<string[]>(() => {
    if (props.taskId === null) return [];
    return openSpecManifestPaths(props.manifest?.() ?? null, props.taskId);
  });

  const allFiles = createMemo<Array<{ path: string; source: 'task' | 'project' }>>(() => {
    const taskEntries = (taskFiles() ?? []).map((path) => ({ path, source: 'task' as const }));
    const projectEntries = manifestPaths().map((path) => ({ path, source: 'project' as const }));
    return [...taskEntries, ...projectEntries];
  });

  return (
    <div class={styles.body}>
      <Show
        when={props.taskId !== null}
        fallback={<div class={styles.placeholder}>Select a task to see OpenSpec files</div>}
      >
        <Show
          when={allFiles().length > 0}
          fallback={<div class={styles.placeholder}>No OpenSpec files</div>}
        >
          <For each={allFiles()}>
            {(entry): JSX.Element => (
              <button
                type="button"
                class={styles.row}
                title={entry.path}
                onClick={() => {
                  if (entry.source === 'task') {
                    openFile(entry.path, 'task', props.taskId!);
                  } else {
                    openFile(entry.path, 'project');
                  }
                }}
              >
                <span class={styles.rowDot} aria-hidden="true">
                  •
                </span>
                <span class={styles.rowPath}>{entry.path}</span>
              </button>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
};
