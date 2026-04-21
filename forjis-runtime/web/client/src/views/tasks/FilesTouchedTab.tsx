/**
 * FilesTouchedTab — detail-pane body for the "Files touched" tab (redesign-009).
 *
 * Lists the files the pipeline has written so far, sourced from the output
 * manifest (`GET /api/tasks/:id/manifest`). When a step is selected in the
 * middle column, the list is filtered to that role's entries; with no step
 * selected the tab shows every manifest entry for the task. Clicking a row
 * calls `openFile(path, 'project')` on the app-global file-viewer store
 * (redesign-021 §7) which routes through the project-file viewer path.
 *
 * OpenSpec entries (`openspec/changes/<taskId>/`) are excluded here — they
 * surface in the OpenSpec tab instead (redesign-021 §8). The predicate
 * {@link isOpenSpecEntry} implements this filter.
 *
 * Role matching (per `fix-roles-display`): the manifest `role` field is
 * written as the bare role name (no composite string). The selected step is
 * identified by its structured `{org, team, role}` triple, and the row
 * filter compares `file.role === step.role` exactly — no trailing-segment
 * fuzzy match. When the manifest later gains `org`/`team` fields the
 * equality can widen here without touching callers.
 *
 * See design.md (redesign-009) § FilesTouchedTab for the data flow and the
 * rationale for client-side role filtering (D-2) and rendering whatever the
 * manifest actually exposes rather than invented "operation" / "line-count"
 * fields (D-4).
 */

import type { Accessor, Component, JSX } from 'solid-js';
import { For, Show, createMemo, createResource } from 'solid-js';
import type {
  ManifestFileEntry,
  ManifestResponse,
  RoleIdentity,
} from '@forjis/shared';
import { getManifest } from '../../shell/api';
import { openFile } from '../../components/fileViewerStore';
import { isOpenSpecEntry } from './openspec-filter';
import { RoleLabel } from './RoleLabel';
import styles from './FilesTouchedTab.module.css';

export { isOpenSpecEntry } from './openspec-filter';

/** Props for {@link FilesTouchedTab}. */
export interface FilesTouchedTabProps {
  /** Currently selected task id. `null` → renders the "select a task" placeholder. */
  taskId: string | null;
  /** Currently selected step identity triple, or `null` for the unfiltered view. */
  selectedStep: RoleIdentity | null;
  /**
   * Lifted manifest accessor. When provided, FilesTouchedTab reads from it
   * instead of running its own fetch — the DetailPane-owned resource becomes
   * the single source of truth for the tab body and the header's
   * Files-touched counter. When absent, the tab falls back to the internal
   * `createResource(getManifest)` path so unit tests that construct this
   * component directly keep working unchanged.
   */
  manifest?: Accessor<ManifestResponse | null>;
}

/**
 * Keep only manifest entries that match the selected role AND are not
 * OpenSpec artifacts. When `selectedStep` is `null` all non-openspec entries
 * are kept. Matching is structural equality on the bare role name (see the
 * module header for the widening plan once the manifest carries org/team).
 *
 * @param files - Full manifest file list.
 * @param selectedStep - Selected role identity filter, or `null` for unfiltered view.
 * @param taskId - Task id used to identify OpenSpec artifact paths.
 */
function filterVisibleFiles(
  files: readonly ManifestFileEntry[],
  selectedStep: RoleIdentity | null,
  taskId: string | null,
): ManifestFileEntry[] {
  return files.filter((file) => {
    if (taskId !== null && isOpenSpecEntry(file.path, taskId)) return false;
    if (selectedStep === null) return true;
    return file.role === selectedStep.role;
  });
}

/** Live Files-touched tab. See file header. */
export const FilesTouchedTab: Component<FilesTouchedTabProps> = (props) => {
  // When DetailPane passes a `manifest` accessor the internal resource is
  // unused — but we still declare it so the fallback path stays reactive.
  // SolidJS `createResource` with a `null` source never fires the fetcher,
  // keeping the unused-resource branch network-silent.
  const [localManifest] = createResource<ManifestResponse | null, string | null>(
    () => (props.manifest === undefined ? props.taskId : null),
    async (id) => (id === null ? null : getManifest(id)),
  );

  const manifest = (): ManifestResponse | null =>
    props.manifest !== undefined ? props.manifest() : (localManifest() ?? null);

  const visibleFiles = createMemo<ManifestFileEntry[]>(() => {
    const data = manifest();
    if (!data) return [];
    return filterVisibleFiles(data.files, props.selectedStep, props.taskId);
  });

  return (
    <div class={styles.body}>
      <Show
        when={props.taskId !== null}
        fallback={<div class={styles.placeholder}>Select a task to see files</div>}
      >
        <Show
          when={visibleFiles().length > 0}
          fallback={<div class={styles.placeholder}>No files touched</div>}
        >
          <For each={visibleFiles()}>
            {(file): JSX.Element => (
              <button
                type="button"
                class={styles.row}
                title={file.path}
                onClick={() => openFile(file.path, 'project')}
              >
                <span class={styles.rowDot} aria-hidden="true">
                  &bull;
                </span>
                <span class={styles.rowRole}>
                  <Show
                    when={props.selectedStep !== null}
                    fallback={file.role}
                  >
                    <RoleLabel
                      role={file.role}
                      team={props.selectedStep?.team ?? ''}
                    />
                  </Show>
                </span>
                <span class={styles.rowPath}>{file.path}</span>
              </button>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
};
