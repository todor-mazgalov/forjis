/**
 * PipelineGraph — directed-graph variant of the pipeline column.
 *
 * Renders the same set of steps as {@link PipelineList} but positions each
 * `RoleCard` absolutely inside an SVG-backed container. Layout is computed
 * once per `props.steps` change via `createMemo` + {@link layoutGraph}; the
 * `props.now` tick only drives elapsed-time labels inside each card and does
 * not re-run the depth math.
 *
 * Edges are cubic beziers drawn in an `<svg>` layer behind the cards. An
 * edge receives the active (dashed, flowing) treatment whenever either
 * endpoint's status is `running`. See redesign-007 design D-4 and the
 * documented divergence from the prototype's `done && (running||done)` rule
 * in the proposal.
 *
 * Selection is shared with the list view via `usePipelineSelection()`; the
 * selected node receives the same `selected` treatment from `RoleCard` that
 * the list view renders.
 */

import type { Component } from 'solid-js';
import { For, createMemo } from 'solid-js';
import type { PipelineStep, RoleIdentity, RoleResource } from '@forjis/shared';
import { RoleCard } from './RoleCard';
import { stepIdentitiesEqual, usePipelineSelection } from './PipelineSelectionContext';
import {
  type GraphEdge,
  type GraphLayout,
  type GraphNode,
  NODE_H_HALF,
  NODE_W,
  layoutGraph,
} from './graph-layout';
import styles from './PipelineGraph.module.css';

/** Props for {@link PipelineGraph}. */
export interface PipelineGraphProps {
  /** Ordered steps to render. Same shape {@link PipelineList} consumes. */
  steps: PipelineStep[];
  /**
   * Role-resource index keyed by the trailing role name from `step.role`.
   * Same shape {@link PipelineList} consumes.
   */
  resourcesByRole: Record<string, RoleResource>;
  /** Current epoch-ms used to tick elapsed labels on running cards. */
  now: number;
}

/**
 * Build the cubic-bezier `d` attribute connecting two positioned nodes.
 * Endpoint formulas follow design D-4: source-right-centre to target-left-
 * centre with a horizontal-midpoint control handle.
 */
function bezierPath(source: GraphNode, target: GraphNode): string {
  const x1 = source.x + NODE_W;
  const y1 = source.y + NODE_H_HALF;
  const x2 = target.x;
  const y2 = target.y + NODE_H_HALF;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/** Directed-graph renderer for the middle column's pipeline plan. */
export const PipelineGraph: Component<PipelineGraphProps> = (props) => {
  const selection = usePipelineSelection();

  const layout = createMemo<GraphLayout>(() => layoutGraph(props.steps));

  const stepsById = createMemo<Map<string, PipelineStep>>(
    () => new Map(props.steps.map((s) => [s.role, s])),
  );

  const nodesById = createMemo<Map<string, GraphNode>>(
    () => new Map(layout().nodes.map((n) => [n.id, n])),
  );

  // Active-edge rule per redesign-007 proposal: either endpoint running. This
  // is a documented divergence from the prototype's `done && (running||done)`.
  const isEdgeActive = (edge: GraphEdge): boolean => {
    const byId = stepsById();
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    return from?.status === 'running' || to?.status === 'running';
  };

  const edgeClass = (edge: GraphEdge): string => {
    const parts = [styles.edge];
    if (isEdgeActive(edge)) parts.push(styles.edgeActive);
    return parts.join(' ');
  };

  const onSelect = (identity: RoleIdentity): void => {
    selection.setSelectedStepIdentity(identity);
  };

  return (
    <div
      class={styles.container}
      style={{ width: `${layout().bounds.w}px`, height: `${layout().bounds.h}px` }}
      role="group"
      aria-label="Pipeline graph"
    >
      <svg
        class={styles.svg}
        aria-hidden="true"
        width={layout().bounds.w}
        height={layout().bounds.h}
      >
        <For each={layout().edges}>
          {(edge) => {
            const source = nodesById().get(edge.fromId);
            const target = nodesById().get(edge.toId);
            if (source === undefined || target === undefined) return null;
            return <path class={edgeClass(edge)} d={bezierPath(source, target)} />;
          }}
        </For>
      </svg>
      <For each={layout().nodes}>
        {(node) => {
          const step = stepsById().get(node.id);
          if (step === undefined) return null;
          const resource = props.resourcesByRole[step.role];
          const selected = (): boolean =>
            stepIdentitiesEqual(selection.selectedStepIdentity(), {
              org: step.org,
              team: step.team,
              role: step.role,
            });
          return (
            <div
              class={styles.node}
              style={{ left: `${node.x}px`, top: `${node.y}px` }}
            >
              <RoleCard
                step={step}
                resource={resource}
                selected={selected()}
                now={props.now}
                onSelect={onSelect}
              />
            </div>
          );
        }}
      </For>
    </div>
  );
};
