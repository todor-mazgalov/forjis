/**
 * PipelineSelectionContext — shared `selectedStepIdentity` signal for the
 * middle (pipeline) and right (detail) columns of the Tasks view. See
 * design.md decision D-3 (redesign-006) and `fix-roles-display` for the
 * switch from the composite string id to the structured `{org, team, role}`
 * triple that now uniquely identifies a pipeline step.
 *
 * The provider owns a `createSignal<RoleIdentity | null>(null)` and runs an
 * internal `createEffect` that resets the signal to `null` whenever the
 * parent's `selectedTaskId` accessor changes. That keeps stale step
 * selections from bleeding across task switches without forcing `TasksView`
 * to wire the plumbing itself. The consumer hook throws when called outside
 * the provider, matching the existing `useView()` convention from
 * redesign-004.
 *
 * Identity equality is structural (`stepIdentitiesEqual`) so the lookup rule
 * — "selection matches this step iff all three fields match exactly" — is
 * documented in one place and reused by every consumer that used to do
 * `selection.selectedStepId() === step.role`.
 */

import type { Accessor, Component, ParentProps } from 'solid-js';
import { createContext, createEffect, createSignal, useContext } from 'solid-js';
import type { RoleIdentity } from '@forjis/shared';

/**
 * Compare two role identities for structural equality. `null` values match
 * only each other. Exported so consumers can use the same rule that drives
 * the selection-highlight logic.
 */
export function stepIdentitiesEqual(
  a: RoleIdentity | null,
  b: RoleIdentity | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.org === b.org && a.team === b.team && a.role === b.role;
}

/** Shape exposed to consumers via {@link usePipelineSelection}. */
export interface PipelineSelectionValue {
  /** Currently selected step identity triple, or null when no step is selected. */
  selectedStepIdentity: Accessor<RoleIdentity | null>;
  /** Update the selected step identity. Pass `null` to clear the selection. */
  setSelectedStepIdentity: (identity: RoleIdentity | null) => void;
}

/** Props for {@link PipelineSelectionProvider}. */
export interface PipelineSelectionProviderProps extends ParentProps {
  /**
   * Parent's currently-selected task id. Watched internally; any change resets
   * `selectedStepIdentity` to `null` so the pipeline never shows a stale
   * selection after the user picks a different task.
   */
  selectedTaskId: Accessor<string | null>;
}

/**
 * Raw context. Default is `undefined` so `usePipelineSelection` can detect a
 * missing provider and throw instead of silently returning a stub.
 */
const PipelineSelectionContextRef = createContext<PipelineSelectionValue | undefined>(undefined);

/**
 * Provider that owns the `selectedStepIdentity` signal for the pipeline and
 * detail columns. Mount inside `TasksView` so both siblings can read and
 * write the same value.
 */
export const PipelineSelectionProvider: Component<PipelineSelectionProviderProps> = (props) => {
  const [selectedStepIdentity, setSelectedStepIdentity] =
    createSignal<RoleIdentity | null>(null);

  // Reset the selection whenever the parent's selectedTaskId changes. Read
  // the accessor inside the effect so the reactive dependency is explicit.
  createEffect(() => {
    props.selectedTaskId();
    setSelectedStepIdentity(null);
  });

  const value: PipelineSelectionValue = {
    selectedStepIdentity,
    setSelectedStepIdentity,
  };
  return (
    <PipelineSelectionContextRef.Provider value={value}>
      {props.children}
    </PipelineSelectionContextRef.Provider>
  );
};

/**
 * Consumer hook. Returns the current {@link PipelineSelectionValue}; throws
 * when called outside a {@link PipelineSelectionProvider}.
 */
export function usePipelineSelection(): PipelineSelectionValue {
  const value = useContext(PipelineSelectionContextRef);
  if (value === undefined) {
    throw new Error('usePipelineSelection() must be called inside a <PipelineSelectionProvider>');
  }
  return value;
}
