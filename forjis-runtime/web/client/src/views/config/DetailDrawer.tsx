/**
 * DetailDrawer — absolute-positioned slide-in that shows the full definition
 * of the selected catalog item.
 *
 * The overlay sibling lives at `inset: 0` inside the parent's `.main` column
 * so the sidebar remains reachable while the drawer is open (design.md
 * § D-7). Clicking the overlay or the close button clears the selection.
 * File-row clicks route through `openFile` on the app-global file-viewer
 * store (redesign-010), so the same File Viewer modal that the Tasks view
 * uses opens here.
 */

import type { Component, JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import { openFile } from '../../components/fileViewerStore';
import type {
  CatalogConstraint,
  CatalogItem,
  CatalogRole,
  CatalogType,
} from './catalog';
import { basename } from './catalog';
import { AttachedChipRow } from './AttachedChipRow';
import { KindPill } from './KindPill';
import styles from './DetailDrawer.module.css';

/** Em-dash rendered for missing optional fields. */
const EM_DASH = '\u2014';

/** Props for {@link DetailDrawer}. */
export interface DetailDrawerProps {
  /** The currently selected catalog item. */
  item: CatalogItem;
  /** Called when the overlay or the close button is clicked. */
  onClose: () => void;
  /** Cross-link handler — drawer chip click → open that item's drawer. */
  onCrossLink: (type: CatalogType, name: string) => void;
}

/** Map a type to the ASCII letter + CSS module class used for its icon. */
const TYPE_ICON: Record<CatalogType, { label: string; className: string }> = {
  role: { label: 'R', className: 'catIconRole' },
  skill: { label: 'S', className: 'catIconSkill' },
  hook: { label: 'H', className: 'catIconHook' },
  agent: { label: 'A', className: 'catIconAgent' },
  constraint: { label: 'C', className: 'catIconConstraint' },
  outcome: { label: 'O', className: 'catIconOutcome' },
  persona: { label: 'P', className: 'catIconPersona' },
};

/** Human-readable type labels used in the drawer meta line. */
const TYPE_LABEL: Record<CatalogType, string> = {
  role: 'Role',
  skill: 'Skill',
  hook: 'Hook',
  agent: 'Agent',
  constraint: 'Constraint',
  outcome: 'Outcome',
  persona: 'Persona',
};

/** Drawer head — icon + name + origin + close button. */
const DrawerHead: Component<{ item: CatalogItem; onClose: () => void }> = (props) => {
  const icon = (): { label: string; className: string } => TYPE_ICON[props.item.type];
  return (
    <div class={styles.drawerHead}>
      <span class={`${styles.catIcon} ${styles[icon().className]}`}>{icon().label}</span>
      <div class={styles.drawerHeadText}>
        <div class={styles.drawerName}>{props.item.name}</div>
        <div class={styles.drawerMeta}>
          <span>{TYPE_LABEL[props.item.type]}</span>
          <span> · </span>
          <span>{props.item.origin}</span>
          <Show when={props.item.type === 'constraint' ? (props.item as CatalogConstraint) : null}>
            {(constraint) => (
              <>
                <span> · </span>
                <KindPill kind={constraint().kind} />
              </>
            )}
          </Show>
        </div>
      </div>
      <button
        type="button"
        class={styles.closeBtn}
        aria-label="Close drawer"
        onClick={() => props.onClose()}
      >
        &times;
      </button>
    </div>
  );
};

/**
 * Role-specific attached section — one chip row per non-empty attached
 * array. Reuses {@link AttachedChipRow} with the drawer's cross-link handler.
 */
const RoleAttached: Component<{
  role: CatalogRole;
  onCrossLink: (type: CatalogType, name: string) => void;
}> = (props) => {
  const agentNames = (): string[] => (props.role.agent ? [props.role.agent] : []);
  const hookNames = (): string[] => props.role.hookPaths.map(basename);
  const constraintNames = (): string[] => props.role.constraintPaths.map(basename);
  const outcomeNames = (): string[] => props.role.outcomePaths.map(basename);
  const personaNames = (): string[] => props.role.personaPaths.map(basename);
  return (
    <>
      <div class={styles.sectionTitle}>Attached</div>
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
        names={props.role.skills}
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
    </>
  );
};

/** Render one k/v pair inside the metadata table. */
const MetaRow: Component<{ label: string; value: string }> = (props) => (
  <>
    <span class={styles.kvKey}>{props.label}</span>
    <span class={styles.kvValue}>{props.value}</span>
  </>
);

/**
 * Metadata table — the common `type` + `origin` rows. Constraint items also
 * render their `kind`. Other per-type fields (role `stage`, outcome
 * `default action`, persona `model`/`tools`) are intentionally omitted until
 * the API actually populates them (redesign-019).
 */
const MetadataTable: Component<{ item: CatalogItem }> = (props) => (
  <div class={styles.kvTable}>
    <MetaRow label="type" value={props.item.type} />
    <MetaRow label="origin" value={props.item.origin} />
    <Show when={props.item.type === 'constraint' ? (props.item as CatalogConstraint) : null}>
      {(constraint) => <MetaRow label="kind" value={constraint().kind} />}
    </Show>
  </div>
);

/**
 * Files section — one button per `.md` path on the item. Clicks open the
 * File Viewer modal via `openFile(path, 'plugin')`.
 */
const FilesSection: Component<{ files: string[] }> = (props) => (
  <Show when={props.files.length > 0}>
    <div class={styles.sectionTitle}>Files</div>
    <div class={styles.fileList}>
      <For each={props.files}>
        {(path) => (
          <button
            type="button"
            class={styles.fileBtn}
            onClick={() => openFile(path, 'plugin')}
          >
            <span class={styles.filePath}>{path}</span>
            <span class={styles.fileExt}>MD</span>
          </button>
        )}
      </For>
    </div>
  </Show>
);

/** Body sections shown for role items only. */
const RoleBody: Component<{
  role: CatalogRole;
  onCrossLink: (type: CatalogType, name: string) => void;
}> = (props) => (
  <>
    <RoleAttached role={props.role} onCrossLink={props.onCrossLink} />
    <Show when={props.role.expertise !== ''}>
      <div class={styles.sectionTitle}>Expertise</div>
      <pre class={styles.codeBlock}>{props.role.expertise}</pre>
    </Show>
  </>
);

/** Render the drawer body. Description + per-type sections + metadata + files.
 *  Role drawers intentionally omit the Files section (redesign-019); non-role
 *  types keep theirs. */
const DrawerBody: Component<{
  item: CatalogItem;
  onCrossLink: (type: CatalogType, name: string) => void;
}> = (props) => {
  const description = (): string => (props.item.desc === '' ? EM_DASH : props.item.desc);
  return (
    <div class={styles.drawerBody}>
      <div class={styles.sectionTitle}>Description</div>
      <div class={styles.descriptionBlock}>{description()}</div>
      <Show when={props.item.type === 'role' ? (props.item as CatalogRole) : null}>
        {(role) => <RoleBody role={role()} onCrossLink={props.onCrossLink} />}
      </Show>
      <div class={styles.sectionTitle}>Metadata</div>
      <MetadataTable item={props.item} />
      <Show when={props.item.type !== 'role'}>
        <FilesSection files={props.item.files} />
      </Show>
    </div>
  );
};

/**
 * Absolute-positioned drawer + overlay. Parent must be `position: relative`
 * (ConfigView's `.main` column is).
 */
export const DetailDrawer: Component<DetailDrawerProps> = (props) => {
  const onOverlayClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = () => props.onClose();
  return (
    <>
      <div
        class={styles.overlay}
        role="presentation"
        onClick={onOverlayClick}
      />
      <aside class={styles.drawer} aria-label="Catalog item detail">
        <DrawerHead item={props.item} onClose={props.onClose} />
        <DrawerBody item={props.item} onCrossLink={props.onCrossLink} />
      </aside>
    </>
  );
};
