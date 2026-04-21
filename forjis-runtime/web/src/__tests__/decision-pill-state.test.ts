/**
 * Unit tests for the `decision-pill-state` helpers backing
 * `forjis-runtime/web/client/src/views/tasks/DecisionPill.tsx`.
 *
 * The component module itself imports a `.module.css` file which ts-jest
 * cannot load without a Vite toolchain, so the pure enum / label / state-list
 * logic has been split into a sibling `.ts` module — this spec exercises
 * that module. Covers redesign-017 § 1 (DecisionPill component).
 *
 * Requirements covered:
 *   redesign-017 — "DecisionPill encodes three states with distinct visuals"
 *   (label text follows the uppercase rule; the three-state enum stays
 *   closed and sorted).
 */

import {
  DECISION_PILL_STATES,
  decisionLabel,
  type DecisionPillState,
} from '../../client/src/views/tasks/decision-pill-state.js';

describe('decisionLabel', () => {
  test('upper-cases the `started` state', () => {
    expect(decisionLabel('started')).toBe('STARTED');
  });

  test('upper-cases the `skipped` state', () => {
    expect(decisionLabel('skipped')).toBe('SKIPPED');
  });

  test('upper-cases the `pending` state', () => {
    expect(decisionLabel('pending')).toBe('PENDING');
  });
});

describe('DECISION_PILL_STATES', () => {
  test('exposes exactly the three supported states in declaration order', () => {
    expect(DECISION_PILL_STATES).toEqual(['started', 'skipped', 'pending']);
  });

  test('every state round-trips through `decisionLabel` without losing information', () => {
    for (const state of DECISION_PILL_STATES) {
      const label: string = decisionLabel(state);
      expect(label).toBe(state.toUpperCase());
      // Lowercasing the label MUST reproduce the original state string — the
      // pill renders the upper-cased form only; no transformation beyond case.
      const roundTripped = label.toLowerCase() as DecisionPillState;
      expect(roundTripped).toBe(state);
    }
  });
});
