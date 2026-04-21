/**
 * CardGrid — middle column of the Config view.
 *
 * Owns a search toolbar and a responsive `auto-fill, minmax(260px, 1fr)` grid
 * of type-specific card renderers. Cards are rendered as native `<button>`
 * elements so keyboard activation works; attached-chip buttons stop click
 * propagation so the outer card click does not fire. See design.md § CardGrid
 * for the per-type card layout contract.
 */

import type { Component, JSX } from 'solid-js';
import { For, Match, Show, Switch } from 'solid-js';
import type {
  CatalogAgent,
  CatalogConstraint,
  CatalogHook,
  CatalogItem,
  CatalogOutcome,
  CatalogPersona,
  CatalogRole,
  CatalogSkill,
  CatalogType,
} from './catalog';
import { basename } from './catalog';
import { AttachedChipRow } from './AttachedChipRow';
import { KindPill } from './KindPill';
import styles from './CardGrid.module.css';

/** Props for {@link CardGrid}. */
export interface CardGridProps {
  /** Post-filter items to render, in sidebar order. */
  items: CatalogItem[];
  /** Visible "N results" count — mirrors `items.length` but kept explicit. */
  resultCount: number;
  /** Search query string. Parent owns the signal. */
  search: string;
  /** Setter that writes the search-query signal. */
  setSearch: (q: string) => void;
  /** Currently selected catalog item, or `null`. Controls the `selected` class. */
  selected: CatalogItem | null;
  /** Card-click handler. Opens the detail drawer in the parent. */
  onSelect: (item: CatalogItem) => void;
  /** Cross-link handler. Fired when a chip on a role card is clicked. */
  onCrossLink: (type: CatalogType, name: string) => void;
}

/** Type-icon metadata for card heads. Keeps the lookup static and typed. */
const TYPE_ICON: Record<CatalogType, { label: string; className: string }> = {
  role: { label: 'R', className: 'catIconRole' },
  skill: { label: 'S', className: 'catIconSkill' },
  hook: { label: 'H', className: 'catIconHook' },
  agent: { label: 'A', className: 'catIconAgent' },
  constraint: { label: 'C', className: 'catIconConstraint' },
  outcome: { label: 'O', className: 'catIconOutcome' },
  persona: { label: 'P', className: 'catIconPersona' },
};

/**
 * Compose the class list for a card root. `selected` toggles the accent
 * highlight.
 */
function cardClass(selected: boolean): string {
  return selected ? `${styles.catCard} ${styles.catCardSelected}` : styles.catCard;
}

/** Icon + name + origin block used as the head of every card variant. */
const Head: Component<{ item: CatalogItem; trailing?: JSX.Element }> = (props) => {
  const iconMeta = (): { label: string; className: string } => TYPE_ICON[props.item.type];
  return (
    <div class={styles.catHead}>
      <span class={`${styles.catIcon} ${styles[iconMeta().className]}`}>
        {iconMeta().label}
      </span>
      <div class={styles.catHeadText}>
        <div class={styles.catName}>{props.item.name}</div>
        <div class={styles.catOrigin}>{props.item.origin}</div>
      </div>
      <Show when={props.trailing}>{props.trailing}</Show>
    </div>
  );
};

/** Render a single `label → value` row inside `.catKv`. */
const Kv: Component<{ label: string; value: string }> = (props) => (
  <>
    <span class={styles.catKvKey}>{props.label}</span>
    <span class={styles.catKvValue}>{props.value}</span>
  </>
);

/**
 * Role card body: head + attached-chip rows. Every row renders nothing when
 * its source array is empty, so the card height is proportional to the
 * amount of metadata the role actually carries.
 */
const RoleCard: Component<{
  item: CatalogRole;
  onCrossLink: (type: CatalogType, name: string) => void;
}> = (props) => {
  const constraintNames = (): string[] => props.item.constraintPaths.map(basename);
  const outcomeNames = (): string[] => props.item.outcomePaths.map(basename);
  const personaNames = (): string[] => props.item.personaPaths.map(basename);
  const hookNames = (): string[] => props.item.hookPaths.map(basename);
  const agentNames = (): string[] => (props.item.agent ? [props.item.agent] : []);
  return (
    <>
      <Head item={props.item} />
      <div class={styles.catAttached}>
        <AttachedChipRow
          label="agent"
          tone="agent"
          type="agent"
          names={agentNames()}
          onCrossLink={props.onCrossLink}
        />
        <AttachedChipRow
          label="skills"
          tone="skill"
          type="skill"
          names={props.item.skills}
          onCrossLink={props.onCrossLink}
        />
        <AttachedChipRow
          label="hooks"
          tone="hook"
          type="hook"
          names={hookNames()}
          onCrossLink={props.onCrossLink}
        />
        <AttachedChipRow
          label="constraints"
          tone="constraint"
          type="constraint"
          names={constraintNames()}
          onCrossLink={props.onCrossLink}
        />
        <AttachedChipRow
          label="outcomes"
          tone="outcome"
          type="outcome"
          names={outcomeNames()}
          onCrossLink={props.onCrossLink}
        />
        <AttachedChipRow
          label="personas"
          tone="persona"
          type="persona"
          names={personaNames()}
          onCrossLink={props.onCrossLink}
        />
      </div>
    </>
  );
};

/** Skill card — head + description. `args` is a future DTO field placeholder. */
const SkillCard: Component<{ item: CatalogSkill }> = (props) => (
  <>
    <Head item={props.item} />
    <Show when={props.item.desc !== ''}>
      <div class={styles.catDesc}>{props.item.desc}</div>
    </Show>
  </>
);

/** Hook card — head + description. `trigger` is a future DTO field placeholder. */
const HookCard: Component<{ item: CatalogHook }> = (props) => (
  <>
    <Head item={props.item} />
    <Show when={props.item.desc !== ''}>
      <div class={styles.catDesc}>{props.item.desc}</div>
    </Show>
  </>
);

/** Agent card — head + description only today. */
const AgentCard: Component<{ item: CatalogAgent }> = (props) => (
  <>
    <Head item={props.item} />
    <Show when={props.item.desc !== ''}>
      <div class={styles.catDesc}>{props.item.desc}</div>
    </Show>
  </>
);

/** Constraint card — head with trailing kind pill + description + kv row. */
const ConstraintCard: Component<{ item: CatalogConstraint }> = (props) => (
  <>
    <Head item={props.item} trailing={<KindPill kind={props.item.kind} />} />
    <Show when={props.item.desc !== ''}>
      <div class={styles.catDesc}>{props.item.desc}</div>
    </Show>
    <div class={styles.catKv}>
      <Kv label="kind" value={props.item.kind} />
    </div>
  </>
);

/** Outcome card — head + inline rule summary. */
const OutcomeCard: Component<{ item: CatalogOutcome }> = (props) => (
  <>
    <Head item={props.item} />
    <Show when={props.item.rules.length > 0}>
      <div class={styles.catKv}>
        <For each={props.item.rules}>
          {(rule) => (
            <>
              <span class={styles.catKvKey}>rule</span>
              <span class={styles.catKvValue}>
                {`${rule.metric} ${rule.operator} ${rule.threshold} \u2192 ${rule.action}`}
              </span>
            </>
          )}
        </For>
      </div>
    </Show>
  </>
);

/** Persona card — head + description + optional `goals` kv row. */
const PersonaCard: Component<{ item: CatalogPersona }> = (props) => (
  <>
    <Head item={props.item} />
    <Show when={props.item.desc !== ''}>
      <div class={styles.catDesc}>{props.item.desc}</div>
    </Show>
    <Show when={props.item.goals !== undefined && props.item.goals !== ''}>
      <div class={styles.catKv}>
        <Kv label="goals" value={props.item.goals ?? ''} />
      </div>
    </Show>
  </>
);

/** Return `true` when `item` matches `selected` by `(type, name)`. */
function isSelected(item: CatalogItem, selected: CatalogItem | null): boolean {
  return selected !== null && selected.type === item.type && selected.name === item.name;
}

/**
 * Render one card variant keyed on `item.type`. Using `<Switch>` keeps the
 * discriminant in one place so TypeScript narrows correctly in each branch.
 */
const CardBody: Component<{
  item: CatalogItem;
  onCrossLink: (type: CatalogType, name: string) => void;
}> = (props) => (
  <Switch>
    <Match when={props.item.type === 'role' ? (props.item as CatalogRole) : null}>
      {(role) => <RoleCard item={role()} onCrossLink={props.onCrossLink} />}
    </Match>
    <Match when={props.item.type === 'skill' ? (props.item as CatalogSkill) : null}>
      {(skill) => <SkillCard item={skill()} />}
    </Match>
    <Match when={props.item.type === 'hook' ? (props.item as CatalogHook) : null}>
      {(hook) => <HookCard item={hook()} />}
    </Match>
    <Match when={props.item.type === 'agent' ? (props.item as CatalogAgent) : null}>
      {(agent) => <AgentCard item={agent()} />}
    </Match>
    <Match when={props.item.type === 'constraint' ? (props.item as CatalogConstraint) : null}>
      {(constraint) => <ConstraintCard item={constraint()} />}
    </Match>
    <Match when={props.item.type === 'outcome' ? (props.item as CatalogOutcome) : null}>
      {(outcome) => <OutcomeCard item={outcome()} />}
    </Match>
    <Match when={props.item.type === 'persona' ? (props.item as CatalogPersona) : null}>
      {(persona) => <PersonaCard item={persona()} />}
    </Match>
  </Switch>
);

/** Pluralised "N result(s)" helper used in the toolbar. */
function resultLabel(n: number): string {
  return n === 1 ? '1 result' : `${n} results`;
}

/** Middle column of the Config view. See file header. */
export const CardGrid: Component<CardGridProps> = (props) => {
  return (
    <div class={styles.cardGrid}>
      <div class={styles.toolbar}>
        <label class={styles.search}>
          <span class={styles.searchIcon} aria-hidden="true">⌕</span>
          <input
            type="search"
            class={styles.searchInput}
            placeholder="Search roles, skills, hooks, personas, outcomes…"
            value={props.search}
            onInput={(event) => props.setSearch(event.currentTarget.value)}
          />
        </label>
        <span class={styles.resultCount}>{resultLabel(props.resultCount)}</span>
      </div>
      <div class={styles.body}>
        <Show
          when={props.items.length > 0}
          fallback={<div class={styles.empty}>no items match this filter</div>}
        >
          <div class={styles.catalogGrid}>
            <For each={props.items}>
              {(item) => (
                <button
                  type="button"
                  class={cardClass(isSelected(item, props.selected))}
                  onClick={() => props.onSelect(item)}
                >
                  <CardBody item={item} onCrossLink={props.onCrossLink} />
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};
