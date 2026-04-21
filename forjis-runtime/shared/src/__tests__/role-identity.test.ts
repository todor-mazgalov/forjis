/**
 * Unit tests for role-identity.ts.
 *
 * Covers every branch of `canonicalSlug`, `formatRoleDisplay`,
 * `parseRoleDisplay`, and `validateRoleIdentityShape` — including the
 * reserved-character rejection and empty-field rejection paths that the
 * plan parser depends on.
 *
 * Shared tests don't have a jest runner in this workspace; this file also
 * runs under the facilitator's jest config via explicit inclusion when
 * needed. It uses the same describe / it / expect globals provided by jest.
 */

import {
  RoleIdentityError,
  canonicalSlug,
  formatRoleDisplay,
  parseRoleDisplay,
  validateRoleIdentityShape,
} from '../role-identity.js';

describe('canonicalSlug', () => {
  it('returns lowercased kebab-case for the documented example', () => {
    expect(
      canonicalSlug({ org: 'Acme Co', team: 'Frontend', role: 'Architect (Frontend)' }),
    ).toBe('acme-co-frontend-architect-frontend');
  });

  it('collapses runs of non-alphanumeric characters to a single hyphen', () => {
    expect(
      canonicalSlug({ org: 'Org   With   Spaces', team: 'T__E__A__M', role: 'role!!name' }),
    ).toBe('org-with-spaces-t-e-a-m-role-name');
  });

  it('strips leading and trailing hyphens', () => {
    expect(
      canonicalSlug({ org: '-Org-', team: ' Team ', role: '***role***' }),
    ).toBe('org-team-role');
  });

  it('lowercases mixed case', () => {
    expect(canonicalSlug({ org: 'ORG', team: 'Team', role: 'ROLE' })).toBe('org-team-role');
  });
});

describe('formatRoleDisplay', () => {
  it('returns "<role> @ <team>" with exactly one space on each side of @', () => {
    expect(formatRoleDisplay({ role: 'Architect', team: 'Frontend' })).toBe(
      'Architect @ Frontend',
    );
  });

  it('preserves whitespace and case in role and team names', () => {
    expect(formatRoleDisplay({ role: 'Backend Dev', team: 'Core Team' })).toBe(
      'Backend Dev @ Core Team',
    );
  });
});

describe('parseRoleDisplay', () => {
  it('round-trips with formatRoleDisplay', () => {
    const formatted = formatRoleDisplay({ role: 'Reviewer', team: 'QA' });
    expect(parseRoleDisplay(formatted)).toEqual({ role: 'Reviewer', team: 'QA' });
  });

  it('returns null for a string without the " @ " separator', () => {
    expect(parseRoleDisplay('Reviewer')).toBeNull();
    expect(parseRoleDisplay('Reviewer@QA')).toBeNull();
    expect(parseRoleDisplay('Reviewer@ QA')).toBeNull();
  });

  it('returns null for empty role or team halves', () => {
    expect(parseRoleDisplay(' @ QA')).toBeNull();
    expect(parseRoleDisplay('Reviewer @ ')).toBeNull();
  });

  it('returns null when the separator appears more than once', () => {
    expect(parseRoleDisplay('A @ B @ C')).toBeNull();
  });
});

describe('validateRoleIdentityShape', () => {
  it('accepts names with spaces and mixed case', () => {
    expect(() =>
      validateRoleIdentityShape({ org: 'Acme Co', team: 'Frontend', role: 'Architect (Frontend)' }),
    ).not.toThrow();
  });

  it('throws with code "RESERVED_CHAR" on colon', () => {
    try {
      validateRoleIdentityShape({ org: 'acme', team: 'frontend', role: 'plugin:role' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoleIdentityError);
      expect((err as RoleIdentityError).code).toBe('RESERVED_CHAR');
    }
  });

  it('throws with code "RESERVED_CHAR" on @ sign', () => {
    try {
      validateRoleIdentityShape({ org: 'acme', team: 'frontend', role: 'role@team' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoleIdentityError);
      expect((err as RoleIdentityError).code).toBe('RESERVED_CHAR');
    }
  });

  it('throws with code "RESERVED_CHAR" on newline or tab', () => {
    for (const bad of ['line\nbreak', 'tab\there']) {
      try {
        validateRoleIdentityShape({ org: 'acme', team: 'frontend', role: bad });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RoleIdentityError);
        expect((err as RoleIdentityError).code).toBe('RESERVED_CHAR');
      }
    }
  });

  it('throws with code "EMPTY" on empty strings', () => {
    try {
      validateRoleIdentityShape({ org: '', team: 'frontend', role: 'architect' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoleIdentityError);
      expect((err as RoleIdentityError).code).toBe('EMPTY');
    }
  });

  it('points at the offending field name in the error message', () => {
    try {
      validateRoleIdentityShape({ org: 'acme', team: 'bad:team', role: 'architect' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoleIdentityError);
      expect((err as RoleIdentityError).message).toContain('team');
    }
  });
});
