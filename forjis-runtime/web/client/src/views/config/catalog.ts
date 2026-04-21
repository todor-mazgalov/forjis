/**
 * catalog.ts — pure normaliser + shared types for the Config view.
 *
 * Flattens the three backing DTOs (`ResourcesResponse`, `ConfigResponse`) into
 * a discriminated `CatalogItem` union so the sidebar filter, card grid, and
 * detail drawer all read from one uniform shape. No DOM access, no reactive
 * state — callers wrap the builder in a `createMemo`. See design.md § D-1
 * (empty constraint/persona chip rows), § D-2 (origin derivation), and § D-4
 * (plugin-count synthesis).
 */

import type {
  ConfigOutcomeRule,
  ConfigResponse,
  ResourcesResponse,
} from '@forjis/shared';

/** Seven catalog entry kinds. Used as the discriminant on {@link CatalogItem}. */
export type CatalogType =
  | 'role'
  | 'skill'
  | 'hook'
  | 'agent'
  | 'constraint'
  | 'outcome'
  | 'persona';

/** Constraint classification. Drives the `KindPill` variant on card/drawer headers. */
export type ConstraintKind = 'mandatory' | 'optional' | 'pillar';

/** Fields shared by every {@link CatalogItem} variant. */
export interface CatalogItemBase {
  /** Stable dedup key: `${type}:${name}`. */
  key: string;
  /** Discriminant — selects the concrete variant. */
  type: CatalogType;
  /** Display id (role name / skill name / etc.). */
  name: string;
  /** Derived per D-2. */
  origin: string;
  /** Short description from front matter, or empty. */
  desc: string;
  /** Plugin-root-relative `.md` paths associated with this item. */
  files: string[];
}

/** Role entry — carries attached-resource paths for the chip rows. */
export interface CatalogRole extends CatalogItemBase {
  type: 'role';
  agent: string;
  agentPath: string;
  skills: string[];
  skillPaths: string[];
  hookPaths: string[];
  constraintPaths: string[];
  outcomePaths: string[];
  personaPaths: string[];
  expertise: string;
}

/** Skill entry — a registry skill. */
export interface CatalogSkill extends CatalogItemBase { type: 'skill'; }
/** Hook entry — a registry hook. */
export interface CatalogHook extends CatalogItemBase { type: 'hook'; }
/** Agent entry — a registry agent. */
export interface CatalogAgent extends CatalogItemBase { type: 'agent'; }

/** Constraint entry — fanned out from `ConfigResponse.constraints`. */
export interface CatalogConstraint extends CatalogItemBase {
  type: 'constraint';
  kind: ConstraintKind;
}

/** Outcome group entry — the rules back the inline outcome-card summary. */
export interface CatalogOutcome extends CatalogItemBase {
  type: 'outcome';
  rules: ConfigOutcomeRule[];
}

/** Persona entry — optional `goals` string when supplied by the DTO. */
export interface CatalogPersona extends CatalogItemBase {
  type: 'persona';
  goals?: string;
}

/** Union of every catalog variant. Discriminated by {@link CatalogItemBase.type}. */
export type CatalogItem =
  | CatalogRole
  | CatalogSkill
  | CatalogHook
  | CatalogAgent
  | CatalogConstraint
  | CatalogOutcome
  | CatalogPersona;

/**
 * Return the last `/` or `\` segment of `path` stripped of a trailing `.md`.
 * Mirrors `RoleConfigTab.basename` but kept local so feature folders do not
 * cross-import.
 */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? path;
  return last.replace(/\.md$/i, '');
}

/**
 * Return the first `/` segment of `path`, or `'project'` when the path has no
 * separator or is empty. Used to derive an `origin` for constraint and
 * persona entries that do not carry a `source` on the wire (D-2).
 */
export function deriveOrigin(path: string): string {
  if (!path) return 'project';
  const slash = path.indexOf('/');
  if (slash <= 0) return 'project';
  return path.slice(0, slash);
}

/**
 * Resolve the `expertise` string for a role by walking the richer
 * `ConfigResponse` tree. Returns `''` when no match is found. Kept private so
 * {@link buildCatalog} can stay a straight-line flatten.
 */
function expertiseForRole(
  config: ConfigResponse | null,
  roleName: string,
): string {
  if (!config) return '';
  for (const org of config.orgs.orgs) {
    for (const team of org.teams) {
      const role = team.roles.find((entry) => entry.name === roleName);
      if (role) return role.expertise ?? '';
    }
  }
  return '';
}

/**
 * Push a value into a Map keyed by `${type}:${name}` so downstream iteration
 * stays ordered. Kept as a tiny helper so `buildCatalog` reads top-to-bottom.
 */
function addItem(map: Map<string, CatalogItem>, item: CatalogItem): void {
  if (!map.has(item.key)) {
    map.set(item.key, item);
  }
}

/** Derive a stable key `${type}:${name}` used for dedup and `<For>` keys. */
function keyFor(type: CatalogType, name: string): string {
  return `${type}:${name}`;
}

/**
 * Extend a Map with every `CatalogRole` produced from the
 * `resources.orgs → teams → roles` tree. Each role's expertise is resolved
 * against the richer `config` payload.
 */
function collectRoles(
  map: Map<string, CatalogItem>,
  resources: ResourcesResponse | null,
  config: ConfigResponse | null,
): void {
  if (!resources) return;
  for (const org of resources.orgs) {
    for (const team of org.teams) {
      for (const role of team.roles) {
        addItem(map, {
          key: keyFor('role', role.name),
          type: 'role',
          name: role.name,
          origin: org.source,
          desc: '',
          files: role.agentPath ? [role.agentPath] : [],
          agent: role.agent,
          agentPath: role.agentPath,
          skills: role.skills,
          skillPaths: role.skillPaths,
          hookPaths: role.hookPaths,
          constraintPaths: role.constraintPaths,
          outcomePaths: role.outcomePaths,
          personaPaths: role.personaPaths,
          expertise: expertiseForRole(config, role.name),
        });
      }
    }
  }
}

/**
 * Extend a Map with the flat `agents` / `skills` / `hooks` entries from
 * `ResourcesResponse`. Each DTO entry carries a `source` used as the origin.
 */
function collectFlatResources(
  map: Map<string, CatalogItem>,
  resources: ResourcesResponse | null,
): void {
  if (!resources) return;
  for (const agent of resources.agents) {
    addItem(map, {
      key: keyFor('agent', agent.name),
      type: 'agent',
      name: agent.name,
      origin: agent.source,
      desc: '',
      files: [],
    });
  }
  for (const skill of resources.skills) {
    addItem(map, {
      key: keyFor('skill', skill.name),
      type: 'skill',
      name: skill.name,
      origin: skill.source,
      desc: '',
      files: [],
    });
  }
  for (const hook of resources.hooks) {
    addItem(map, {
      key: keyFor('hook', hook.name),
      type: 'hook',
      name: hook.name,
      origin: hook.source,
      desc: '',
      files: [],
    });
  }
}

/**
 * Extend a Map with one `mandatory` entry, one `optional` entry, and one
 * `pillar` entry per `constraints.pillars[i]`. Pillar origin derives from the
 * first path segment (D-2). The `mandatory`/`optional` entries inherit the
 * raw text as their description.
 */
function collectConstraints(
  map: Map<string, CatalogItem>,
  config: ConfigResponse | null,
): void {
  if (!config) return;
  const { constraints } = config;
  addItem(map, {
    key: keyFor('constraint', 'mandatory'),
    type: 'constraint',
    name: 'mandatory',
    origin: 'project',
    desc: constraints.mandatory,
    files: [],
    kind: 'mandatory',
  });
  addItem(map, {
    key: keyFor('constraint', 'optional'),
    type: 'constraint',
    name: 'optional',
    origin: 'project',
    desc: constraints.optional,
    files: [],
    kind: 'optional',
  });
  for (const pillar of constraints.pillars) {
    const name = basename(pillar.path);
    addItem(map, {
      key: keyFor('constraint', name),
      type: 'constraint',
      name,
      origin: deriveOrigin(pillar.path),
      desc: '',
      files: [pillar.path],
      kind: 'pillar',
    });
  }
}

/**
 * Extend a Map with one `CatalogPersona` per `config.personas.personas[i]`
 * and one `CatalogOutcome` per `config.outcomes.outcomes[i]`.
 */
function collectPersonasAndOutcomes(
  map: Map<string, CatalogItem>,
  config: ConfigResponse | null,
): void {
  if (!config) return;
  for (const persona of config.personas.personas) {
    addItem(map, {
      key: keyFor('persona', persona.name),
      type: 'persona',
      name: persona.name,
      origin: 'project',
      desc: persona.description,
      files: [],
    });
  }
  for (const outcome of config.outcomes.outcomes) {
    addItem(map, {
      key: keyFor('outcome', outcome.name),
      type: 'outcome',
      name: outcome.name,
      origin: 'project',
      desc: '',
      files: [],
      rules: outcome.rules,
    });
  }
}

/**
 * Flatten `resources` + `config` into a single deduped `CatalogItem[]`. Pure
 * function: given the same inputs it always returns the same output, with no
 * DOM or reactive access. Returns `[]` when both inputs are `null`. Dedup
 * keys are `${type}:${name}`.
 */
export function buildCatalog(
  resources: ResourcesResponse | null,
  config: ConfigResponse | null,
): CatalogItem[] {
  const map = new Map<string, CatalogItem>();
  collectRoles(map, resources, config);
  collectFlatResources(map, resources);
  collectConstraints(map, config);
  collectPersonasAndOutcomes(map, config);
  return Array.from(map.values());
}

/** Tally of items by type plus a grand total. Shape matches the sidebar row. */
export type TypeCountMap = Record<CatalogType, number> & { all: number };

/**
 * Count items by their `type` and return a map keyed by every {@link CatalogType}
 * plus an `all` grand total. Counts are pre-search so the sidebar numbers stay
 * stable as the user types (D-9).
 */
export function typeCounts(items: CatalogItem[]): TypeCountMap {
  const counts: TypeCountMap = {
    all: items.length,
    role: 0,
    skill: 0,
    hook: 0,
    agent: 0,
    constraint: 0,
    outcome: 0,
    persona: 0,
  };
  for (const item of items) {
    counts[item.type] += 1;
  }
  return counts;
}

/**
 * Count items by their `origin` string. Returned map keys every plugin name
 * plus the synthetic `'project'` key when any item's origin is `'project'`.
 */
export function pluginCounts(items: CatalogItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.origin, (counts.get(item.origin) ?? 0) + 1);
  }
  return counts;
}

/**
 * Find the first item matching `(type, name)` or return `null`. Used by the
 * cross-link handler (chip click on a role card / drawer) to resolve the
 * target `CatalogItem` before switching the sidebar filter and selection.
 */
export function selectByKey(
  items: CatalogItem[],
  type: CatalogType,
  name: string,
): CatalogItem | null {
  return items.find((it) => it.type === type && it.name === name) ?? null;
}

/**
 * Return a new Set with `name` toggled: present → removed, absent → added.
 * Always produces a fresh instance so Solid's default identity equality
 * triggers subscribers.
 */
export function togglePluginSet(prev: Set<string>, name: string): Set<string> {
  const next = new Set(prev);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  return next;
}
