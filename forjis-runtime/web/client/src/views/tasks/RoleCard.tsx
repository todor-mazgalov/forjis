/**
 * RoleCard — single row inside the pipeline list.
 *
 * Composes `StatusDot`, `ScoreBar`, `Popover`, and `Chip` primitives to render
 * one `PipelineStep`. See design.md decisions D-2 (props), D-6 (CSS), D-7
 * (icon mapping), D-8 (a11y) of redesign-006 for the rationale behind each
 * affordance. Visual reference: `.role-node` in
 * `tasks/_redesign-assets/styles.css`.
 *
 * Status translation rules:
 * - `running` → `StatusDot state='running'` (auto-pulse).
 * - `done`    → `StatusDot state='done'` (solid).
 * - `planned` → `StatusDot state='queued'` (idle).
 * - Skipped (either `status === 'skipped'` or `decision === 'skipped'`) →
 *   `StatusDot state='skipped'`, dashed card border, reduced opacity, and
 *   strike-through on the role name.
 *
 * Orchestrator variant (redesign-016 §2): when `step.kind === 'orchestrator'`
 * the card renders a reduced form — status dot + display name + elapsed only.
 * The score row, justification row, and chip row are suppressed because the
 * synthetic step has no score, justification, or attached resources.
 *
 * A11y / DOM structure (iteration 2 restructure — see review.md §Required
 * fixes): the card root is a plain `<div>` that owns the visual border and
 * skipped/selected treatment. Inside the div are three *sibling* interactive
 * regions:
 *   1. `<button class={selectButton}>` covering header + score rows — this is
 *      the primary activation target for selecting the step.
 *   2. A justification row containing the real `Popover` primitive. Because
 *      the popover trigger is no longer a descendant of the select button, no
 *      `stopPropagation()` is needed: the popover's own click handler fires
 *      and opens the body.
 *   3. A chip row containing real `<button type="button">` children — one per
 *      attached resource. Siblings of the select button, so keyboard and
 *      screen-reader semantics are sound (no nested interactive elements).
 */

import type { Component, JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import type { PipelineStep, RoleIdentity, RoleResource } from '@forjis/shared';
import { Chip, type ChipTone } from '../../components/primitives/Chip';
import { Popover } from '../../components/primitives/Popover';
import { ScoreBar } from '../../components/primitives/ScoreBar';
import { StatusDot, type StatusDotState } from '../../components/primitives/StatusDot';
import { File } from '../../icons/File';
import { Link } from '../../icons/Link';
import { Terminal } from '../../icons/Terminal';
import { openFile } from '../../components/fileViewerStore';
import { formatElapsed } from './time';
import { RoleLabel } from './RoleLabel';
import styles from './RoleCard.module.css';

/** Props for {@link RoleCard}. */
export interface RoleCardProps {
  /** The step to render. */
  step: PipelineStep;
  /** The matching `RoleResource`, or `undefined` if the lookup failed. */
  resource: RoleResource | undefined;
  /** Whether this card is currently selected. */
  selected: boolean;
  /** Current epoch-ms used to tick the elapsed label for running steps. */
  now: number;
  /** Fired when the user clicks the card body. The argument is the structured
   *  role identity of the step so the selection context can key on a unique
   *  `{org, team, role}` triple (the bare `role` field alone is not unique
   *  across teams per `fix-roles-display`). */
  onSelect: (identity: RoleIdentity) => void;
}

/**
 * Return the basename of a plugin-root-relative path (last segment after the
 * final forward slash). Exported for testability. Does not import Node's
 * `path` — the client is browser-only.
 */
function basename(pathString: string): string {
  const idx = pathString.lastIndexOf('/');
  if (idx < 0) return pathString;
  return pathString.slice(idx + 1);
}

/**
 * Translate a `PipelineStep.status` to a `StatusDotState`. `planned` maps to
 * `queued` to share the idle visual language with the task rail.
 */
function toDotState(status: PipelineStep['status']): StatusDotState {
  if (status === 'running' || status === 'done' || status === 'skipped') return status;
  return 'queued';
}

/**
 * Shape of a single chip entry computed from a `RoleResource`. Kept small and
 * explicit so the render loop is straightforward.
 */
interface ResourceChipEntry {
  /** Chip tone — selects semantic colour. */
  tone: ChipTone;
  /** Optional leading icon; absent for outcome/persona/constraint per D-7. */
  icon: JSX.Element | undefined;
  /** Chip label (basename of the path). */
  label: string;
  /** Full plugin-root-relative path. Carried as `title` and passed to `openFile`. */
  path: string;
}

/** Icon size used by all chip leading icons. Mono-aligned with the chip text. */
const CHIP_ICON_SIZE = 11;

/**
 * Build the full ordered chip list from a `RoleResource`. Order follows the
 * reference prototype's AttachedSection: agent → skills → hooks → outcomes →
 * personas → constraints. Icons are supplied only for types with a clean
 * visual match (see D-7); others render without one.
 */
function buildResourceChips(resource: RoleResource | undefined): ResourceChipEntry[] {
  if (!resource) return [];
  const chips: ResourceChipEntry[] = [];
  if (resource.agentPath) {
    chips.push({
      tone: 'agent',
      icon: <Terminal size={CHIP_ICON_SIZE} />,
      label: basename(resource.agentPath),
      path: resource.agentPath,
    });
  }
  for (const skillPath of resource.skillPaths) {
    chips.push({
      tone: 'skill',
      icon: <File size={CHIP_ICON_SIZE} />,
      label: basename(skillPath),
      path: skillPath,
    });
  }
  for (const hookPath of resource.hookPaths) {
    chips.push({
      tone: 'hook',
      icon: <Link size={CHIP_ICON_SIZE} />,
      label: basename(hookPath),
      path: hookPath,
    });
  }
  for (const outcomePath of resource.outcomePaths) {
    chips.push({
      tone: 'outcome',
      icon: undefined,
      label: basename(outcomePath),
      path: outcomePath,
    });
  }
  for (const personaPath of resource.personaPaths) {
    chips.push({
      tone: 'persona',
      icon: undefined,
      label: basename(personaPath),
      path: personaPath,
    });
  }
  for (const constraintPath of resource.constraintPaths) {
    chips.push({
      tone: 'constraint',
      icon: undefined,
      label: basename(constraintPath),
      path: constraintPath,
    });
  }
  return chips;
}

/**
 * Capitalised display label used for the orchestrator pseudo-step in the
 * pipeline list + graph. The underlying `step.role` value stays the lower
 * case literal `'orchestrator'` so the SSE filter matches the event stream.
 */
const ORCHESTRATOR_DISPLAY_NAME = 'Orchestrator';

/**
 * Single selectable pipeline step. The card root is a `<div>`; the primary
 * activation target is a `<button class={selectButton}>` sibling of the
 * justification-popover trigger and the chip buttons, so no interactive
 * descendants live inside another button (valid HTML, clean a11y).
 */
export const RoleCard: Component<RoleCardProps> = (props) => {
  const isOrchestrator = (): boolean => props.step.kind === 'orchestrator';

  const isUnresolved = (): boolean => props.step.kind === 'unresolved';

  const isSkipped = (): boolean =>
    props.step.status === 'skipped' || props.step.decision === 'skipped';

  const rootClass = (): string => {
    const parts = [styles.card];
    if (props.selected) parts.push(styles.cardSelected);
    if (isSkipped()) parts.push(styles.cardSkipped);
    if (isUnresolved()) parts.push(styles.cardUnresolved);
    return parts.join(' ');
  };

  const nameClass = (): string =>
    isSkipped() ? `${styles.name} ${styles.nameStruck}` : styles.name;

  const dotState = (): StatusDotState =>
    isSkipped() ? 'skipped' : toDotState(props.step.status);

  const elapsed = (): string =>
    formatElapsed(props.step.startedAt ?? null, props.step.completedAt ?? null, props.now);

  const score = (): number => props.step.score ?? 0;

  const scoreTone = (): 'accent' | 'skipped' => (isSkipped() ? 'skipped' : 'accent');

  const justification = (): string | null => {
    if (isOrchestrator()) return null;
    const text = props.step.justification;
    if (!text) return null;
    return text;
  };

  const chips = (): ResourceChipEntry[] => {
    if (isOrchestrator()) return [];
    return buildResourceChips(props.resource);
  };

  const displayName = (): string =>
    isOrchestrator() ? ORCHESTRATOR_DISPLAY_NAME : props.step.role;

  /**
   * Native-tooltip title for the role label. Uses `<role> @ <team>` for
   * role steps so the tooltip matches the visible two-span rendering;
   * orchestrator steps keep the plain display name (no team qualifier).
   */
  const titleText = (): string =>
    isOrchestrator()
      ? displayName()
      : `${props.step.role} @ ${props.step.team}`;

  const onSelectClick = (): void =>
    props.onSelect({
      org: props.step.org,
      team: props.step.team,
      role: props.step.role,
    });

  return (
    <div class={rootClass()} data-role-id={props.step.role}>
      <button
        type="button"
        class={styles.selectButton}
        aria-pressed={props.selected}
        aria-label={`Select step ${displayName()}`}
        onClick={onSelectClick}
      >
        <div class={styles.header}>
          <StatusDot
            state={dotState()}
            variant={props.step.status === 'running' ? 'ring' : 'static'}
            size={8}
          />
          <span class={nameClass()} title={titleText()}>
            <Show
              when={!isOrchestrator()}
              fallback={ORCHESTRATOR_DISPLAY_NAME}
            >
              <RoleLabel role={props.step.role} team={props.step.team} />
            </Show>
          </span>
          <Show when={props.step.warning !== undefined}>
            <span
              class={styles.warningBadge}
              title={props.step.warning}
              aria-label={`Warning: ${props.step.warning}`}
              role="img"
            >
              ⚠
            </span>
          </Show>
          <span class={styles.elapsed} aria-label={`elapsed ${elapsed()}`}>
            {elapsed()}
          </span>
        </div>
        <Show when={!isOrchestrator()}>
          <div class={styles.scoreRow}>
            <ScoreBar value={score()} tone={scoreTone()} />
            <span class={styles.scoreValue}>{score()}</span>
          </div>
        </Show>
      </button>
      <Show when={justification() !== null}>
        <div class={styles.justifyRow}>
          <Popover
            placement="bottom-start"
            trigger={
              <span class={styles.justifyLine} title={justification() ?? ''}>
                {justification()}
              </span>
            }
          >
            <div class={styles.justifyBody}>{justification()}</div>
          </Popover>
        </div>
      </Show>
      <Show when={chips().length > 0}>
        <div class={styles.chips}>
          <For each={chips()}>
            {(entry) => (
              <button
                type="button"
                class={styles.chipButton}
                title={entry.path}
                aria-label={entry.label}
                onClick={() => openFile(entry.path, 'plugin')}
              >
                <Chip tone={entry.tone} icon={entry.icon} label={entry.label} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
