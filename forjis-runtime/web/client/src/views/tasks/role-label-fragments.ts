/**
 * role-label-fragments — Pure text-fragment helper for the RoleLabel component.
 *
 * Split out of `RoleLabel.tsx` so the data form of the two-span render
 * (`{roleText, separator, teamText}`) can be unit-tested under plain
 * ts-jest without the Vite / SolidJS / CSS-module toolchain the component
 * module requires. The live `RoleLabel` re-exports these symbols.
 *
 * Contract:
 *   <span class={styles.roleName}>{roleText}</span>
 *   <span class={styles.roleTeam}>{separator}{teamText}</span>
 *
 * The team span carries both the separator and the team name so they share
 * the muted foreground. `separator` is always the literal ` @ ` string —
 * one space on each side of `@`. The same separator is emitted by
 * `formatRoleDisplay` / consumed by `parseRoleDisplay` in `@forjis/shared`,
 * so the component output stays lockstep with the formatter used on every
 * non-component surface.
 */

/** Literal separator between the role name and the team qualifier. */
export const ROLE_LABEL_SEPARATOR = ' @ ';

/**
 * Data form of the two-span render pattern. Exported so unit tests can
 * assert the structure (role name in default foreground, ` @ <team>` in
 * muted foreground) without needing a DOM or a SolidJS runtime.
 */
export interface RoleLabelFragments {
  /** Text for the default-foreground span. */
  roleText: string;
  /** Literal separator string that prefixes the team span. Always ` @ `. */
  separator: string;
  /** Text for the muted-foreground span (the team name). */
  teamText: string;
}

/**
 * Return the three text fragments that make up a role label. Pure — the
 * live component renders:
 *
 *   <span class={styles.roleName}>{roleText}</span>
 *   <span class={styles.roleTeam}>{separator}{teamText}</span>
 */
export function roleLabelFragments(role: string, team: string): RoleLabelFragments {
  return {
    roleText: role,
    separator: ROLE_LABEL_SEPARATOR,
    teamText: team,
  };
}
