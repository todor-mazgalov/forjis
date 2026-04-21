/**
 * Unit tests for the `RoleLabel` component's rendering contract (fix-roles-display).
 *
 * The component itself is JSX — not executable under this workspace's
 * ts-jest pipeline (no Vite / SolidJS build step here) — so the test
 * targets the exported pure helper `roleLabelFragments` that captures the
 * exact text-fragment structure the component renders.
 *
 * The contract under test:
 *   - `<span class={styles.roleName}>{roleText}</span>` in the default foreground.
 *   - `<span class={styles.roleTeam}>{separator}{teamText}</span>` in the muted
 *     foreground, where `separator === ' @ '` (one space on each side of `@`).
 *
 * These two spans together render as `"<role> @ <team>"`. The same string is
 * produced by `formatRoleDisplay` in `@forjis/shared`, so the
 * component output stays in lockstep with the formatter used on every
 * non-component surface (progress-chain tooltip, events filenames, etc.).
 */

import {
  ROLE_LABEL_SEPARATOR,
  roleLabelFragments,
} from '../../client/src/views/tasks/role-label-fragments.js';
import { formatRoleDisplay } from '../../../shared/src/role-identity.js';

describe('RoleLabel — two-span render contract (fix-roles-display)', () => {
  test('exposes the ` @ ` separator as a public constant', () => {
    // Exactly one space on each side of `@`. Any drift here would break the
    // formatter's round-trip with `parseRoleDisplay`.
    expect(ROLE_LABEL_SEPARATOR).toBe(' @ ');
  });

  test('returns role name, separator, and team name as three distinct fragments', () => {
    const fragments = roleLabelFragments('Architect', 'Frontend');
    expect(fragments).toEqual({
      roleText: 'Architect',
      separator: ' @ ',
      teamText: 'Frontend',
    });
  });

  test('the muted-foreground span (separator + team) starts with the literal ` @ ` prefix', () => {
    // The component renders the separator and team together in one muted
    // span; this assertion pins that the separator is in the muted span,
    // never in the role-name span.
    const fragments = roleLabelFragments('Architect', 'Frontend');
    const mutedText = `${fragments.separator}${fragments.teamText}`;
    expect(mutedText.startsWith(' @ ')).toBe(true);
    expect(mutedText).toBe(' @ Frontend');
  });

  test('concatenating all three fragments equals formatRoleDisplay output', () => {
    const role = 'Architect';
    const team = 'Frontend';
    const fragments = roleLabelFragments(role, team);
    const concat = `${fragments.roleText}${fragments.separator}${fragments.teamText}`;
    expect(concat).toBe(formatRoleDisplay({ role, team }));
  });

  test('preserves whitespace and case in role/team names verbatim', () => {
    const fragments = roleLabelFragments('Architect (Frontend)', 'Design Team');
    expect(fragments.roleText).toBe('Architect (Frontend)');
    expect(fragments.teamText).toBe('Design Team');
    expect(fragments.separator).toBe(' @ ');
  });

  test('empty role and empty team still produce the exact three-fragment shape', () => {
    // Empty strings would fail `validateRoleIdentityShape`, but the display
    // helper itself is pure and must not throw — it just echoes the inputs.
    const fragments = roleLabelFragments('', '');
    expect(fragments.roleText).toBe('');
    expect(fragments.teamText).toBe('');
    expect(fragments.separator).toBe(' @ ');
  });
});
