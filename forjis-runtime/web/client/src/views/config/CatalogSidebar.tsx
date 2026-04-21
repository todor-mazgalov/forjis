/**
 * CatalogSidebar — left column of the Config view.
 *
 * Three sections: `Catalog` (type filter + counts), `System` (Health check /
 * Tokens config toggles), `Plugins` (one row per plugin + a synthetic
 * `project` row when the catalog contains project-rooted items). Counts are
 * derived from the full catalog so the sidebar numbers stay stable as the
 * search input narrows the grid (design.md § D-9).
 */

import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';
import type { PluginResource } from '@forjis/shared';
import type { CatalogType, TypeCountMap } from './catalog';
import styles from './CatalogSidebar.module.css';

/** One row in the type-filter section. Ordered per spec. */
interface TypeRow {
  /** Filter key. `'all'` matches every catalog item. */
  key: CatalogType | 'all';
  /** Display label. */
  label: string;
}

/** Sidebar type-filter rows, rendered in this exact order. */
const TYPE_ROWS: TypeRow[] = [
  { key: 'all', label: 'All items' },
  { key: 'role', label: 'Roles' },
  { key: 'skill', label: 'Skills' },
  { key: 'hook', label: 'Hooks' },
  { key: 'agent', label: 'Agents' },
  { key: 'constraint', label: 'Constraints' },
  { key: 'persona', label: 'Personas' },
  { key: 'outcome', label: 'Outcomes' },
];

/** Props for {@link CatalogSidebar}. */
export interface CatalogSidebarProps {
  /** Currently selected type filter (`'all'` when every type is visible). */
  typeFilter: CatalogType | 'all';
  /** Setter for the type filter; parent also resets neighbouring signals. */
  setTypeFilter: (next: CatalogType | 'all') => void;
  /** Active plugin origins. Empty set means "All sources". */
  pluginFilter: Set<string>;
  /** Toggle one plugin origin in the filter set. */
  togglePlugin: (name: string) => void;
  /** Reset the plugin filter to the empty set. */
  clearPluginFilter: () => void;
  /** Type-counts map derived from the full (pre-search) catalog. */
  counts: TypeCountMap;
  /** Per-origin counts derived from the full catalog. */
  pluginCounts: Map<string, number>;
  /** Plugin resources advertised by `/api/resources`. */
  plugins: PluginResource[];
  /** Active system panel, or `null` when the card grid is visible. */
  systemPanel: null | 'health' | 'tokens';
  /** Setter for the system panel; parent also clears the selection. */
  setSystemPanel: (next: null | 'health' | 'tokens') => void;
  /** Health-check badge label — `'ok'` when `/api/config` returned a
   *  health-check block, else `'unavailable'`. */
  healthBadge: string;
  /** Tokens-config badge label — `'<percent>%'` when a token budget is
   *  configured, or `null` to hide the badge entirely. */
  tokensBadge: string | null;
}

/**
 * Compose the list of CSS module classes for one sidebar nav row. `active`
 * highlight is controlled by the caller.
 */
function navClass(active: boolean): string {
  return active ? `${styles.configNavItem} ${styles.configNavItemActive}` : styles.configNavItem;
}

/** Lookup helper for per-type counts by key. */
function countFor(counts: TypeCountMap, key: CatalogType | 'all'): number {
  if (key === 'all') return counts.all;
  return counts[key];
}

/** Three-section sidebar. See file header. */
export const CatalogSidebar: Component<CatalogSidebarProps> = (props) => {
  const projectCount = (): number => props.pluginCounts.get('project') ?? 0;
  return (
    <aside class={styles.sidebar} aria-label="Config catalog sidebar">
      <div class={styles.configSection}>Catalog</div>
      <For each={TYPE_ROWS}>
        {(row) => (
          <button
            type="button"
            class={navClass(props.typeFilter === row.key && props.systemPanel === null)}
            onClick={() => props.setTypeFilter(row.key)}
          >
            {row.label}
            <span class={styles.count}>{countFor(props.counts, row.key)}</span>
          </button>
        )}
      </For>

      <div class={styles.configSection}>System</div>
      <button
        type="button"
        class={navClass(props.systemPanel === 'health')}
        onClick={() => props.setSystemPanel('health')}
      >
        Health check
        <span class={styles.count}>{props.healthBadge}</span>
      </button>
      <button
        type="button"
        class={navClass(props.systemPanel === 'tokens')}
        onClick={() => props.setSystemPanel('tokens')}
      >
        Tokens config
        <Show when={props.tokensBadge !== null}>
          <span class={styles.count}>{props.tokensBadge}</span>
        </Show>
      </button>

      <div class={styles.configSection}>Plugins</div>
      <button
        type="button"
        class={navClass(props.pluginFilter.size === 0)}
        onClick={() => props.clearPluginFilter()}
      >
        All sources
        <span class={styles.count}>{props.counts.all}</span>
      </button>
      <For each={props.plugins}>
        {(plugin) => (
          <button
            type="button"
            class={navClass(props.pluginFilter.has(plugin.name))}
            onClick={() => props.togglePlugin(plugin.name)}
            title={plugin.name}
          >
            <span class={styles.pluginLabel}>{plugin.name}</span>
            <span class={styles.count}>{props.pluginCounts.get(plugin.name) ?? 0}</span>
          </button>
        )}
      </For>
      <Show when={projectCount() > 0}>
        <button
          type="button"
          class={navClass(props.pluginFilter.has('project'))}
          onClick={() => props.togglePlugin('project')}
        >
          <span class={styles.pluginLabel}>project</span>
          <span class={styles.count}>{projectCount()}</span>
        </button>
      </Show>
    </aside>
  );
};
