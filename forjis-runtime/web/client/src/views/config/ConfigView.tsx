/**
 * ConfigView — outlet-level shell for the Config page.
 *
 * Owns the five filter/selection signals and the three `createResource` reads
 * behind the page (`/api/resources`, `/api/config`, `/api/token-usage`).
 * Fans out four children: `CatalogSidebar`, `CardGrid` (or `SystemPanels`
 * when a system row is active), and — conditionally — `DetailDrawer` inside
 * the main column (design.md § D-7, D-8).
 */

import type { Component } from 'solid-js';
import { Show, batch, createMemo, createResource, createSignal } from 'solid-js';
import type { ConfigResponse, ResourcesResponse, TokenUsageResponse } from '@forjis/shared';
import { fetchConfig, fetchTokenUsage, getResources } from '../../shell/api';
import { CatalogSidebar } from './CatalogSidebar';
import { CardGrid } from './CardGrid';
import { DetailDrawer } from './DetailDrawer';
import { SystemPanels } from './SystemPanels';
import {
  buildCatalog,
  pluginCounts,
  selectByKey,
  togglePluginSet,
  typeCounts,
} from './catalog';
import type { CatalogItem, CatalogType, TypeCountMap } from './catalog';
import styles from './ConfigView.module.css';

/** Apply the active type/plugin/search filters to one catalog item. */
function itemPassesFilters(
  item: CatalogItem,
  type: CatalogType | 'all',
  plugins: Set<string>,
  query: string,
): boolean {
  if (type !== 'all' && item.type !== type) return false;
  if (plugins.size > 0 && !plugins.has(item.origin)) return false;
  if (query === '') return true;
  const haystack = `${item.name} ${item.origin} ${item.desc}`.toLowerCase();
  return haystack.includes(query);
}

/** Derive the sidebar badge for the Health-check row. `ok` when
 *  `/api/config` returned a health-check block, `unavailable` otherwise. */
function healthBadgeLabel(config: ConfigResponse | null): string {
  return config !== null ? 'ok' : 'unavailable';
}

/** Derive the sidebar badge for the Tokens-config row. `<percent>%` when a
 *  token budget is configured, `null` to hide the badge entirely. */
function tokensBadgeLabel(usage: TokenUsageResponse | null): string | null {
  if (usage === null || usage.budget === null) return null;
  const { totalTokens } = usage;
  const { maxTokens } = usage.budget;
  if (maxTokens <= 0) return null;
  const ratio = totalTokens / maxTokens;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return `${Math.round(clamped * 100)}%`;
}

/** Outlet-level Config page. See file header. */
export const ConfigView: Component = () => {
  const [typeFilter, setTypeFilter] = createSignal<CatalogType | 'all'>('all');
  const [pluginFilter, setPluginFilter] = createSignal<Set<string>>(new Set());
  const [search, setSearch] = createSignal<string>('');
  const [selected, setSelected] = createSignal<CatalogItem | null>(null);
  const [systemPanel, setSystemPanel] = createSignal<null | 'health' | 'tokens'>(null);

  const [resources] = createResource<ResourcesResponse | null, true>(
    () => true,
    async () => getResources(),
  );
  const [config] = createResource<ConfigResponse | null, true>(
    () => true,
    async () => fetchConfig(),
  );
  const [tokenUsage] = createResource<TokenUsageResponse | null, true>(
    () => true,
    async () => fetchTokenUsage(),
  );

  const catalog = createMemo<CatalogItem[]>(() =>
    buildCatalog(resources() ?? null, config() ?? null),
  );
  const counts = createMemo<TypeCountMap>(() => typeCounts(catalog()));
  const pluginCountsMap = createMemo<Map<string, number>>(() => pluginCounts(catalog()));
  const filtered = createMemo<CatalogItem[]>(() => {
    const items = catalog();
    const type = typeFilter();
    const plugins = pluginFilter();
    const query = search().trim().toLowerCase();
    return items.filter((item) => itemPassesFilters(item, type, plugins, query));
  });

  /** Cross-link handler — called from role-card chips and drawer chips. */
  const selectByTypeAndName = (type: CatalogType, name: string): void => {
    const target = selectByKey(catalog(), type, name);
    if (target === null) return;
    batch(() => {
      setTypeFilter(type);
      setPluginFilter(new Set<string>());
      setSystemPanel(null);
      setSelected(target);
    });
  };

  /** Sidebar type-filter setter that also resets system panel + selection. */
  const handleSetTypeFilter = (next: CatalogType | 'all'): void => {
    batch(() => {
      setTypeFilter(next);
      setSystemPanel(null);
      setSelected(null);
    });
  };

  /** System-panel setter that also clears the drawer selection. */
  const handleSetSystemPanel = (next: null | 'health' | 'tokens'): void => {
    batch(() => {
      setSystemPanel(next);
      setSelected(null);
    });
  };

  /** Toggle a plugin origin in/out of the filter set. Fresh Set each time. */
  const handleTogglePlugin = (name: string): void => {
    setPluginFilter((prev) => togglePluginSet(prev, name));
  };

  return (
    <div class={styles.view}>
      <CatalogSidebar
        typeFilter={typeFilter()}
        setTypeFilter={handleSetTypeFilter}
        pluginFilter={pluginFilter()}
        togglePlugin={handleTogglePlugin}
        clearPluginFilter={() => setPluginFilter(new Set())}
        counts={counts()}
        pluginCounts={pluginCountsMap()}
        plugins={resources()?.plugins ?? []}
        systemPanel={systemPanel()}
        setSystemPanel={handleSetSystemPanel}
        healthBadge={healthBadgeLabel(config() ?? null)}
        tokensBadge={tokensBadgeLabel(tokenUsage() ?? null)}
      />
      <div class={styles.main}>
        <Show
          when={systemPanel() === null}
          fallback={
            <SystemPanels
              panel={systemPanel() ?? 'health'}
              config={config() ?? null}
              tokenUsage={tokenUsage() ?? null}
            />
          }
        >
          <CardGrid
            items={filtered()}
            resultCount={filtered().length}
            search={search()}
            setSearch={setSearch}
            selected={selected()}
            onSelect={(item) => setSelected(item)}
            onCrossLink={selectByTypeAndName}
          />
        </Show>
        <Show when={selected()}>
          {(item) => (
            <DetailDrawer
              item={item()}
              onClose={() => setSelected(null)}
              onCrossLink={selectByTypeAndName}
            />
          )}
        </Show>
      </div>
    </div>
  );
};
