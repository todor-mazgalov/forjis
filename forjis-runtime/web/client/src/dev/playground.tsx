/**
 * playground.tsx — Dev-only visual catalog of every design-system primitive.
 *
 * Gated by `import.meta.env.DEV` plus a `?playground=1` query toggle at the
 * App level so production bundles tree-shake this module entirely. See
 * design.md decision D-9 (redesign-003).
 *
 * Each section renders one primitive in every documented variant so the
 * acceptance criterion "playground renders each primitive matching the
 * mockup" is visually verifiable.
 */

import type { Component } from 'solid-js';
import { For, createSignal } from 'solid-js';
import { Panel } from '../components/primitives/Panel';
import { Chip, type ChipTone } from '../components/primitives/Chip';
import { Pill, type PillState } from '../components/primitives/Pill';
import {
  StatusDot,
  type StatusDotState,
  type StatusDotVariant,
} from '../components/primitives/StatusDot';
import { ScoreBar } from '../components/primitives/ScoreBar';
import { SegmentedToggle } from '../components/primitives/SegmentedToggle';
import { Popover } from '../components/primitives/Popover';
import { Clock, Link, Search, Terminal, External, Copy } from '../icons';
import styles from './playground.module.css';

/** All pill states exercised in the playground. */
const PILL_STATES: ReadonlyArray<PillState> = [
  'planned',
  'running',
  'done',
  'skipped',
  'failed',
  'pending',
];

/** All chip tones exercised in the playground. */
const CHIP_TONES: ReadonlyArray<ChipTone> = [
  'neutral',
  'skill',
  'hook',
  'agent',
  'outcome',
  'persona',
  'constraint',
];

/** All StatusDot states exercised in the playground. */
const DOT_STATES: ReadonlyArray<StatusDotState> = [
  'idle',
  'running',
  'done',
  'skipped',
  'failed',
  'queued',
];

/** All StatusDot variants exercised in the playground. */
const DOT_VARIANTS: ReadonlyArray<StatusDotVariant> = ['pulse', 'ring', 'static'];

/** Representative values used by the ScoreBar row. */
const SCORE_VALUES: ReadonlyArray<number> = [0, 25, 50, 75, 100];

/** Playground section exercising Panel variants. */
const PanelSection: Component = () => (
  <section class={styles.section}>
    <h2 class={styles.sectionHeading}>Panel</h2>
    <div class={styles.row}>
      <div class={styles.col}>
        <span class={styles.label}>no header, flush</span>
        <Panel>Body content without header.</Panel>
      </div>
      <div class={styles.col}>
        <span class={styles.label}>no header, padded</span>
        <Panel padded>Body content with padding.</Panel>
      </div>
      <div class={styles.col}>
        <span class={styles.label}>with header</span>
        <Panel header={<span>Header</span>}>Body flush.</Panel>
      </div>
      <div class={styles.col}>
        <span class={styles.label}>with header, padded</span>
        <Panel header={<span>Header</span>} padded>
          Body padded.
        </Panel>
      </div>
    </div>
  </section>
);

/** Playground section exercising Chip tones. */
const ChipSection: Component = () => (
  <section class={styles.section}>
    <h2 class={styles.sectionHeading}>Chip</h2>
    <div class={styles.row}>
      <For each={CHIP_TONES}>
        {(tone) => (
          <div class={styles.col}>
            <span class={styles.label}>{tone}</span>
            <div class={styles.row}>
              <Chip tone={tone} label={tone} />
              <Chip tone={tone} label={tone} icon={<Link size={10} />} />
            </div>
          </div>
        )}
      </For>
    </div>
  </section>
);

/** Playground section exercising Pill states. */
const PillSection: Component = () => (
  <section class={styles.section}>
    <h2 class={styles.sectionHeading}>Pill</h2>
    <div class={styles.row}>
      <For each={PILL_STATES}>
        {(state) => (
          <div class={styles.col}>
            <span class={styles.label}>{state}</span>
            <Pill state={state} />
          </div>
        )}
      </For>
    </div>
  </section>
);

/** Playground section exercising StatusDot matrix (state × variant). */
const StatusDotSection: Component = () => (
  <section class={styles.section}>
    <h2 class={styles.sectionHeading}>StatusDot</h2>
    <div class={styles.matrix}>
      <span class={styles.header}>state</span>
      <For each={DOT_VARIANTS}>{(variant) => <span class={styles.header}>{variant}</span>}</For>
      <For each={DOT_STATES}>
        {(state) => (
          <>
            <span>{state}</span>
            <For each={DOT_VARIANTS}>
              {(variant) => (
                <span>
                  <StatusDot state={state} variant={variant} size={10} />
                </span>
              )}
            </For>
          </>
        )}
      </For>
    </div>
  </section>
);

/** Playground section exercising ScoreBar values and tones. */
const ScoreBarSection: Component = () => (
  <section class={styles.section}>
    <h2 class={styles.sectionHeading}>ScoreBar</h2>
    <div class={styles.col}>
      <span class={styles.label}>accent tone</span>
      <For each={SCORE_VALUES}>
        {(value) => (
          <div class={styles.scoreRow}>
            <span>{value}</span>
            <ScoreBar value={value} />
            <span>%</span>
          </div>
        )}
      </For>
      <span class={styles.label}>skipped tone</span>
      <For each={SCORE_VALUES}>
        {(value) => (
          <div class={styles.scoreRow}>
            <span>{value}</span>
            <ScoreBar value={value} tone="skipped" />
            <span>%</span>
          </div>
        )}
      </For>
    </div>
  </section>
);

/** Playground section exercising SegmentedToggle in controlled mode.
 * Two independent signals drive a 2-option and a 3-option example. */
const SegmentedToggleSection: Component = () => {
  const [twoOption, setTwoOption] = createSignal('list');
  const [threeOption, setThreeOption] = createSignal('all');
  return (
    <section class={styles.section}>
      <h2 class={styles.sectionHeading}>SegmentedToggle</h2>
      <div class={styles.row}>
        <div class={styles.col}>
          <span class={styles.label}>2 options (list / graph)</span>
          <SegmentedToggle
            options={[
              { value: 'list', label: 'List' },
              { value: 'graph', label: 'Graph' },
            ]}
            value={twoOption()}
            onChange={setTwoOption}
          />
          <span class={styles.label}>current: {twoOption()}</span>
        </div>
        <div class={styles.col}>
          <span class={styles.label}>3 options (all / on / off)</span>
          <SegmentedToggle
            options={[
              { value: 'all', label: 'All' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            value={threeOption()}
            onChange={setThreeOption}
          />
          <span class={styles.label}>current: {threeOption()}</span>
        </div>
      </div>
    </section>
  );
};

/** Playground section exercising Popover. */
const PopoverSection: Component = () => (
  <section class={styles.section}>
    <h2 class={styles.sectionHeading}>Popover</h2>
    <div class={styles.row}>
      <Popover
        trigger={<button type="button" class={styles.triggerButton}>Open popover</button>}
      >
        <div class={styles.popContent}>
          <strong>Popover content</strong>
          <span>Click outside or press Esc to close.</span>
        </div>
      </Popover>
    </div>
  </section>
);

/** Playground section exercising every icon at a uniform size. */
const IconSection: Component = () => (
  <section class={styles.section}>
    <h2 class={styles.sectionHeading}>Icons</h2>
    <div class={styles.row}>
      <div class={styles.col}>
        <span class={styles.label}>clock</span>
        <Clock size={16} />
      </div>
      <div class={styles.col}>
        <span class={styles.label}>link</span>
        <Link size={16} />
      </div>
      <div class={styles.col}>
        <span class={styles.label}>search</span>
        <Search size={16} />
      </div>
      <div class={styles.col}>
        <span class={styles.label}>terminal</span>
        <Terminal size={16} />
      </div>
      <div class={styles.col}>
        <span class={styles.label}>external</span>
        <External size={16} />
      </div>
      <div class={styles.col}>
        <span class={styles.label}>copy</span>
        <Copy size={16} />
      </div>
    </div>
  </section>
);

/** Playground root. Renders one section per primitive in a vertical list. */
export const Playground: Component = () => {
  return (
    <div class={styles.root}>
      <PanelSection />
      <ChipSection />
      <PillSection />
      <StatusDotSection />
      <ScoreBarSection />
      <SegmentedToggleSection />
      <PopoverSection />
      <IconSection />
    </div>
  );
};
