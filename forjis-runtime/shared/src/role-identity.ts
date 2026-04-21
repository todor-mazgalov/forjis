/**
 * Canonical role identity module.
 *
 * Centralises the shape and formatting of the `{org, team, role}` triple that
 * identifies a runtime role across the whole pipeline. Replaces the free-form
 * `step.role` composite strings that used to drift between orchestrator prompts,
 * plan YAML, and event log filenames.
 *
 * Three distinct concerns live here:
 *  - `canonicalSlug` — deterministic filesystem slug for event filenames.
 *  - `formatRoleDisplay` / `parseRoleDisplay` — `<role> @ <team>` UI string.
 *  - `validateRoleIdentityShape` — strict rejection of reserved characters
 *    (`:`, `@`, `\n`, `\t`) and empty fields, with a typed error class.
 */

/** The structured identity of a pipeline role. */
export interface RoleIdentity {
  /** Organisation name (non-empty, no reserved chars). */
  org: string;
  /** Team name (non-empty, no reserved chars). */
  team: string;
  /** Role name (non-empty, no reserved chars). */
  role: string;
}

/** Machine-readable reason a RoleIdentityError was raised. */
export type RoleIdentityErrorCode = 'RESERVED_CHAR' | 'EMPTY' | 'UNKNOWN';

/**
 * Error thrown when a `{org, team, role}` triple fails shape validation.
 *
 * Carries a `code` field so callers can branch on the specific failure mode
 * without parsing the human-readable message.
 */
export class RoleIdentityError extends Error {
  /** Machine-readable error category. */
  public readonly code: RoleIdentityErrorCode;

  /**
   * Constructs a new RoleIdentityError.
   *
   * @param message - Human-readable description pointing at the offending name.
   * @param code - Machine-readable error category.
   */
  constructor(message: string, code: RoleIdentityErrorCode) {
    super(message);
    this.name = 'RoleIdentityError';
    this.code = code;
  }
}

/** Characters that may never appear in an identity field. */
const RESERVED_CHAR_PATTERN = /[:@\n\t]/;

/** Separator used by `formatRoleDisplay` / `parseRoleDisplay`. */
const DISPLAY_SEPARATOR = ' @ ';

/**
 * Converts a `{org, team, role}` triple into a lowercased, kebab-case slug
 * suitable for a filesystem path segment.
 *
 * Concatenates the three fields with a single `-`, lowercases the result,
 * replaces every run of non-alphanumeric characters with a single `-`, and
 * strips leading / trailing `-`. Used only for filenames — never for equality
 * or map keys.
 *
 * @param identity - The role identity triple.
 * @returns A kebab-case slug (e.g. `"acme-co-frontend-architect-frontend"`).
 */
export function canonicalSlug(identity: RoleIdentity): string {
  const combined = `${identity.org}-${identity.team}-${identity.role}`.toLowerCase();
  return combined.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Formats a role identity as a one-line human-readable label.
 *
 * Returns `"<role> @ <team>"` — the single separator used by every
 * user-visible surface (role cards, detail pane, tooltips). Not used for
 * keys, paths, or equality comparisons.
 *
 * @param identity - Object containing at least `role` and `team` fields.
 * @returns Display string with a single space on each side of `@`.
 */
export function formatRoleDisplay(identity: { role: string; team: string }): string {
  return `${identity.role}${DISPLAY_SEPARATOR}${identity.team}`;
}

/**
 * Parses a `<role> @ <team>` display string back into its components.
 *
 * Splits on the literal ` @ ` separator. Returns `null` when the input does
 * not contain exactly one separator — callers treat that as "not a display
 * string" rather than as an error.
 *
 * @param str - Candidate display string.
 * @returns `{role, team}` when parseable, otherwise `null`.
 */
export function parseRoleDisplay(str: string): { role: string; team: string } | null {
  const idx = str.indexOf(DISPLAY_SEPARATOR);
  if (idx === -1) {
    return null;
  }
  const role = str.substring(0, idx);
  const team = str.substring(idx + DISPLAY_SEPARATOR.length);
  if (role.length === 0 || team.length === 0) {
    return null;
  }
  // Reject multiple separators defensively: the team half must not contain another ` @ `.
  if (team.indexOf(DISPLAY_SEPARATOR) !== -1) {
    return null;
  }
  return { role, team };
}

/**
 * Validates the shape of a `{org, team, role}` triple.
 *
 * Throws `RoleIdentityError` when any field is empty or contains a reserved
 * character (`:`, `@`, `\n`, `\t`). Called from the resolver for every
 * source-config name and from the plan parser for every step, so reserved
 * characters can never leak into runtime config or pipeline plans.
 *
 * @param identity - The triple to validate.
 * @throws {RoleIdentityError} With `code: 'EMPTY'` or `'RESERVED_CHAR'`.
 */
export function validateRoleIdentityShape(identity: RoleIdentity): void {
  const fields: Array<keyof RoleIdentity> = ['org', 'team', 'role'];
  for (const field of fields) {
    const value = identity[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new RoleIdentityError(
        `Role identity field "${field}" must be a non-empty string`,
        'EMPTY',
      );
    }
    if (RESERVED_CHAR_PATTERN.test(value)) {
      throw new RoleIdentityError(
        `Role identity field "${field}"="${value}" contains a reserved character (":", "@", newline, or tab)`,
        'RESERVED_CHAR',
      );
    }
  }
}
