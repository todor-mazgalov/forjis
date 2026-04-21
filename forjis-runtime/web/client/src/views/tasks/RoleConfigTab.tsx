/**
 * RoleConfigTab — detail-pane body for the "Config" tab (redesign-009).
 *
 * Renders the selected role's definition: an inline key/value block for
 * the static fields (role id, origin, agent, expertise) plus one chip row
 * per attached-resource kind (agent, skills, hooks, constraints, outcomes,
 * personas). Chip clicks call `openFile(resource.path, 'plugin')` on the
 * app-global file-viewer store (redesign-010), which pops open the modal.
 *
 * The tab has no standalone "Files" block (explicit task-9 requirement);
 * the file affordance lives on the chips themselves. See design.md
 * (redesign-009) § RoleConfigTab for the plan + resources resolution
 * strategy (D-1/D-5) and the graceful-degradation rules for missing
 * fields and empty `*Paths` arrays (D-4).
 *
 * Role identity (per `fix-roles-display`): the tab is driven by the
 * structured `{org, team, role}` identity from the selection context. The
 * runtime `resources` response still ships role names as the resolver's
 * internal scoped form (`<origin>:<Role>`) so the lookup trims the scoped
 * prefix and compares against the bare role name from the selection.
 */

import type { Component, JSX } from 'solid-js';
import { For, Show, createMemo, createResource } from 'solid-js';
import type {
  ConfigResponse,
  ResourcesResponse,
  RoleIdentity,
  RoleResource,
} from '@forjis/shared';
import { Chip, type ChipTone } from '../../components/primitives/Chip';
import { fetchConfig, getResources } from '../../shell/api';
import { openFile } from '../../components/fileViewerStore';
import { RoleLabel } from './RoleLabel';
import styles from './RoleConfigTab.module.css';

/** Em-dash used when an optional field is absent. */
const EM_DASH = '—';

/** Props for {@link RoleConfigTab}. */
export interface RoleConfigTabProps {
  /** Currently selected task id. `null` → renders the "select a task" placeholder. */
  taskId: string | null;
  /** Currently selected step identity, or `null` for the "select a step" placeholder. */
  selectedStep: RoleIdentity | null;
}

/** Single chip entry rendered inside an {@link AttachedRow}. */
interface ChipEntry {
  /** Display label — typically the basename of the path, or the resource name. */
  label: string;
  /** Full plugin-root-relative path, or empty when unresolved. */
  path: string;
}

/**
 * Return the last `:`-separated tail of the resolver's scoped role name.
 * Used only for matching the scoped resources entry against the bare role
 * from the selection triple. When the name has no colon, returns the full
 * name.
 */
function bareRoleName(scopedName: string): string {
  const idx = scopedName.lastIndexOf(':');
  if (idx < 0) return scopedName;
  return scopedName.slice(idx + 1);
}

/**
 * Extract the origin (plugin slug) from a `<origin>:<Name>` role name.
 * Returns {@link EM_DASH} when the name has no colon.
 */
function roleOrigin(scopedName: string): string {
  const idx = scopedName.indexOf(':');
  if (idx < 0) return EM_DASH;
  return scopedName.slice(0, idx);
}

/**
 * Extract the basename of a path — last `/` or `\` segment stripped of
 * any trailing `.md`. Used as the display label for hook / constraint /
 * outcome / persona chips whose display names aren't carried on
 * `RoleResource`.
 */
function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? path;
  return last.replace(/\.md$/i, '');
}

/**
 * Locate the `RoleResource` for the given structured identity by walking
 * `resources.orgs[].teams[].roles[]`. The org and team names on the
 * resources blob match the source-config shape exactly; the role entry is
 * matched against the bare role name from the identity so the scoped-prefix
 * drift between the resources blob and the identity triple does not block
 * the lookup.
 */
function resolveRole(
  resources: ResourcesResponse,
  identity: RoleIdentity,
): RoleResource | null {
  const org = resources.orgs.find((entry) => entry.name === identity.org);
  if (!org) return null;
  const team = org.teams.find((entry) => entry.name === identity.team);
  if (!team) return null;
  return team.roles.find((entry) => bareRoleName(entry.name) === identity.role) ?? null;
}

/**
 * Build {@link ChipEntry}s from aligned `names` + `paths` arrays.
 * When `names` is shorter than `paths`, the extra paths fall through
 * with their basename used as the label. When `paths` is shorter,
 * the remaining names render with an empty path (non-clickable).
 */
function zipChips(names: readonly string[], paths: readonly string[]): ChipEntry[] {
  const max = Math.max(names.length, paths.length);
  const entries: ChipEntry[] = [];
  for (let i = 0; i < max; i += 1) {
    const path = paths[i] ?? '';
    const label = names[i] ?? basename(path);
    entries.push({ label, path });
  }
  return entries;
}

/** Build chip lists for every attached-resource row on a role. */
function buildChipMap(role: RoleResource): Record<string, ChipEntry[]> {
  return {
    agent: role.agentPath || role.agent
      ? [{ label: role.agent, path: role.agentPath }]
      : [],
    skills: zipChips(role.skills, role.skillPaths),
    hooks: role.hookPaths.map((path) => ({ label: basename(path), path })),
    constraints: role.constraintPaths.map((path) => ({ label: basename(path), path })),
    outcomes: role.outcomePaths.map((path) => ({ label: basename(path), path })),
    personas: role.personaPaths.map((path) => ({ label: basename(path), path })),
  };
}

/**
 * Inline row of chip buttons for one attached-resource kind. Renders
 * nothing when `entries` is empty so rows stay proportional to the
 * amount of metadata the role actually carries.
 */
function AttachedRow(props: {
  label: string;
  tone: ChipTone;
  entries: ChipEntry[];
}): JSX.Element {
  return (
    <Show when={props.entries.length > 0}>
      <div class={styles.attachedRow}>
        <div class={styles.attachedLabel}>{props.label}</div>
        <div class={styles.attachedChips}>
          <For each={props.entries}>
            {(entry): JSX.Element => (
              <button
                type="button"
                class={styles.chipButton}
                classList={{ [styles.chipButtonDisabled]: entry.path === '' }}
                disabled={entry.path === ''}
                title={entry.path || entry.label}
                aria-label={entry.label}
                onClick={() => openFile(entry.path, 'plugin')}
              >
                <Chip tone={props.tone} label={entry.label} />
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

/** Render a single key/value row inside the role-definition block. */
function KvRow(props: { label: string; value: JSX.Element }): JSX.Element {
  return (
    <>
      <span class={styles.kvKey}>{props.label}</span>
      <span class={styles.kvValue}>{props.value}</span>
    </>
  );
}

/**
 * Resolve the expertise string for the currently selected role from the
 * richer `/api/config` payload. `/api/resources` does not expose
 * `expertise`, so the Config tab fetches both endpoints in parallel: the
 * former for chip labels + plugin paths, the latter for the expertise
 * block. Returns an empty string when the match or the field is absent.
 */
function expertiseFor(
  config: ConfigResponse,
  identity: RoleIdentity,
): string {
  const org = config.orgs.orgs.find((entry) => entry.name === identity.org);
  if (!org) return '';
  const team = org.teams.find((entry) => entry.name === identity.team);
  if (!team) return '';
  const role = team.roles.find((entry) => bareRoleName(entry.name) === identity.role);
  return role?.expertise ?? '';
}

/** Live Config tab. See file header. */
export const RoleConfigTab: Component<RoleConfigTabProps> = (props) => {
  const [resources] = createResource<ResourcesResponse | null, true>(
    () => true,
    async () => getResources(),
  );
  const [config] = createResource<ConfigResponse | null, true>(
    () => true,
    async () => fetchConfig(),
  );

  const role = createMemo<RoleResource | null>(() => {
    const resourcesValue = resources();
    const identity = props.selectedStep;
    if (!resourcesValue || identity === null) return null;
    return resolveRole(resourcesValue, identity);
  });

  const expertise = createMemo<string>(() => {
    const configValue = config();
    const identity = props.selectedStep;
    if (!configValue || identity === null) return '';
    return expertiseFor(configValue, identity);
  });

  const chips = createMemo<Record<string, ChipEntry[]>>(() => {
    const value = role();
    if (!value) return { agent: [], skills: [], hooks: [], constraints: [], outcomes: [], personas: [] };
    return buildChipMap(value);
  });

  return (
    <div class={styles.body}>
      <Show
        when={props.taskId !== null}
        fallback={<div class={styles.placeholder}>Select a task to see role config</div>}
      >
        <Show
          when={props.selectedStep !== null}
          fallback={<div class={styles.placeholder}>Select a step to see its config</div>}
        >
          <Show
            when={role()}
            fallback={<div class={styles.placeholder}>Role config not found</div>}
          >
            {(resolved): JSX.Element => (
              <>
                <div class={styles.sectionTitle}>Role definition</div>
                <div class={styles.kvTable}>
                  <KvRow
                    label="role"
                    value={
                      <RoleLabel
                        role={props.selectedStep?.role ?? bareRoleName(resolved().name)}
                        team={props.selectedStep?.team ?? ''}
                      />
                    }
                  />
                  <KvRow label="origin" value={roleOrigin(resolved().name)} />
                  <KvRow label="agent" value={resolved().agent || EM_DASH} />
                </div>

                <div class={styles.sectionTitle}>Attached</div>
                <AttachedRow label="Agent" tone="agent" entries={chips().agent ?? []} />
                <AttachedRow label="Skills" tone="skill" entries={chips().skills ?? []} />
                <AttachedRow label="Hooks" tone="hook" entries={chips().hooks ?? []} />
                <AttachedRow label="Constraints" tone="constraint" entries={chips().constraints ?? []} />
                <AttachedRow label="Outcomes" tone="outcome" entries={chips().outcomes ?? []} />
                <AttachedRow label="Personas" tone="persona" entries={chips().personas ?? []} />

                <Show when={expertise() !== ''}>
                  <div class={styles.sectionTitle}>Expertise</div>
                  <pre class={styles.codeBlock}>{expertise()}</pre>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  );
};
