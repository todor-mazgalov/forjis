/**
 * RoleLabel — two-tone inline label for `<role> @ <team>`.
 *
 * Single place in the client that renders a role identity. Splits the bare
 * role name and the ` @ <team>` suffix into two adjacent inline spans so the
 * role reads in the default foreground while the team qualifier reads in the
 * muted foreground — the label flows as one visual line.
 *
 * The only separator is the literal ` @ ` string (one space on each side of
 * the `@`), matching `formatRoleDisplay` from `@forjis/shared`. Never used
 * for keys, paths, or equality.
 *
 * Accepts either `{role, team}` props directly or a full `PipelineStep` via
 * the discriminated `step` prop so call sites that already have a step object
 * can pass it through without pulling the fields out. Both prop shapes
 * resolve to the same two-span render.
 *
 * The pure text-fragment helper (`roleLabelFragments` / `ROLE_LABEL_SEPARATOR`)
 * lives in the sibling `role-label-fragments.ts` module so the render
 * contract is unit-testable under plain ts-jest without the Vite / SolidJS /
 * CSS-module toolchain. Re-exported from here for consumer convenience.
 */

import type { Component } from 'solid-js';
import type { PipelineStep } from '@forjis/shared';
import {
  ROLE_LABEL_SEPARATOR,
  roleLabelFragments,
  type RoleLabelFragments,
} from './role-label-fragments';
import styles from './RoleLabel.module.css';

export { ROLE_LABEL_SEPARATOR, roleLabelFragments };
export type { RoleLabelFragments };

/** Props for {@link RoleLabel}. Either pass `{role, team}` explicitly or a
 *  full {@link PipelineStep} via `step` — both shapes render the same two
 *  spans. When `step` is provided, the explicit role/team props are ignored. */
export type RoleLabelProps =
  | { role: string; team: string; step?: undefined }
  | { step: Pick<PipelineStep, 'role' | 'team'>; role?: undefined; team?: undefined };

/**
 * Two-tone inline label. See file header for the full contract.
 */
export const RoleLabel: Component<RoleLabelProps> = (props) => {
  const role = (): string =>
    props.step !== undefined ? props.step.role : (props as { role: string }).role;
  const team = (): string =>
    props.step !== undefined ? props.step.team : (props as { team: string }).team;

  return (
    <>
      <span class={styles.roleName}>{role()}</span>
      <span class={styles.roleTeam}>{ROLE_LABEL_SEPARATOR}{team()}</span>
    </>
  );
};
