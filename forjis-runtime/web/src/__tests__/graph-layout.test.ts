/**
 * Unit tests for the pure layout helpers used by the pipeline graph view.
 *
 * Covers `layoutGraph` — the depth resolver, alphabetical y-ordering, edge
 * emission, cycle safety, and bounds calculation. (The former
 * `trailingRoleName` helper was removed by `fix-roles-display`; the graph
 * keys directly on `step.role` which now holds the bare role name.)
 *
 * Tests live in the @forjis/web workspace because that workspace already has
 * Jest + ts-jest wired up. The modules under test live in the sibling
 * `client/src/views/tasks/` tree; we import them via relative paths. The
 * imports are pure TypeScript (no Solid, no DOM, no fetch) so they execute
 * cleanly under Node + ts-jest with no environment shim.
 *
 * Requirements covered:
 *   redesign-007 / pipeline-graph-view spec — "Graph layout module" section
 */

import {
  layoutGraph,
  NODE_W,
  NODE_H,
  NODE_H_HALF,
  type GraphLayout,
} from '../../client/src/views/tasks/graph-layout.js';
import type { PipelineStep } from '@forjis/shared';

// ---------------------------------------------------------------------------
// Shared layout constants — re-derived from the design contract so the tests
// fail loudly if the source drifts. The values match design D-2 in the change.
// ---------------------------------------------------------------------------
const COL_W = 220;
const ROW_H = 105;
const MARGIN = 40;

/**
 * Build a minimal `PipelineStep` literal with `role` and optional `deps`.
 * The other required fields are filled with stable defaults so tests do not
 * have to repeat them.
 */
function step(role: string, deps?: string[]): PipelineStep {
  const base: PipelineStep = {
    org: 'test-org',
    team: 'test-team',
    role,
    agent: 'agent-' + role,
    status: 'planned',
    description: 'desc-' + role,
  };
  if (deps !== undefined) {
    base.deps = deps;
  }
  return base;
}

/**
 * Build the synthetic orchestrator step as emitted by the plan-writer. Used
 * by the orchestrator-root scenarios to exercise the implicit-edge path.
 */
function orchestratorStep(): PipelineStep {
  return {
    kind: 'orchestrator',
    role: 'orchestrator',
    agent: '',
    status: 'running',
    description: 'Pipeline orchestrator',
    deps: [],
  };
}

/**
 * Lookup helper: find a node by id or fail the assertion. Returns the node so
 * the caller can chain `.x` / `.y` reads without nullish hand-wringing.
 */
function nodeById(layout: GraphLayout, id: string): { id: string; x: number; y: number } {
  const found = layout.nodes.find((n) => n.id === id);
  if (found === undefined) {
    throw new Error('expected node with id "' + id + '" in layout, got: ' + JSON.stringify(layout.nodes));
  }
  return found;
}

// ---------------------------------------------------------------------------
// Constants exposed by the module
// ---------------------------------------------------------------------------
describe('graph-layout module constants', () => {
  test('NODE_W matches the design contract (200)', () => {
    expect(NODE_W).toBe(200);
  });
  test('NODE_H matches the design contract (70)', () => {
    expect(NODE_H).toBe(70);
  });
  test('NODE_H_HALF is exactly NODE_H / 2', () => {
    expect(NODE_H_HALF).toBe(35);
    expect(NODE_H_HALF).toBe(NODE_H / 2);
  });
});

// ---------------------------------------------------------------------------
// Layout correctness
// ---------------------------------------------------------------------------
describe('layoutGraph — layout correctness', () => {
  test('empty input returns empty nodes/edges and minimal bounds (MARGIN * 2)', () => {
    const out = layoutGraph([]);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.bounds).toEqual({ w: MARGIN * 2, h: MARGIN * 2 });
  });

  test('single root node sits at (MARGIN, MARGIN), depth 0', () => {
    const out = layoutGraph([step('a')]);
    expect(out.nodes).toHaveLength(1);
    const n = nodeById(out, 'a');
    expect(n.x).toBe(MARGIN);
    expect(n.y).toBe(MARGIN);
    expect(out.edges).toEqual([]);
  });

  test('linear chain A→B→C produces depths 0/1/2 and a single y-row per depth', () => {
    const out = layoutGraph([step('a'), step('b', ['a']), step('c', ['b'])]);
    const a = nodeById(out, 'a');
    const b = nodeById(out, 'b');
    const c = nodeById(out, 'c');
    expect(a.x).toBe(MARGIN);
    expect(b.x).toBe(MARGIN + COL_W);
    expect(c.x).toBe(MARGIN + COL_W * 2);
    // Each depth has exactly one node — every y is the first row.
    expect(a.y).toBe(MARGIN);
    expect(b.y).toBe(MARGIN);
    expect(c.y).toBe(MARGIN);
  });

  test('diamond A→{B,C}→D places D at depth 2 (longest path wins)', () => {
    const out = layoutGraph([
      step('a'),
      step('b', ['a']),
      step('c', ['a']),
      step('d', ['b', 'c']),
    ]);
    expect(nodeById(out, 'a').x).toBe(MARGIN);
    expect(nodeById(out, 'b').x).toBe(MARGIN + COL_W);
    expect(nodeById(out, 'c').x).toBe(MARGIN + COL_W);
    expect(nodeById(out, 'd').x).toBe(MARGIN + COL_W * 2);
  });

  test('two-step linear chain — exact node positions per spec scenario', () => {
    const out = layoutGraph([step('a'), step('b', ['a'])]);
    expect(nodeById(out, 'a')).toEqual({ id: 'a', x: MARGIN, y: MARGIN });
    expect(nodeById(out, 'b')).toEqual({ id: 'b', x: MARGIN + COL_W, y: MARGIN });
  });

  test('multiple roots with no deps land in one column, sorted alphabetically by role', () => {
    // Insertion order is c, a, b — alphabetical sort must reorder y to a, b, c.
    const out = layoutGraph([step('c'), step('a'), step('b')]);
    expect(out.nodes).toHaveLength(3);
    const a = nodeById(out, 'a');
    const b = nodeById(out, 'b');
    const c = nodeById(out, 'c');
    expect(a.x).toBe(MARGIN);
    expect(b.x).toBe(MARGIN);
    expect(c.x).toBe(MARGIN);
    expect(a.y).toBe(MARGIN + 0 * ROW_H);
    expect(b.y).toBe(MARGIN + 1 * ROW_H);
    expect(c.y).toBe(MARGIN + 2 * ROW_H);
    expect(out.edges).toEqual([]);
  });

  test('siblings at the same depth take distinct y values, alphabetically ordered by role', () => {
    // Insertion order intentionally non-alphabetical: z, m, a all depend on root.
    const out = layoutGraph([step('root'), step('z', ['root']), step('m', ['root']), step('a', ['root'])]);
    const a = nodeById(out, 'a');
    const m = nodeById(out, 'm');
    const z = nodeById(out, 'z');
    expect(a.x).toBe(MARGIN + COL_W);
    expect(m.x).toBe(MARGIN + COL_W);
    expect(z.x).toBe(MARGIN + COL_W);
    // Alphabetical y-ordering within depth 1: a (0), m (1), z (2).
    expect(a.y).toBe(MARGIN + 0 * ROW_H);
    expect(m.y).toBe(MARGIN + 1 * ROW_H);
    expect(z.y).toBe(MARGIN + 2 * ROW_H);
    // The y values are pairwise distinct.
    const ys = [a.y, m.y, z.y].sort((x, y) => x - y);
    expect(new Set(ys).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------
describe('layoutGraph — edges', () => {
  test('every step.deps[i] produces one edge with the correct direction (dep → dependent)', () => {
    const out = layoutGraph([step('a'), step('b', ['a'])]);
    expect(out.edges).toEqual([{ fromId: 'a', toId: 'b' }]);
  });

  test('edge count equals the sum of all known deps lengths', () => {
    const out = layoutGraph([
      step('a'),
      step('b', ['a']),
      step('c', ['a', 'b']),
      step('d', ['b', 'c']),
    ]);
    // Total = 0 + 1 + 2 + 2 = 5
    expect(out.edges).toHaveLength(5);
    // And every (from, to) pair shows up exactly once.
    const asSet = new Set(out.edges.map((e) => e.fromId + '->' + e.toId));
    expect(asSet).toEqual(
      new Set(['a->b', 'a->c', 'b->c', 'b->d', 'c->d']),
    );
  });

  test('unknown dep targets are silently dropped (no edge, no throw)', () => {
    const out = layoutGraph([step('a', ['ghost'])]);
    expect(out.nodes).toHaveLength(1);
    expect(out.edges).toEqual([]);
  });

  test('mix of known and unknown deps emits only the known edges', () => {
    const out = layoutGraph([step('a'), step('b', ['a', 'ghost', 'phantom'])]);
    expect(out.edges).toEqual([{ fromId: 'a', toId: 'b' }]);
  });

  test('spec scenario — `b` with deps:[a] and `c` with deps:[a,b] yields three edges', () => {
    const out = layoutGraph([step('a'), step('b', ['a']), step('c', ['a', 'b'])]);
    expect(out.edges).toHaveLength(3);
    const asSet = new Set(out.edges.map((e) => e.fromId + '->' + e.toId));
    expect(asSet).toEqual(new Set(['a->b', 'a->c', 'b->c']));
  });
});

// ---------------------------------------------------------------------------
// Cycle safety
// ---------------------------------------------------------------------------
describe('layoutGraph — cycle safety', () => {
  test('A→B→A does not throw and emits both edges', () => {
    let layout: GraphLayout | undefined;
    expect(() => {
      layout = layoutGraph([step('a', ['b']), step('b', ['a'])]);
    }).not.toThrow();
    expect(layout).toBeDefined();
    const out = layout as GraphLayout;
    expect(out.nodes).toHaveLength(2);
    // Per spec scenario "Cycle does not crash", both nodes settle at depth 0.
    expect(nodeById(out, 'a').x).toBe(MARGIN);
    expect(nodeById(out, 'b').x).toBe(MARGIN);
    // Both directional edges are still emitted.
    const asSet = new Set(out.edges.map((e) => e.fromId + '->' + e.toId));
    expect(asSet).toEqual(new Set(['a->b', 'b->a']));
  });

  test('self-loop (A depends on A) does not throw and emits a self-edge', () => {
    let layout: GraphLayout | undefined;
    expect(() => {
      layout = layoutGraph([step('a', ['a'])]);
    }).not.toThrow();
    const out = layout as GraphLayout;
    expect(out.nodes).toHaveLength(1);
    expect(out.edges).toEqual([{ fromId: 'a', toId: 'a' }]);
  });

  test('three-node cycle A→B→C→A does not throw', () => {
    expect(() => {
      layoutGraph([step('a', ['c']), step('b', ['a']), step('c', ['b'])]);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Missing / empty deps
// ---------------------------------------------------------------------------
describe('layoutGraph — missing and empty deps', () => {
  test('undefined deps is treated as []; node is a root at depth 0', () => {
    const s: PipelineStep = {
      role: 'a',
      agent: 'agent-a',
      status: 'planned',
      description: 'd',
    };
    // Note: no `deps` field at all.
    const out = layoutGraph([s]);
    expect(nodeById(out, 'a').x).toBe(MARGIN);
    expect(out.edges).toEqual([]);
  });

  test('explicit empty deps array is treated as root depth 0', () => {
    const out = layoutGraph([step('a', [])]);
    expect(nodeById(out, 'a').x).toBe(MARGIN);
    expect(out.edges).toEqual([]);
  });

  test('all-empty deps places every node at depth 0, alphabetically by role', () => {
    const out = layoutGraph([step('c'), step('b'), step('a')]);
    expect(nodeById(out, 'a').x).toBe(MARGIN);
    expect(nodeById(out, 'b').x).toBe(MARGIN);
    expect(nodeById(out, 'c').x).toBe(MARGIN);
    expect(nodeById(out, 'a').y).toBe(MARGIN + 0 * ROW_H);
    expect(nodeById(out, 'b').y).toBe(MARGIN + 1 * ROW_H);
    expect(nodeById(out, 'c').y).toBe(MARGIN + 2 * ROW_H);
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
describe('layoutGraph — bounds', () => {
  test('bounds account for the deepest column (max x + NODE_W + MARGIN)', () => {
    const out = layoutGraph([step('a'), step('b', ['a']), step('c', ['b'])]);
    // Deepest x = MARGIN + 2 * COL_W; therefore bounds.w = that + NODE_W + MARGIN.
    expect(out.bounds.w).toBe(MARGIN + 2 * COL_W + NODE_W + MARGIN);
  });

  test('bounds account for the tallest column (max y + NODE_H + MARGIN)', () => {
    // Three nodes in depth 0, alphabetically a/b/c; max y = MARGIN + 2 * ROW_H.
    const out = layoutGraph([step('a'), step('b'), step('c')]);
    expect(out.bounds.h).toBe(MARGIN + 2 * ROW_H + NODE_H + MARGIN);
  });

  test('single root collapses bounds to (MARGIN + NODE_W + MARGIN, MARGIN + NODE_H + MARGIN)', () => {
    const out = layoutGraph([step('a')]);
    expect(out.bounds.w).toBe(MARGIN + NODE_W + MARGIN);
    expect(out.bounds.h).toBe(MARGIN + NODE_H + MARGIN);
  });

  test('empty input collapses bounds to MARGIN*2 in both dimensions', () => {
    const out = layoutGraph([]);
    expect(out.bounds).toEqual({ w: MARGIN * 2, h: MARGIN * 2 });
  });

  test('bounds.w uses the maximum x across all nodes, not just the deepest depth count', () => {
    // Diamond gives depths 0,1,1,2. max x is at depth 2.
    const out = layoutGraph([
      step('a'),
      step('b', ['a']),
      step('c', ['a']),
      step('d', ['b', 'c']),
    ]);
    const maxX = Math.max(...out.nodes.map((n) => n.x));
    expect(out.bounds.w).toBe(maxX + NODE_W + MARGIN);
  });

  test('bounds.h uses the maximum y across all nodes, not just the heaviest depth', () => {
    // Depth 0: just 'root'. Depth 1: a, b, c, d, e (5 nodes alphabetically).
    const out = layoutGraph([
      step('root'),
      step('a', ['root']),
      step('b', ['root']),
      step('c', ['root']),
      step('d', ['root']),
      step('e', ['root']),
    ]);
    const maxY = Math.max(...out.nodes.map((n) => n.y));
    expect(out.bounds.h).toBe(maxY + NODE_H + MARGIN);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe('layoutGraph — determinism', () => {
  test('same input → identical output across repeated calls', () => {
    const input = [step('c'), step('a', ['root']), step('b', ['root']), step('root')];
    const a = layoutGraph(input);
    const b = layoutGraph(input);
    expect(a).toEqual(b);
  });

  test('input order does not affect node positions (only role-name sort within depth)', () => {
    const input1 = [step('a'), step('b', ['a']), step('c', ['a'])];
    const input2 = [step('c', ['a']), step('b', ['a']), step('a')];
    const out1 = layoutGraph(input1);
    const out2 = layoutGraph(input2);
    // Same set of (id, x, y) — order in the .nodes array may differ but the
    // node-by-id positions must match.
    for (const id of ['a', 'b', 'c']) {
      const n1 = nodeById(out1, id);
      const n2 = nodeById(out2, id);
      expect(n1).toEqual(n2);
    }
  });
});

// ---------------------------------------------------------------------------
// Orchestrator root — redesign-016 §2
// ---------------------------------------------------------------------------
describe('layoutGraph — orchestrator root', () => {
  test('orchestrator step sits at depth 0 with no incoming edges', () => {
    const out = layoutGraph([orchestratorStep(), step('Explorer'), step('Developer')]);
    const orchestrator = nodeById(out, 'orchestrator');
    expect(orchestrator.x).toBe(MARGIN);
    const incoming = out.edges.filter((e) => e.toId === 'orchestrator');
    expect(incoming).toEqual([]);
  });

  test('every role without deps receives an implicit orchestrator edge', () => {
    const out = layoutGraph([orchestratorStep(), step('Explorer'), step('Developer')]);
    const asSet = new Set(out.edges.map((e) => e.fromId + '->' + e.toId));
    expect(asSet.has('orchestrator->Explorer')).toBe(true);
    expect(asSet.has('orchestrator->Developer')).toBe(true);
  });

  test('roles with explicit deps keep their declared chain and do not gain an orchestrator edge', () => {
    const out = layoutGraph([
      orchestratorStep(),
      step('Explorer'),
      step('Developer', ['Explorer']),
    ]);
    const asSet = new Set(out.edges.map((e) => e.fromId + '->' + e.toId));
    // Explorer has no deps → implicit edge from orchestrator.
    expect(asSet.has('orchestrator->Explorer')).toBe(true);
    // Developer has explicit deps:[Explorer] → no implicit orchestrator edge.
    expect(asSet.has('orchestrator->Developer')).toBe(false);
    expect(asSet.has('Explorer->Developer')).toBe(true);
  });

  test('roles with empty deps array still gain an implicit orchestrator edge', () => {
    const out = layoutGraph([orchestratorStep(), step('Explorer', [])]);
    const asSet = new Set(out.edges.map((e) => e.fromId + '->' + e.toId));
    expect(asSet.has('orchestrator->Explorer')).toBe(true);
  });

  test('implicit-edge rule does not fire when there is no orchestrator in the input', () => {
    // No orchestrator; Explorer has no deps. Original rootless behaviour wins.
    const out = layoutGraph([step('Explorer'), step('Developer', ['Explorer'])]);
    expect(out.edges).toEqual([{ fromId: 'Explorer', toId: 'Developer' }]);
  });

  test('orchestrator-rooted chain produces depths 0/1/2 when the middle step already depends on the root', () => {
    const out = layoutGraph([
      orchestratorStep(),
      step('Explorer', ['orchestrator']),
      step('Developer', ['Explorer']),
    ]);
    expect(nodeById(out, 'orchestrator').x).toBe(MARGIN);
    expect(nodeById(out, 'Explorer').x).toBe(MARGIN + COL_W);
    expect(nodeById(out, 'Developer').x).toBe(MARGIN + COL_W * 2);
  });
});

