/**
 * graph-layout — pure layout module for the pipeline graph view.
 *
 * Takes a flat `PipelineStep[]` and returns absolute-positioned `nodes`,
 * `edges`, and `bounds`. Depth (x-column) is the longest path from any root,
 * computed recursively with memoisation. Within a depth, nodes are ordered
 * alphabetically by `role` for a stable y-axis. The fallback path (when
 * `deps` is missing or empty for every step) lays nodes out in a single
 * column.
 *
 * Orchestrator root (redesign-016 §2): when the input contains a synthetic
 * orchestrator step (`kind === 'orchestrator'`), every other node with no
 * declared `deps` receives an implicit edge from `orchestrator → role`. The
 * orchestrator itself stays at depth 0 with no incoming edges. Nodes that
 * already carry explicit `deps` are left untouched.
 *
 * Cycle safety: the recursive resolver tracks an in-progress set; any node
 * encountered while still being resolved is treated as depth 0 (so the cycle
 * unwinds without a stack overflow).
 *
 * Unknown dep-target ids (entries in `deps` pointing at steps not present in
 * the input) are silently dropped during edge emission.
 *
 * Pure module: no Solid imports, no side effects. See redesign-007 design D-2
 * and D-3 for the rationale.
 */

import type { PipelineStep } from '@forjis/shared';

/**
 * Role id of the synthetic orchestrator step. Centralised so the implicit-
 * edge injection and the plan-writer's step creation stay in sync.
 */
const ORCHESTRATOR_ROLE_ID = 'orchestrator';

/** Node width in px. Matches `.node { width: 200px }` in the CSS module. */
export const NODE_W = 200;
/** Node height in px. Approximate RoleCard height used for edge geometry. */
export const NODE_H = 70;
/** Half of {@link NODE_H}, exposed for the SVG bezier endpoints. */
export const NODE_H_HALF = NODE_H / 2;

/** x-stride between depth columns, in px. */
const COL_W = 220;
/** y-stride between nodes within a single depth column, in px. */
const ROW_H = 105;
/** Top/left margin (and right/bottom padding) around the laid-out graph. */
const MARGIN = 40;

/** A single positioned node in the computed graph layout. */
export interface GraphNode {
  /** The step's `role` id — used as both DOM key and selection id. */
  id: string;
  /** Absolute pixel x of the node's top-left corner inside the graph container. */
  x: number;
  /** Absolute pixel y of the node's top-left corner inside the graph container. */
  y: number;
}

/** A directed edge between two computed nodes. */
export interface GraphEdge {
  /** Source node id (the dep). */
  fromId: string;
  /** Target node id (the dependent — the node whose `deps` array contained `fromId`). */
  toId: string;
}

/** The bounding box (inclusive of margins) of the laid-out graph. */
export interface GraphBounds {
  /** Total width in px. */
  w: number;
  /** Total height in px. */
  h: number;
}

/** Result of {@link layoutGraph}. */
export interface GraphLayout {
  /** Positioned nodes, one per input step. */
  nodes: GraphNode[];
  /** Directed edges between known nodes. Unknown dep targets are dropped. */
  edges: GraphEdge[];
  /** Bounding box sized to fit every node plus margin. */
  bounds: GraphBounds;
}

/**
 * Build a memoised `level(id)` resolver that returns the longest-path depth
 * from any root to `id`. Guards against cycles via an in-progress set: any
 * node encountered while still being resolved is assigned depth 0 and the
 * recursion unwinds. Treats missing or empty `deps` as "root" (depth 0).
 */
function buildLevelResolver(
  stepsById: Map<string, PipelineStep>,
): (id: string) => number {
  const levels = new Map<string, number>();
  const resolving = new Set<string>();
  const onCycle = new Set<string>();
  const level = (id: string): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (resolving.has(id)) {
      for (const inFlight of resolving) onCycle.add(inFlight);
      return 0;
    }
    resolving.add(id);
    const step = stepsById.get(id);
    const deps = step?.deps ?? [];
    let result = 0;
    if (deps.length > 0) {
      let best = 0;
      for (const dep of deps) {
        const depLevel = level(dep);
        if (depLevel + 1 > best) best = depLevel + 1;
      }
      result = best;
    }
    if (onCycle.has(id)) result = 0;
    levels.set(id, result);
    resolving.delete(id);
    return result;
  };
  return level;
}

/**
 * Group step ids by their computed depth, sort each group alphabetically by
 * role, and assign `(x, y)` coordinates per the named constants.
 */
function positionNodes(
  steps: ReadonlyArray<PipelineStep>,
  level: (id: string) => number,
): GraphNode[] {
  const groups = new Map<number, string[]>();
  for (const step of steps) {
    const depth = level(step.role);
    const bucket = groups.get(depth);
    if (bucket === undefined) {
      groups.set(depth, [step.role]);
    } else {
      bucket.push(step.role);
    }
  }
  const nodes: GraphNode[] = [];
  for (const [depth, ids] of groups) {
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    sorted.forEach((id, indexInDepth) => {
      nodes.push({
        id,
        x: MARGIN + depth * COL_W,
        y: MARGIN + indexInDepth * ROW_H,
      });
    });
  }
  return nodes;
}

/**
 * Emit one edge per `(stepRole, depRole)` pair where both endpoints are
 * present in `knownIds`. Unknown dep targets are silently dropped.
 */
function collectEdges(
  steps: ReadonlyArray<PipelineStep>,
  knownIds: Set<string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const step of steps) {
    const deps = step.deps ?? [];
    for (const dep of deps) {
      if (!knownIds.has(dep)) continue;
      edges.push({ fromId: dep, toId: step.role });
    }
  }
  return edges;
}

/**
 * Compute the bounding box from the positioned nodes. When `nodes` is empty,
 * both dimensions collapse to `MARGIN * 2` so the container still has a
 * non-zero size.
 */
function computeBounds(nodes: ReadonlyArray<GraphNode>): GraphBounds {
  if (nodes.length === 0) {
    return { w: MARGIN * 2, h: MARGIN * 2 };
  }
  let maxX = 0;
  let maxY = 0;
  for (const node of nodes) {
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  return {
    w: maxX + NODE_W + MARGIN,
    h: maxY + NODE_H + MARGIN,
  };
}

/**
 * Return `true` when the input contains an orchestrator root step — i.e. a
 * step with `kind === 'orchestrator'` that other nodes can hang off.
 */
function hasOrchestrator(steps: ReadonlyArray<PipelineStep>): boolean {
  return steps.some((step) => step.kind === 'orchestrator');
}

/**
 * Rewrite each non-orchestrator step that lacks `deps` (missing or empty)
 * so its sole dependency becomes the orchestrator root. Returns a fresh
 * array — the input is not mutated. Used only when the input contains a
 * synthetic orchestrator step; otherwise the caller passes the input
 * through untouched.
 */
function withOrchestratorEdges(
  steps: ReadonlyArray<PipelineStep>,
): PipelineStep[] {
  return steps.map((step) => {
    if (step.kind === 'orchestrator') return step;
    const deps = step.deps ?? [];
    if (deps.length > 0) return step;
    return { ...step, deps: [ORCHESTRATOR_ROLE_ID] };
  });
}

/**
 * Compute the absolute layout for a flat `PipelineStep[]`.
 *
 * Returns `{ nodes, edges, bounds }`:
 * - `nodes[i]` carries the step's `role` as its id and absolute `(x, y)`
 *   pixel coordinates for its top-left corner.
 * - `edges[j]` is one directed pair per known `(dep → dependent)` relation;
 *   edges to unknown ids are dropped.
 * - `bounds` sizes a container large enough to fit every node plus margin.
 *
 * When the input includes an orchestrator step, every rootless role step is
 * connected to it via an implicit edge (redesign-016 §2). This safety net
 * keeps the graph anchored even if upstream payloads omit the explicit
 * `deps: ['orchestrator']` wiring.
 */
export function layoutGraph(steps: ReadonlyArray<PipelineStep>): GraphLayout {
  const effectiveSteps = hasOrchestrator(steps) ? withOrchestratorEdges(steps) : steps;
  const stepsById = new Map<string, PipelineStep>();
  for (const step of effectiveSteps) stepsById.set(step.role, step);
  const level = buildLevelResolver(stepsById);
  const nodes = positionNodes(effectiveSteps, level);
  const knownIds = new Set(nodes.map((n) => n.id));
  const edges = collectEdges(effectiveSteps, knownIds);
  const bounds = computeBounds(nodes);
  return { nodes, edges, bounds };
}
