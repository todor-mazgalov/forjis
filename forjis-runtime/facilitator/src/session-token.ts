/**
 * Inspector session-token generation and validation for the facilitator.
 *
 * This module owns the per-session Inspector token lifecycle: random
 * generation, in-memory registration, validation, and revocation. Tokens are
 * 256-bit random values encoded as base64url. They are held in process memory
 * only — never persisted to disk, never written to logs, and never emitted
 * in error messages. Tokens die with the `forjis dev` process.
 *
 * The concrete {@link SessionTokenRegistry} class implements the structural
 * contract declared as `SessionTokenRegistryLike` in `@forjis/shared`, so
 * the web server's Inspector upgrade listener can consume it without
 * importing from this package.
 */

import { randomBytes } from 'node:crypto';

/**
 * Opaque descriptor recorded alongside each registered session token.
 *
 * Mirrors the structural `SessionMetadataLike` interface in `@forjis/shared`
 * so that callers may pass a concrete `SessionMetadata` where the web
 * package expects the structural shape.
 */
export interface SessionMetadata {
  /** Opaque label supplied by the caller (e.g. "forjis dev session"). */
  readonly label: string;
  /** ISO-8601 timestamp captured at registration time. */
  readonly createdAt: string;
}

/**
 * Thrown by {@link SessionTokenRegistry.register} when the supplied token is
 * already present in the registry.
 *
 * The token value is attached to the instance as a readonly field so a
 * caller that explicitly needs it (for debugging) can read it off `err.token`,
 * but the {@link Error.message} text deliberately omits the value to keep
 * tokens out of default `console.error(err)` output and stack-trace dumps.
 */
export class SessionTokenAlreadyRegisteredError extends Error {
  /**
   * The token value that was re-registered.
   *
   * Declared as a non-enumerable property via {@link Object.defineProperty}
   * in the constructor so Node's default `console.error(err)` and
   * `util.inspect(err)` formatters do NOT include the token value. Callers
   * that explicitly need the value can still read `err.token`.
   */
  public readonly token!: string;

  /**
   * Construct the error with a token-free message.
   *
   * @param token - Token value that collided. Captured on the instance as
   *   a non-enumerable field so it never appears in default error output.
   */
  constructor(token: string) {
    super('A session token with the supplied value is already registered.');
    this.name = 'SessionTokenAlreadyRegisteredError';
    Object.defineProperty(this, 'token', {
      value: token,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

/**
 * Generate a fresh session token.
 *
 * Produces 32 random bytes (256 bits of entropy) from `node:crypto` and
 * encodes them as base64url. The resulting string is 43 characters long
 * (no padding) and contains only characters from the base64url alphabet
 * (`A-Z`, `a-z`, `0-9`, `-`, `_`), making it safe to pass as a URL query
 * parameter without further encoding.
 *
 * @returns A 43-character base64url string suitable for use as a single
 *   session token.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * In-memory registry of active Inspector session tokens.
 *
 * Backed by a `Map<string, SessionMetadata>`. Tokens are never persisted,
 * never logged, and never emitted in error messages — a token only exists
 * for the lifetime of the `forjis dev` process that created it.
 *
 * All operations are synchronous and run in constant time with respect to
 * the registry size (JavaScript `Map` lookup / insert / delete).
 */
export class SessionTokenRegistry {
  /** Private backing store. Keyed by token, values are opaque metadata. */
  private readonly tokens = new Map<string, SessionMetadata>();

  /**
   * Register a new token with the supplied metadata.
   *
   * @param token - Token value to register. Treated opaquely; no format
   *   validation is performed.
   * @param metadata - Opaque descriptor stored verbatim and returned by
   *   {@link validate}.
   * @throws {SessionTokenAlreadyRegisteredError} When `token` is already
   *   registered. The thrown error's `message` does not contain the token
   *   value.
   */
  public register(token: string, metadata: SessionMetadata): void {
    if (this.tokens.has(token)) {
      throw new SessionTokenAlreadyRegisteredError(token);
    }
    this.tokens.set(token, metadata);
  }

  /**
   * Validate a token and return its metadata when recognised.
   *
   * Side-effect free: does not mutate the registry, does not emit logs,
   * does not bump any counter.
   *
   * @param token - Token value to look up.
   * @returns The metadata previously registered under `token`, or `null`
   *   when the token is not present.
   */
  public validate(token: string): SessionMetadata | null {
    return this.tokens.get(token) ?? null;
  }

  /**
   * Revoke a previously-registered token.
   *
   * @param token - Token value to remove.
   * @returns `true` when the token was present and has been removed;
   *   `false` when the token was not registered.
   */
  public revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  /**
   * Read-only diagnostic accessor for the current registered-token count.
   *
   * Exposed for dashboard / health-check surfaces. It never leaks individual
   * token values.
   *
   * @returns The number of tokens currently held by this registry.
   */
  public get size(): number {
    return this.tokens.size;
  }
}
