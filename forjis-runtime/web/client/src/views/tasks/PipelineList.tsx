/**
 * PipelineList — ordered list of {@link RoleCard}s for the middle column.
 *
 * Receives steps, a role-resource lookup, and the current `now` tick from
 * {@link PipelinePanel}. Reads the selection setter from
 * {@link PipelineSelectionContext} so clicking a card writes the structured
 * `{org, team, role}` identity to the shared signal without prop-drilling.
 * The role-resource index is keyed by bare role name (per `fix-roles-display`
 * `PipelineStep.role` is the bare role only), with the step's `role` field
 * used directly as the map lookup key.
 */

import type { Component } from 'solid-js';
import { For } from 'solid-js';
import type { PipelineStep, RoleIdentity, RoleResource } from '@forjis/shared';
import { RoleCard } from './RoleCard';
import { stepIdentitiesEqual, usePipelineSelection } from './PipelineSelectionContext';
import styles from './PipelineList.module.css';

/** Props for {@link PipelineList}. */
export interface PipelineListProps {
  /** Ordered steps to render. */
  steps: PipelineStep[];
  /**
   * Role-resource index keyed by the bare role name on `step.role`.
   * Empty when `/api/resources` has not resolved or returned null.
   */
  resourcesByRole: Record<string, RoleResource>;
  /** Current epoch-ms used to tick elapsed labels on running cards. */
  now: number;
}

/** Vertical list of role cards. Pure view over the three props. */
export const PipelineList: Component<PipelineListProps> = (props) => {
  const selection = usePipelineSelection();

  const onSelect = (identity: RoleIdentity): void => {
    selection.setSelectedStepIdentity(identity);
  };

  return (
    <ul class={styles.list} role="list">
      <For each={props.steps}>
        {(step) => {
          const resource = props.resourcesByRole[step.role];
          const selected = (): boolean =>
            stepIdentitiesEqual(selection.selectedStepIdentity(), {
              org: step.org,
              team: step.team,
              role: step.role,
            });
          return (
            <li class={styles.item}>
              <RoleCard
                step={step}
                resource={resource}
                selected={selected()}
                now={props.now}
                onSelect={onSelect}
              />
            </li>
          );
        }}
      </For>
    </ul>
  );
};
